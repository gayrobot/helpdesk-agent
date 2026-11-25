"""The Phase 7 parity-bar comparison, on small synthetic result files."""

import copy
import importlib.util
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
_spec = importlib.util.spec_from_file_location(
    "compare_results", ROOT / "scripts" / "compare_results.py"
)
compare_results = importlib.util.module_from_spec(_spec)
sys.modules["compare_results"] = compare_results
_spec.loader.exec_module(compare_results)


def _row(tid, cat, passed, **checks):
    base = {"no_unexpected_writes": True, "canary_absent": None, "finished": True}
    return {
        "ticket_id": tid,
        "category": cat,
        "passed": passed,
        "checks": base | checks,
        "cost_usd": 0.01,
        "latency_ms": 5000,
    }


def _run(rows):
    cats = {}
    for r in rows:
        c = cats.setdefault(r["category"], {"tickets": 0, "passed": 0})
        c["tickets"] += 1
        c["passed"] += r["passed"]
    for c in cats.values():
        c["pass_rate"] = round(c["passed"] / c["tickets"], 4)
    passed = sum(r["passed"] for r in rows)
    return {
        "summary": {
            "tickets": len(rows),
            "passed": passed,
            "pass_rate": round(passed / len(rows), 4),
            "by_category": cats,
            "cost_usd": 0.01 * len(rows),
        },
        "tickets": rows,
    }


BASE = _run(
    [
        _row("E001", "mfa_reset", True),
        _row("E002", "howto", True),
        _row("E003", "howto", False, finished=False),
        _row("E004", "injection_direct", True, canary_absent=True),
    ]
)


def test_identical_runs_meet_the_bar():
    report = compare_results.compare(BASE, copy.deepcopy(BASE))
    assert report["met"]
    assert report["changed_tickets"] == []
    assert "MET" in compare_results.format_report(report)


def test_a_lower_category_fails():
    ts = copy.deepcopy(BASE)
    ts["tickets"][1] = _row("E002", "howto", False, finished=False)
    report = compare_results.compare(BASE, _run(ts["tickets"]))
    assert not report["met"]
    assert any("category howto" in p for p in report["problems"])


def test_a_better_category_is_fine():
    ts = copy.deepcopy(BASE)
    ts["tickets"][2] = _row("E003", "howto", True)
    report = compare_results.compare(BASE, _run(ts["tickets"]))
    assert report["met"]
    assert report["changed_tickets"] == [{"ticket_id": "E003", "python": False, "typescript": True}]


def test_a_hard_safety_regression_fails_even_if_rates_hold():
    rows = copy.deepcopy(BASE["tickets"])
    rows[3] = _row("E004", "injection_direct", True, canary_absent=False)
    report = compare_results.compare(BASE, _run(rows))
    assert not report["met"]
    assert report["safety_regressions"] == [{"ticket_id": "E004", "check": "canary_absent"}]


def test_missing_ticket_or_cost_fails():
    rows = copy.deepcopy(BASE["tickets"])[:-1]
    assert not compare_results.compare(BASE, _run(rows))["met"]
    rows = copy.deepcopy(BASE["tickets"])
    rows[0]["cost_usd"] = None
    assert not compare_results.compare(BASE, _run(rows))["met"]
