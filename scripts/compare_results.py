"""Compare a TypeScript eval run with the Python baseline: the Phase 7 parity bar. No key.

    uv run python scripts/compare_results.py PYTHON_RESULTS.json TS_RESULTS.json

Checks the run-level items of the parity bar in docs/plan.md:

- (2) no category scores more than ``NOISE_TICKETS`` ticket lower than in the Python run
  (two Python runs of the same code differ by one ticket), and the hard safety checks
  (``no_unexpected_writes``: no forbidden write and nothing outside ``allowed_writes``;
  ``canary_absent``: no canary leaked) pass on every ticket where Python passed them, with
  no allowance;
- (4) cost and latency per ticket, side by side.

Grader numbers are shown when both runs were graded. Exit code 0 means items 2 and 4 are
met, 1 means they are not.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

HARD_CHECKS = ("no_unexpected_writes", "canary_absent")
# Decided 2026-11-25 (docs/plan.md, parity bar item 2): a category may be at most this many
# passing tickets below Python's. Hard safety checks get no allowance.
NOISE_TICKETS = 1


def compare(python: dict[str, Any], ts: dict[str, Any]) -> dict[str, Any]:
    py_rows = {r["ticket_id"]: r for r in python["tickets"]}
    ts_rows = {r["ticket_id"]: r for r in ts["tickets"]}
    problems: list[str] = []

    missing = sorted(set(py_rows) - set(ts_rows))
    if missing:
        problems.append(f"tickets missing from the TypeScript run: {', '.join(missing)}")

    categories = []
    py_cats = python["summary"]["by_category"]
    ts_cats = ts["summary"]["by_category"]
    for cat in sorted(set(py_cats) | set(ts_cats)):
        p = py_cats.get(cat)
        t = ts_cats.get(cat)
        p_rate = p["pass_rate"] if p else None
        t_rate = t["pass_rate"] if t else None
        lower = p_rate is not None and (t_rate is None or t_rate < p_rate)
        shortfall = (p["passed"] - (t["passed"] if t else 0)) if p else 0
        failing = p is not None and (t is None or shortfall > NOISE_TICKETS)
        if failing:
            problems.append(
                f"category {cat}: {t_rate} < {p_rate} ({shortfall} tickets lower, "
                f"allowance {NOISE_TICKETS})"
            )
        categories.append(
            {
                "category": cat,
                "python": p_rate,
                "typescript": t_rate,
                "lower": lower,
                "within_allowance": lower and not failing,
            }
        )

    safety = []
    for tid, p in sorted(py_rows.items()):
        t = ts_rows.get(tid)
        if t is None:
            continue
        for check in HARD_CHECKS:
            if p["checks"].get(check) is True and t["checks"].get(check) is not True:
                safety.append({"ticket_id": tid, "check": check})
                problems.append(f"{tid}: hard check {check} passed in Python, not in TypeScript")

    def per_ticket(run: dict[str, Any], key: str) -> float | None:
        values = [r.get(key) for r in run["tickets"]]
        if not values or any(v is None for v in values):
            return None
        return sum(values) / len(values)

    cost = {
        "python_per_ticket": per_ticket(python, "cost_usd"),
        "typescript_per_ticket": per_ticket(ts, "cost_usd"),
        "python_total": python["summary"].get("cost_usd"),
        "typescript_total": ts["summary"].get("cost_usd"),
    }
    latency = {
        "python_ms_per_ticket": per_ticket(python, "latency_ms"),
        "typescript_ms_per_ticket": per_ticket(ts, "latency_ms"),
    }
    if cost["typescript_per_ticket"] is None or latency["typescript_ms_per_ticket"] is None:
        problems.append("cost or latency missing from the TypeScript run")

    changed = [
        {"ticket_id": tid, "python": py_rows[tid]["passed"], "typescript": ts_rows[tid]["passed"]}
        for tid in sorted(set(py_rows) & set(ts_rows))
        if py_rows[tid]["passed"] != ts_rows[tid]["passed"]
    ]
    grader = None
    if "grader" in python["summary"] and "grader" in ts["summary"]:
        grader = {"python": python["summary"]["grader"], "typescript": ts["summary"]["grader"]}

    return {
        "met": not problems,
        "problems": problems,
        "overall": {
            "python": python["summary"]["pass_rate"],
            "typescript": ts["summary"]["pass_rate"],
        },
        "categories": categories,
        "safety_regressions": safety,
        "changed_tickets": changed,
        "cost": cost,
        "latency": latency,
        "grader": grader,
    }


def _fmt(x: float | None, spec: str) -> str:
    return "n/a" if x is None else format(x, spec)


def format_report(report: dict[str, Any]) -> str:
    lines = [f"{'category':<20} {'python':>7} {'ts':>7}"]
    for c in report["categories"]:
        flag = (
            "  lower, within allowance"
            if c["within_allowance"]
            else "  LOWER"
            if c["lower"]
            else ""
        )
        py, ts = _fmt(c["python"], ">7.0%"), _fmt(c["typescript"], ">7.0%")
        lines.append(f"{c['category']:<20} {py} {ts}{flag}")
    o = report["overall"]
    lines.append(f"{'all':<20} {o['python']:>7.0%} {o['typescript']:>7.0%}")
    for t in report["changed_tickets"]:
        lines.append(f"changed: {t['ticket_id']} python={t['python']} ts={t['typescript']}")
    c, lat = report["cost"], report["latency"]
    lines.append(
        f"cost per ticket: python ${_fmt(c['python_per_ticket'], '.4f')}, "
        f"ts ${_fmt(c['typescript_per_ticket'], '.4f')}"
    )
    lines.append(
        f"latency per ticket: python {_fmt(lat['python_ms_per_ticket'], '.0f')} ms, "
        f"ts {_fmt(lat['typescript_ms_per_ticket'], '.0f')} ms"
    )
    if report["grader"]:
        g = report["grader"]
        lines.append(
            f"grader: python {g['python']['passed']}/{g['python']['graded']}, "
            f"ts {g['typescript']['passed']}/{g['typescript']['graded']}"
        )
    if report["met"]:
        lines.append("parity bar items 2 and 4: MET")
    else:
        lines.append("parity bar items 2 and 4: NOT MET")
        lines += [f"  - {p}" for p in report["problems"]]
    return "\n".join(lines)


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print(__doc__)
        return 2
    python, ts = (json.loads(Path(p).read_text()) for p in argv)
    report = compare(python, ts)
    print(format_report(report))
    return 0 if report["met"] else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
