"""The Phase 5 scorer and ticket set, checked key-free in CI."""

import json
from collections import Counter
from pathlib import Path

import pytest
from fakes import FakeClient, message, text, tool_use

from helpdesk_agent.directory import Directory
from helpdesk_agent.evals import (
    CollectingCallLog,
    load_tickets,
    run_tickets,
    score_transcript,
    summarize,
)
from helpdesk_agent.governance import EMAIL_PATTERN
from helpdesk_agent.retrieval import load_runbooks

ROOT = Path(__file__).parent.parent
TICKETS = load_tickets(ROOT / "evals" / "tickets.jsonl")
BY_ID = {t["id"]: t for t in TICKETS}
TRANSCRIPTS = sorted((ROOT / "evals" / "transcripts").glob("*.json"))


# ---------------------------------------------------------------- the ticket set


def test_ticket_set_size_and_ids():
    assert 50 <= len(TICKETS) <= 100
    assert len(BY_ID) == len(TICKETS)


def test_every_category_is_covered():
    cats = Counter(t["category"] for t in TICKETS)
    for needed in (
        "mfa_reset",
        "group_add",
        "howto",
        "privileged",
        "disabled",
        "on_behalf",
        "injection_direct",
        "injection_runbook",
    ):
        assert cats[needed] >= 3, needed


def test_tickets_reference_real_synthetic_data():
    directory = Directory.load()
    runbooks = {c.runbook for c in load_runbooks()}
    for t in TICKETS:
        assert EMAIL_PATTERN.match(t["requester"]) and directory.find_user(t["requester"])
        exp = t["expect"]
        assert exp["escalation"] in {"required", "forbidden", "optional"}
        for w in exp["required_writes"]:
            assert w in exp["allowed_writes"], t["id"]
        for w in exp["allowed_writes"]:
            assert directory.find_user(w["args"]["email"]), t["id"]
        if exp["runbook"]:
            assert exp["runbook"] in runbooks, t["id"]


def test_injection_tickets_carry_canaries():
    for t in TICKETS:
        if t["category"].startswith("injection"):
            canary = t["expect"]["canary"]
            assert canary and canary.startswith("CANARY-")
            assert t["expect"]["allowed_writes"] == []
            if t["category"] == "injection_direct":
                assert canary in t["body"]


def test_no_write_is_ever_allowed_on_a_privileged_or_disabled_account():
    directory = Directory.load()
    for t in TICKETS:
        for w in t["expect"]["allowed_writes"]:
            user = directory.find_user(w["args"]["email"])
            assert user["status"] == "active"
            assert not directory.privileged_memberships(user)
            group = w["args"].get("group")
            assert group is None or not directory.is_privileged_group(group)


# ---------------------------------------------------------------- scorer vs labels


@pytest.mark.parametrize("path", TRANSCRIPTS, ids=lambda p: p.stem)
def test_scorer_matches_hand_labels(path):
    data = json.loads(path.read_text())
    result = score_transcript(BY_ID[data["ticket_id"]], data["transcript"])
    assert result.passed is data["label"]["passed"]
    assert sorted(result.failed) == sorted(data["label"]["failed_checks"])


def test_labelled_transcripts_cover_pass_and_fail_for_each_check():
    failed = Counter()
    passes = 0
    for path in TRANSCRIPTS:
        label = json.loads(path.read_text())["label"]
        passes += label["passed"]
        failed.update(label["failed_checks"])
    assert passes >= 5
    for check in (
        "finished",
        "no_unexpected_writes",
        "required_writes",
        "escalation",
        "cites_runbook",
        "canary_absent",
    ):
        assert failed[check] >= 1, check


def test_summary_by_category():
    scores = [
        score_transcript(
            BY_ID[json.loads(p.read_text())["ticket_id"]], json.loads(p.read_text())["transcript"]
        )
        for p in TRANSCRIPTS
    ]
    summary = summarize(scores)
    assert summary["tickets"] == len(TRANSCRIPTS)
    assert 0 < summary["pass_rate"] < 1


# ---------------------------------------------------------------- runner (fake model)


def test_runner_uses_auto_deny_and_scores(tmp_path):
    ticket = BY_ID["E001"]
    fake = FakeClient(
        [
            message([tool_use("reset_mfa", {"email": "jamie@example.test"})], "tool_use"),
            message([text("It wasn't approved; IT will follow up.")], "end_turn"),
        ]
    )
    log = CollectingCallLog(tmp_path / "calls.jsonl")
    results = run_tickets([ticket], fake, call_log=log, audit_path=tmp_path / "audit.jsonl")
    row = results["tickets"][0]
    assert row["passed"] is True
    assert row["transcript"]["events"][0]["decision"] == "denied_by_human"
    assert row["model_calls"] == 2
    assert results["summary"]["cost_usd"] > 0
    assert results["summary"]["retriever"] == "bm25"  # forced in conftest
