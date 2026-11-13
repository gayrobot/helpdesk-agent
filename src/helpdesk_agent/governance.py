"""The governance gate: the only path from a model's tool call to a tool.

Order of checks for every call, each audited:

1. Allowlist: unknown tool names are rejected.
2. Input validation: exact schema match (required keys, string types, length, no extras),
   then field rules: ``email`` must be a lowercase ``@example.test`` address and ``group``
   must not mix scripts (a Cyrillic letter in a Latin name).
3. Policy check: privileged groups, disabled accounts and the like are refused before a
   human is ever asked, so an approval can't override them.
4. Write gate: write tools show the operator exactly what will happen and need a ``y``.
5. Run, with any exception turned into an error result (fail closed).

Nothing in the ticket, the directory or a tool result can change these rules: they are
code, not prompt.
"""

from __future__ import annotations

import json
import re
import sys
from collections.abc import Callable
from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path
from typing import Any, TextIO

from helpdesk_agent.audit import AuditLog
from helpdesk_agent.directory import Directory, is_mixed_script, normalize
from helpdesk_agent.tools import (
    TOOLS,
    PolicyDenied,
    ToolContext,
    ToolError,
    ToolKind,
    ToolSpec,
    display,
)

DEFAULT_ESCALATION_DIR = Path("logs/escalations")

DENIED_BY_HUMAN = (
    "Denied by human operator. Do not retry this action. Tell the requester it was not "
    "approved, or escalate if they need follow-up."
)


class Decision(StrEnum):
    ALLOWED = "allowed"  # read or write-lite, ran without approval
    APPROVED = "approved"  # write, human typed y
    DENIED_BY_HUMAN = "denied_by_human"
    DENIED_BY_POLICY = "denied_by_policy"
    UNKNOWN_TOOL = "unknown_tool"
    INVALID_INPUT = "invalid_input"
    TOOL_ERROR = "tool_error"  # ordinary failure, e.g. no such user
    INTERNAL_ERROR = "internal_error"  # bug or unexpected state; nothing was changed


class Approval(StrEnum):
    NOT_REQUIRED = "not_required"  # read or write-lite tool
    NOT_ASKED = "not_asked"  # stopped before the prompt (unknown, invalid, policy, error)
    APPROVED = "approved"
    DENIED = "denied"


# Rule 2. Matched against the raw argument, not a normalized form: no uppercase, no
# padding, no look-alike letters, no other domains. \Z, not $, so a trailing newline fails.
EMAIL_PATTERN = re.compile(r"[a-z0-9._-]+@example\.test\Z")


@dataclass(frozen=True)
class Proposal:
    tool: str
    args: dict[str, Any]
    description: str
    requester: str  # who filed the ticket, from the harness
    target: str  # whose account the write changes

    @property
    def requester_is_target(self) -> bool:
        return normalize(self.requester) == normalize(self.target)


@dataclass(frozen=True)
class Outcome:
    """What goes back to the model as the tool_result, plus the decision for the audit."""

    decision: Decision
    content: str
    is_error: bool


Approver = Callable[[Proposal], bool]


# ---------------------------------------------------------------- approvers


def deny_all(_proposal: Proposal) -> bool:
    """Approver for evals and CI: every write is denied, so nothing is ever changed."""
    return False


def make_tty_approver(stdin: TextIO = sys.stdin, stdout: TextIO = sys.stdout) -> Approver:
    """Approver that asks the operator at the terminal. Only an exact ``y`` approves.

    If stdin isn't an interactive terminal (piped input, CI, a script), every write is
    denied, so a ``y`` can't be fed in from a file or from ticket text.
    """

    def approve(proposal: Proposal) -> bool:
        if not stdin.isatty():
            stdout.write(f"\n[write gate] {proposal.tool}: no interactive terminal, denied.\n")
            stdout.flush()
            return False
        args = ", ".join(f"{k}={display(v)!r}" for k, v in proposal.args.items())
        if proposal.requester_is_target:
            match = "(requester is the target)"
        else:
            match = "!! REQUESTER IS NOT THE TARGET: check they may ask for this !!"
        stdout.write(
            "\n"
            "──────── approval required ────────\n"
            f"Tool:      {display(proposal.tool)}({args})\n"
            f"Effect:    {display(proposal.description)}\n"
            f"Requester: {display(proposal.requester)}\n"
            f"Target:    {display(proposal.target)}  {match}\n"
            "Type y to approve, anything else to deny: "
        )
        stdout.flush()
        answer = stdin.readline()
        return answer.strip() == "y"

    return approve


# ---------------------------------------------------------------- validation


def validate_args(spec: ToolSpec, args: Any) -> str | None:
    """Return an error message if ``args`` doesn't match the tool's schema, else None.

    Supports exactly what our schemas use: an object of required, non-empty strings with
    optional maxLength and no additional properties.
    """
    schema = spec.input_schema
    if not isinstance(args, dict):
        return "Arguments must be a JSON object."
    allowed = set(schema["properties"])
    extra = sorted(set(args) - allowed)
    if extra:
        return f"Unexpected argument(s): {', '.join(extra)}."
    missing = [k for k in schema["required"] if k not in args]
    if missing:
        return f"Missing required argument(s): {', '.join(missing)}."
    for key, prop in schema["properties"].items():
        value = args[key]
        if prop.get("type") == "string":
            if not isinstance(value, str):
                return f"{key} must be a string."
            if not value.strip():
                return f"{key} must not be empty."
            limit = prop.get("maxLength")
            if limit is not None and len(value) > limit:
                return f"{key} is longer than {limit} characters."
    return _check_fields(args)


