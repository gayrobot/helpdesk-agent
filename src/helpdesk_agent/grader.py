"""Phase 5 live: a Haiku grader for the quality of free-text answers.

The deterministic checks in ``evals.py`` decide pass/fail. They can tell that a how-to
reply names the right runbook, but not whether what it says is right. This grader adds
that, as a separate score that never changes the deterministic pass rate.

- Only how-to style tickets are graded, the same ones ``cites_runbook`` scores: the
  ticket names an expected runbook and the agent finished normally (answered, or
  escalated with a reply). Everything else is ``None`` and makes no call.
- One tool-less call per graded ticket to ``GRADER_MODEL`` with structured output. The
  model returns three yes/no verdicts and a reason; code decides the pass.
- The prompt lives in ``data/grader-prompt.md`` so it can be read and reviewed on its
  own. Ticket, runbook and reply go into the user message inside labelled tags; they are
  data, and the grader has no tools to act on them anyway.
- It fails closed: a refusal, a cut-off reply, JSON that doesn't match the schema or an
  API error gives an ungraded result with the reason, never a pass, and the run goes on.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from importlib import resources
from typing import Any

from helpdesk_agent.client import GRADER_MODEL, ModelCaller
from helpdesk_agent.retrieval import load_runbooks

GRADER_MAX_TOKENS = 2_000  # thinking is on for Haiku 5.5 and counts against this
GRADER_EFFORT = "low"
GRADED_STATUSES = frozenset({"answered", "escalated"})  # same as evals.FINISHED
CRITERIA = ("answers_question", "grounded", "no_contradiction")

OUTPUT_FORMAT: dict[str, Any] = {
    "type": "json_schema",
    "schema": {
        "type": "object",
        "properties": {
            **{name: {"type": "boolean"} for name in CRITERIA},
            "reason": {"type": "string"},
        },
        "required": [*CRITERIA, "reason"],
        "additionalProperties": False,
    },
}


def load_prompt() -> str:
    path = resources.files("helpdesk_agent").joinpath("data/grader-prompt.md")
    return path.read_text(encoding="utf-8").strip()


def expected_runbooks(ticket: dict[str, Any]) -> list[str]:
    """One id, or a list when several runbooks each answer the ticket."""
    rb = ticket["expect"].get("runbook")
    if not rb:
        return []
    return [rb] if isinstance(rb, str) else list(rb)


def eligible(ticket: dict[str, Any], transcript: dict[str, Any]) -> bool:
    return bool(expected_runbooks(ticket)) and transcript.get("status") in GRADED_STATUSES


def runbook_text(runbook_ids: list[str]) -> str:
    """The full text of each runbook, rebuilt from the same chunks retrieval uses."""
    chunks = load_runbooks()
    parts = []
    for rb in runbook_ids:
        sections = [c for c in chunks if c.runbook == rb]
        if not sections:
            raise KeyError(f"unknown runbook: {rb}")
        body = "\n\n".join(f"## {c.section}\n{c.text}" for c in sections)
        parts.append(f'<runbook id="{rb}">\n# {sections[0].title}\n\n{body}\n</runbook>')
    return "\n".join(parts)


def build_user_message(ticket: dict[str, Any], reply: str) -> str:
    return (
        f"<ticket>\n{ticket['body']}\n</ticket>\n"
        f"{runbook_text(expected_runbooks(ticket))}\n"
        f"<reply>\n{reply}\n</reply>"
    )


@dataclass
class Grade:
    """``verdicts`` is None when the ticket could not be graded; ``error`` says why."""

    verdicts: dict[str, bool] | None
    reason: str = ""
    error: str | None = None

    @property
    def graded(self) -> bool:
        return self.verdicts is not None

    @property
    def passed(self) -> bool:
        return self.verdicts is not None and all(self.verdicts.values())

    def to_dict(self) -> dict[str, Any]:
        return {
            "graded": self.graded,
            "passed": self.passed,
            "verdicts": self.verdicts,
            "reason": self.reason,
            "error": self.error,
        }


def parse_grade(text: str) -> Grade:
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        return Grade(None, error="invalid_json")
    if not isinstance(data, dict) or set(data) != {*CRITERIA, "reason"}:
        return Grade(None, error="schema_mismatch")
    verdicts = {name: data[name] for name in CRITERIA}
    if not all(isinstance(v, bool) for v in verdicts.values()) or not isinstance(
        data["reason"], str
    ):
        return Grade(None, error="schema_mismatch")
    return Grade(verdicts, reason=data["reason"])


class Grader:
    def __init__(self, caller: ModelCaller) -> None:
        self.caller = caller
        self.system = load_prompt()

    @classmethod
    def for_client(cls, client: Any, log: Any) -> Grader:
        caller = ModelCaller(
            client,
            log,
            model=GRADER_MODEL,
            max_tokens=GRADER_MAX_TOKENS,
            effort=GRADER_EFFORT,
            fallbacks=False,  # Haiku 5.5 has no server-side refusal fallback
        )
        return cls(caller)

    def grade(self, ticket: dict[str, Any], transcript: dict[str, Any]) -> Grade | None:
        """None when the ticket isn't one the grader judges."""
        if not eligible(ticket, transcript):
            return None
        message = build_user_message(ticket, transcript.get("final_text", "") or "")
        try:
            response = self.caller.create(
                ticket_id=ticket["id"],
                purpose="grade",
                system=self.system,
                messages=[{"role": "user", "content": message}],
                output_format=OUTPUT_FORMAT,
            )
        except Exception as exc:  # logged by ModelCaller; grading must not stop the run
            return Grade(None, error=f"api_error:{type(exc).__name__}")
        stop = getattr(response, "stop_reason", None)
        if stop != "end_turn":
            return Grade(None, error=f"stop_reason:{stop}")
        texts = [b.text for b in response.content if getattr(b, "type", None) == "text"]
        if not texts:
            return Grade(None, error="no_text")
        return parse_grade(texts[0])


def summarize_grades(rows: list[dict[str, Any]]) -> dict[str, Any]:
    """Grader totals over result rows; ``grade`` is None for tickets it doesn't judge."""
    grades = [r["grade"] for r in rows if r.get("grade") is not None]
    graded = [g for g in grades if g["graded"]]
    passed = sum(g["passed"] for g in graded)
    costs = [r.get("grader_cost_usd") for r in rows if r.get("grader_cost_usd") is not None]
    return {
        "model": GRADER_MODEL,
        "eligible": len(grades),
        "graded": len(graded),
        "ungraded": len(grades) - len(graded),
        "passed": passed,
        "pass_rate": round(passed / len(graded), 4) if graded else 0.0,
        "by_criterion": {name: sum(bool(g["verdicts"][name]) for g in graded) for name in CRITERIA},
        "cost_usd": round(sum(costs), 6),
    }
