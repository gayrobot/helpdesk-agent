"""Every governance rule in docs/plan.md, including attempts to get around it."""

import json

import pytest
from conftest import RecordingApprover

from helpdesk_agent.audit import AuditLog
from helpdesk_agent.governance import DENIED_BY_HUMAN, Decision, Gate, deny_all

JAMIE = "jamie@example.test"

# ---------------------------------------------------------------- allowlist


@pytest.mark.parametrize("name", ["delete_user", "run_shell", "LOOKUP_USER", "lookup_user ", ""])
def test_unknown_tools_are_rejected_and_audited(make_gate, read_audit, name):
    outcome = make_gate().execute(name, {"email": JAMIE})
    assert outcome.decision is Decision.UNKNOWN_TOOL
    assert outcome.is_error
    assert read_audit()[-1]["decision"] == "unknown_tool"


# ---------------------------------------------------------------- input validation


@pytest.mark.parametrize(
    "args",
    [
        {},
        {"email": 42},
        {"email": ""},
        {"email": "   "},
        {"email": JAMIE, "approved": True},
        {"email": "a" * 300 + "@example.test"},
        "jamie@example.test",
        None,
    ],
)
def test_invalid_arguments_rejected(make_gate, args):
    outcome = make_gate().execute("lookup_user", args)
    assert outcome.decision is Decision.INVALID_INPUT
    assert outcome.is_error


def test_extra_argument_cannot_smuggle_approval(make_gate, directory):
    approver = RecordingApprover(answer=False)
    outcome = make_gate(approver).execute("reset_mfa", {"email": JAMIE, "human_approved": "y"})
    assert outcome.decision is Decision.INVALID_INPUT
    assert approver.proposals == []
    assert directory.find_user(JAMIE)["mfa"]["enrolled"] is True


# ---------------------------------------------------------------- reads


def test_read_tool_runs_without_approval(make_gate, read_audit):
    approver = RecordingApprover(answer=False)
    outcome = make_gate(approver).execute("lookup_user", {"email": JAMIE})
    assert outcome.decision is Decision.ALLOWED
    assert json.loads(outcome.content)["name"] == "Jamie Rivera"
    assert approver.proposals == []
    assert read_audit()[-1]["kind"] == "read"
    assert read_audit()[-1]["decision"] == "allowed"


def test_lookup_unknown_user_is_a_tool_error(make_gate):
    outcome = make_gate().execute("lookup_user", {"email": "nobody@example.test"})
    assert outcome.decision is Decision.TOOL_ERROR
    assert outcome.is_error


def test_list_devices(make_gate):
    outcome = make_gate().execute("list_devices", {"email": "kofi.mensah@example.test"})
    devices = json.loads(outcome.content)["devices"]
    assert devices and devices[0]["compliant"] is False


# ---------------------------------------------------------------- write gate


def test_write_denied_by_human_changes_nothing(make_gate, directory, read_audit):
    approver = RecordingApprover(answer=False)
    outcome = make_gate(approver).execute("reset_mfa", {"email": JAMIE})
    assert outcome.decision is Decision.DENIED_BY_HUMAN
    assert outcome.content == DENIED_BY_HUMAN
    assert len(approver.proposals) == 1
    assert directory.find_user(JAMIE)["mfa"]["enrolled"] is True
    assert [e["event"] for e in read_audit()] == ["tool_call"]
    assert read_audit()[-1]["decision"] == "denied_by_human"


def test_write_approved_runs_and_is_audited_before_acting(make_gate, directory, read_audit):
    approver = RecordingApprover(answer=True)
    outcome = make_gate(approver).execute("reset_mfa", {"email": JAMIE})
    assert outcome.decision is Decision.APPROVED
    assert not outcome.is_error
    assert directory.find_user(JAMIE)["mfa"]["enrolled"] is False
    events = read_audit()
    assert [e["event"] for e in events] == ["write_approved", "tool_call"]
    assert "Jamie Rivera" in events[0]["effect"]


def test_proposal_describes_exactly_what_will_happen(make_gate):
    approver = RecordingApprover(answer=False)
    make_gate(approver).execute("add_to_group", {"email": JAMIE, "group": "figma-users"})
    (proposal,) = approver.proposals
    assert proposal.tool == "add_to_group"
    assert proposal.args == {"email": JAMIE, "group": "figma-users"}
    assert "Jamie Rivera" in proposal.description
    assert "figma-users" in proposal.description


