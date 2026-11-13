"""The governance gate: the only path from a model's tool call to a tool.

Order of checks for every call, each audited:

1. Allowlist: unknown tool names are rejected.
2. Input validation: exact schema match (required keys, string types, length, no extras).
3. Policy check: privileged groups, disabled accounts and the like are refused before a
   human is ever asked, so an approval can't override them.
4. Write gate: write tools show the operator exactly what will happen and need a ``y``.
5. Run, with any exception turned into an error result (fail closed).

Nothing in the ticket, the directory or a tool result can change these rules: they are
code, not prompt.
"""

from __future__ import annotations

import json
import sys
from collections.abc import Callable
from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path
from typing import Any, TextIO

from helpdesk_agent.audit import AuditLog
from helpdesk_agent.directory import Directory
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


@dataclass(frozen=True)
class Proposal:
    tool: str
    args: dict[str, Any]
    description: str


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
        stdout.write(
            "\n"
            "──────── approval required ────────\n"
            f"Tool:    {proposal.tool}({args})\n"
            f"Effect:  {proposal.description}\n"
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
    return None


# ---------------------------------------------------------------- the gate


class Gate:
    def __init__(
        self,
        directory: Directory,
        approver: Approver,
        audit: AuditLog,
        ticket_id: str,
        escalation_dir: Path = DEFAULT_ESCALATION_DIR,
    ) -> None:
        self.approver = approver
        self.audit = audit
        self.ctx = ToolContext(
            directory=directory, escalation_dir=escalation_dir, ticket_id=ticket_id
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
            return self._internal_error(name, spec, args, exc)

        decision = Decision.ALLOWED
        if spec.kind is ToolKind.WRITE:
            try:
                assert spec.describe is not None  # noqa: S101 (every WRITE tool has one)
                proposal = Proposal(name, dict(args), spec.describe(self.ctx, args))
                approved = self.approver(proposal) is True
            except Exception as exc:
                return self._internal_error(name, spec, args, exc)
            if not approved:
                return self._finish(
                    name, spec, args, Decision.DENIED_BY_HUMAN, DENIED_BY_HUMAN, error=True
                )
            decision = Decision.APPROVED
            # Record the approval before acting. If the audit log can't be written, the
            # exception propagates and the write never happens.
            self.audit.record(
                "write_approved",
                ticket_id=self.ctx.ticket_id,
                tool=name,
                args=args,
                effect=proposal.description,
            )

        try:
            result, summary = spec.run(self.ctx, args)
        except ToolError as exc:
            return self._finish(name, spec, args, Decision.TOOL_ERROR, str(exc), error=True)
        except Exception as exc:
            return self._internal_error(name, spec, args, exc)

        return self._finish(
            name, spec, args, decision, json.dumps(result, ensure_ascii=False), summary=summary
        )

    # ------------------------------------------------------------ internals

    def _internal_error(self, name: str, spec: ToolSpec, args: Any, exc: Exception) -> Outcome:
        # The model gets a generic message; the exception type goes to the audit log.
        return self._finish(
            name,
            spec,
            args,
            Decision.INTERNAL_ERROR,
            "Internal error; nothing was changed. Escalate this ticket.",
            error=True,
            summary=f"{type(exc).__name__}",
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
    ) -> Outcome:
        self.audit.record(
            "tool_call",
            ticket_id=self.ctx.ticket_id,
            tool=name,
            kind=spec.kind.value if spec else None,
            args=args if isinstance(args, dict) else repr(args),
            decision=decision.value,
            is_error=error,
            summary=summary or content,
        )
        return Outcome(decision=decision, content=content, is_error=error)