def _check_fields(args: dict[str, Any]) -> str | None:
    """Field rules that apply whichever tool the field belongs to."""
    email = args.get("email")
    if email is not None and not EMAIL_PATTERN.match(email):
        return (
            "email must be a lowercase address at example.test (letters, digits, '.', '_', "
            "'-'), with no spaces or other characters."
        )
    group = args.get("group")
    if group is not None and is_mixed_script(group):
        return "group mixes letters from different alphabets; use the exact group name."
    return None


# ---------------------------------------------------------------- the gate


class Gate:
    def __init__(
        self,
        directory: Directory,
        approver: Approver,
        audit: AuditLog,
        ticket_id: str,
        requester: str,
        escalation_dir: Path = DEFAULT_ESCALATION_DIR,
    ) -> None:
        """``requester`` is who filed the ticket, recorded by the harness (rule 9). The
        model never supplies it: no tool schema has a requester field and extra arguments
        are rejected.
        """
        if not isinstance(requester, str) or not EMAIL_PATTERN.match(requester):
            raise ValueError("requester must be a lowercase @example.test address")
        self.approver = approver
        self.audit = audit
        self.ctx = ToolContext(
            directory=directory,
            escalation_dir=escalation_dir,
            ticket_id=ticket_id,
            requester=requester,
        )

    def execute(self, name: str, args: Any) -> Outcome:
        spec = TOOLS.get(name)
        if spec is None:
            return self._finish(
                name, None, args, Decision.UNKNOWN_TOOL, f"Unknown tool {name!r}.", error=True
            )

        problem = validate_args(spec, args)
        if problem is not None:
            return self._finish(name, spec, args, Decision.INVALID_INPUT, problem, error=True)

        try:
            if spec.check is not None:
                spec.check(self.ctx, args)
        except PolicyDenied as exc:
            return self._finish(
                name, spec, args, Decision.DENIED_BY_POLICY, f"Refused by policy: {exc}", error=True
            )
        except ToolError as exc:
            return self._finish(name, spec, args, Decision.TOOL_ERROR, str(exc), error=True)
        except Exception as exc:  # fail closed on anything unexpected
            return self._internal_error(name, spec, args, exc, Approval.NOT_ASKED)

        decision = Decision.ALLOWED
        approval = Approval.NOT_REQUIRED
        reason = f"{spec.kind.value} tool on the allowlist; arguments valid"
        if spec.kind is ToolKind.WRITE:
            try:
                assert spec.describe is not None  # noqa: S101 (every WRITE tool has one)
                proposal = Proposal(
                    tool=name,
                    args=dict(args),
                    description=spec.describe(self.ctx, args),
                    requester=self.ctx.requester,
                    target=args["email"],
                )
                approved = self.approver(proposal) is True
            except Exception as exc:
                return self._internal_error(name, spec, args, exc, Approval.NOT_ASKED)
            if not approved:
                return self._finish(
                    name,
                    spec,
                    args,
                    Decision.DENIED_BY_HUMAN,
                    DENIED_BY_HUMAN,
                    error=True,
                    approval=Approval.DENIED,
                    reason="operator did not type y",
                )
            decision = Decision.APPROVED
            approval = Approval.APPROVED
            reason = "passed policy checks; operator typed y"
            # Record the approval before acting. If the audit log can't be written, the
            # exception propagates and the write never happens.
            self.audit.record(
                "write_approved",
                ticket_id=self.ctx.ticket_id,
                requester=self.ctx.requester,
                requester_is_target=proposal.requester_is_target,
                tool=name,
                args=args,
                effect=proposal.description,
            )

        try:
            result, summary = spec.run(self.ctx, args)
        except ToolError as exc:
            return self._finish(
                name, spec, args, Decision.TOOL_ERROR, str(exc), error=True, approval=approval
            )
        except Exception as exc:
            return self._internal_error(name, spec, args, exc, approval)

        return self._finish(
            name,
            spec,
            args,
            decision,
            json.dumps(result, ensure_ascii=False),
            summary=summary,
            approval=approval,
            reason=reason,
        )

    # ------------------------------------------------------------ internals

    def _internal_error(
        self, name: str, spec: ToolSpec, args: Any, exc: Exception, approval: Approval
    ) -> Outcome:
        # The model gets a generic message; the exception type goes to the audit log.
        return self._finish(
            name,
            spec,
            args,
            Decision.INTERNAL_ERROR,
            "Internal error; nothing was changed. Escalate this ticket.",
            error=True,
            summary=f"{type(exc).__name__}",
            approval=approval,
        )

    def _finish(
        self,
        name: str,
        spec: ToolSpec | None,
        args: Any,
        decision: Decision,
        content: str,
        *,
        error: bool = False,
        summary: str | None = None,
        approval: Approval = Approval.NOT_ASKED,
        reason: str | None = None,
    ) -> Outcome:
        """Audit one tool call (rule 7) and build what goes back to the model.

        ``reason`` says why the policy decision came out as it did; for refusals and
        errors it is the message the model sees.
        """
        self.audit.record(
            "tool_call",
            ticket_id=self.ctx.ticket_id,
            requester=self.ctx.requester,
            tool=name,
            kind=spec.kind.value if spec else None,
            args=args if isinstance(args, dict) else repr(args),
            decision=decision.value,
            reason=reason or content,
            approval=approval.value,
            is_error=error,
            summary=summary or content,
        )
        return Outcome(decision=decision, content=content, is_error=error)