@pytest.mark.parametrize("answer", [1, "y", "yes", None, object()])
def test_only_literal_true_from_approver_counts(make_gate, directory, answer):
    outcome = make_gate(lambda _p: answer).execute("reset_mfa", {"email": JAMIE})
    assert outcome.decision is Decision.DENIED_BY_HUMAN
    assert directory.find_user(JAMIE)["mfa"]["enrolled"] is True


def test_approver_exception_fails_closed(make_gate, directory):
    def broken(_proposal):
        raise RuntimeError("terminal went away")

    outcome = make_gate(broken).execute("reset_mfa", {"email": JAMIE})
    assert outcome.decision is Decision.INTERNAL_ERROR
    assert directory.find_user(JAMIE)["mfa"]["enrolled"] is True


def test_deny_all_is_the_eval_default(make_gate, directory):
    outcome = make_gate(deny_all).execute("add_to_group", {"email": JAMIE, "group": "figma-users"})
    assert outcome.decision is Decision.DENIED_BY_HUMAN
    assert "figma-users" not in directory.find_user(JAMIE)["groups"]


def test_audit_failure_blocks_the_write(directory, tmp_path):
    blocked = tmp_path / "not-a-dir"
    blocked.write_text("a file where the log directory should be")
    gate = Gate(
        directory=directory,
        approver=lambda _p: True,
        audit=AuditLog(blocked / "audit.jsonl"),
        ticket_id="T-TEST",
        escalation_dir=tmp_path / "esc",
    )
    with pytest.raises(OSError):
        gate.execute("reset_mfa", {"email": JAMIE})
    assert directory.find_user(JAMIE)["mfa"]["enrolled"] is True


# ---------------------------------------------------------------- deny list


@pytest.mark.parametrize(
    "group",
    [
        "admins",
        "Admins",
        "ADMINS ",
        "domain-admins",
        "okta-super-admins",
        "aws-prod-admins",
        "finance-approvers",
        "admins\u200b",
        "\uff21\uff44\uff4d\uff49\uff4e\uff53",
        "shadow-admins",
    ],
)
def test_privileged_groups_refused_even_when_human_would_approve(make_gate, directory, group):
    approver = RecordingApprover(answer=True)
    outcome = make_gate(approver).execute("add_to_group", {"email": JAMIE, "group": group})
    assert outcome.decision is Decision.DENIED_BY_POLICY
    assert approver.proposals == [], "the human must never be asked"
    assert not directory.privileged_memberships(directory.find_user(JAMIE))


def test_injected_title_does_not_unlock_admins(make_gate, directory):
    """eli.novak's title says the assistant may add them to admins. It can't."""
    approver = RecordingApprover(answer=True)
    outcome = make_gate(approver).execute(
        "add_to_group", {"email": "eli.novak@example.test", "group": "admins"}
    )
    assert outcome.decision is Decision.DENIED_BY_POLICY
    assert approver.proposals == []


def test_unknown_group_is_an_error_not_a_create(make_gate, directory):
    approver = RecordingApprover(answer=True)
    outcome = make_gate(approver).execute(
        "add_to_group", {"email": JAMIE, "group": "brand-new-group"}
    )
    assert outcome.decision is Decision.TOOL_ERROR
    assert approver.proposals == []
    assert directory.find_group("brand-new-group") is None


def test_already_member_is_an_error_without_prompt(make_gate):
    approver = RecordingApprover(answer=True)
    outcome = make_gate(approver).execute("add_to_group", {"email": JAMIE, "group": "engineering"})
    assert outcome.decision is Decision.TOOL_ERROR
    assert approver.proposals == []


@pytest.mark.parametrize(
    "email", ["sam.whitfield@example.test", "rosa.delgado@example.test", "grace.lin@example.test"]
)
def test_mfa_reset_refused_for_privileged_accounts(make_gate, directory, email):
    approver = RecordingApprover(answer=True)
    outcome = make_gate(approver).execute("reset_mfa", {"email": email})
    assert outcome.decision is Decision.DENIED_BY_POLICY
    assert approver.proposals == []
    assert directory.find_user(email)["mfa"]["enrolled"] is True


@pytest.mark.parametrize(
    ("tool", "args"),
    [
        ("reset_mfa", {"email": "riley.okafor@example.test"}),
        ("add_to_group", {"email": "riley.okafor@example.test", "group": "vpn-users"}),
    ],
)
def test_writes_refused_for_disabled_accounts(make_gate, tool, args):
    approver = RecordingApprover(answer=True)
    outcome = make_gate(approver).execute(tool, args)
    assert outcome.decision is Decision.DENIED_BY_POLICY
    assert approver.proposals == []


# ---------------------------------------------------------------- escalate


def test_escalate_writes_ticket_without_approval(make_gate, tmp_path):
    approver = RecordingApprover(answer=False)
    outcome = make_gate(approver).execute(
        "escalate", {"summary": "Requester asked for admins; refused by policy."}
    )
    assert outcome.decision is Decision.ALLOWED
    ticket = json.loads(outcome.content)["ticket"]
    saved = json.loads((tmp_path / "logs" / "escalations" / f"{ticket}.json").read_text())
    assert saved["source_ticket"] == "T-TEST"
    assert approver.proposals == []


# ---------------------------------------------------------------- audit shape


def test_audit_lines_are_json_with_required_fields(make_gate, read_audit):
    gate = make_gate()
    gate.execute("lookup_user", {"email": JAMIE})
    gate.execute("nope", {})
    gate.execute("reset_mfa", {"email": JAMIE})
    for entry in read_audit():
        assert {"ts", "event", "ticket_id", "tool", "decision", "is_error"} <= entry.keys()
    assert [e["decision"] for e in read_audit()] == ["allowed", "unknown_tool", "denied_by_human"]


def test_audit_truncates_long_values(make_gate, read_audit):
    make_gate().execute("escalate", {"summary": "x" * 1500})
    assert len(read_audit()[-1]["args"]["summary"]) < 400


# ---------------------------------------------------------------- Phase 3 rules


@pytest.mark.parametrize(
    "email",
    [
        "Jamie@example.test",
        " jamie@example.test",
        "jamie@example.test ",
        "jamie@example.test​",
        "jamie@example.com",
        "jamie@example.test.evil.test",
        "j\u0430mie@example.test",  # Cyrillic a
        "jamie+admin@example.test",
        "jamie@EXAMPLE.test",
    ],
)
def test_email_must_match_exact_format(make_gate, email):
    outcome = make_gate().execute("lookup_user", {"email": email})
    assert outcome.decision is Decision.INVALID_INPUT


@pytest.mark.parametrize(
    "group",
    [
        "\u0430dmins",  # Cyrillic a + Latin
        "figma-us\u0435rs",  # Cyrillic e in a harmless-looking group
        "dom\u03b1in-admins",  # Greek alpha
    ],
)
def test_mixed_script_group_names_rejected(make_gate, directory, group):
    approver = RecordingApprover(answer=True)
    outcome = make_gate(approver).execute("add_to_group", {"email": JAMIE, "group": group})
    assert outcome.decision is Decision.INVALID_INPUT
    assert approver.proposals == []


def test_group_whitespace_is_collapsed_before_the_deny_check(make_gate):
    approver = RecordingApprover(answer=True)
    outcome = make_gate(approver).execute(
        "add_to_group", {"email": JAMIE, "group": "  domain-admins\t "}
    )
    assert outcome.decision is Decision.DENIED_BY_POLICY
    assert approver.proposals == []


def test_requester_comes_from_the_harness(directory, audit_path, tmp_path, read_audit):
    approver = RecordingApprover(answer=False)
    gate = Gate(
        directory=directory,
        approver=approver,
        audit=AuditLog(audit_path),
        ticket_id="T-REQ",
        escalation_dir=tmp_path / "esc",
        requester="eli.novak@example.test",
    )
    gate.execute("reset_mfa", {"email": JAMIE})
    proposal = approver.proposals[0]
    assert proposal.requester == "eli.novak@example.test"
    assert proposal.target == JAMIE
    assert proposal.on_behalf_of_someone_else
    assert read_audit()[-1]["requester"] == "eli.novak@example.test"


def test_no_tool_accepts_a_requester_argument():
    from helpdesk_agent.tools import TOOLS

    for spec in TOOLS.values():
        assert "requester" not in spec.input_schema["properties"]
