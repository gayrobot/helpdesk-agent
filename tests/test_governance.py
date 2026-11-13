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
        requester=JAMIE,
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
        assert {
            "ts",
            "event",
            "ticket_id",
            "requester",
            "tool",
            "args",
            "decision",
            "reason",
            "approval",
            "is_error",
            "summary",
        } <= entry.keys()
    assert [e["decision"] for e in read_audit()] == ["allowed", "unknown_tool", "denied_by_human"]


def test_audit_truncates_long_values(make_gate, read_audit):
    make_gate().execute("escalate", {"summary": "x" * 1500})
    assert len(read_audit()[-1]["args"]["summary"]) < 400


# ---------------------------------------------------------------- rule 2: email format


@pytest.mark.parametrize(
    "email",
    [
        "Jamie@example.test",  # uppercase
        "jamie@example.test ",  # trailing space
        " jamie@example.test",  # leading space
        "jamie@example.test\n",  # trailing newline ($ would have allowed this)
        "jamie@example.test\u200b",  # zero-width space
        "j\u0430mie@example.test",  # Cyrillic a
        "\uff4a\uff41\uff4d\uff49\uff45@example.test",  # fullwidth
        "jamie@example.com",  # other domain
        "jamie@example.test.evil.test",  # suffix trick
        "jamie@evil.example.test",  # subdomain
        "jamie@example.test@evil.test",
        "jamie+admin@example.test",  # plus addressing
        "jamie@example\u2024test",  # one-dot leader instead of '.'
        "@example.test",
    ],
)
@pytest.mark.parametrize("tool", ["lookup_user", "list_devices", "reset_mfa"])
def test_email_must_match_the_strict_pattern(make_gate, read_audit, tool, email):
    approver = RecordingApprover(answer=True)
    outcome = make_gate(approver).execute(tool, {"email": email})
    assert outcome.decision is Decision.INVALID_INPUT
    assert "example.test" in outcome.content
    assert approver.proposals == []
    assert read_audit()[-1]["approval"] == "not_asked"


def test_email_rule_applies_to_add_to_group(make_gate, directory):
    approver = RecordingApprover(answer=True)
    outcome = make_gate(approver).execute(
        "add_to_group", {"email": "Jamie@example.test", "group": "vpn-users"}
    )
    assert outcome.decision is Decision.INVALID_INPUT
    assert approver.proposals == []


# ---------------------------------------------------------------- rule 4: mixed scripts


@pytest.mark.parametrize(
    "group",
    [
        "\u0430dmins",  # Cyrillic a + Latin
        "domain-\u0430dmins",
        "\u0391dmins",  # Greek Alpha + Latin
        "vpn-\u0443sers",  # Cyrillic u in an ordinary group
    ],
)
def test_mixed_script_group_rejected_before_deny_check(make_gate, directory, read_audit, group):
    approver = RecordingApprover(answer=True)
    outcome = make_gate(approver).execute("add_to_group", {"email": JAMIE, "group": group})
    assert outcome.decision is Decision.INVALID_INPUT
    assert "alphabets" in outcome.content
    assert approver.proposals == []
    assert not directory.privileged_memberships(directory.find_user(JAMIE))
    assert read_audit()[-1]["decision"] == "invalid_input"


@pytest.mark.parametrize("group", ["Domain Admins ", "domain   admins", "Domain\u00a0Admins"])
def test_padded_privileged_names_denied_by_policy(make_gate, group):
    approver = RecordingApprover(answer=True)
    outcome = make_gate(approver).execute("add_to_group", {"email": JAMIE, "group": group})
    assert outcome.decision is Decision.DENIED_BY_POLICY
    assert approver.proposals == []


# ---------------------------------------------------------------- rule 9: requester


def test_requester_comes_from_the_harness(make_gate):
    approver = RecordingApprover(answer=False)
    make_gate(approver, requester="priya.nair@example.test").execute("reset_mfa", {"email": JAMIE})
    (proposal,) = approver.proposals
    assert proposal.requester == "priya.nair@example.test"
    assert proposal.target == JAMIE
    assert proposal.requester_is_target is False


def test_requester_matching_target_is_recognised(make_gate):
    approver = RecordingApprover(answer=False)
    make_gate(approver).execute("reset_mfa", {"email": JAMIE})
    assert approver.proposals[0].requester_is_target is True


@pytest.mark.parametrize("field", ["requester", "requested_by", "on_behalf_of"])
def test_model_cannot_set_the_requester(make_gate, field):
    approver = RecordingApprover(answer=True)
    outcome = make_gate(approver, requester="priya.nair@example.test").execute(
        "reset_mfa", {"email": JAMIE, field: JAMIE}
    )
    assert outcome.decision is Decision.INVALID_INPUT
    assert approver.proposals == []


def test_no_tool_schema_has_a_requester_field():
    from helpdesk_agent.tools import TOOLS

    for spec in TOOLS.values():
        assert not any("request" in key for key in spec.input_schema["properties"])


@pytest.mark.parametrize(
    "requester", ["", "Jamie@example.test", "jamie@example.com", "jamie@example.test ", None]
)
def test_gate_refuses_a_malformed_requester(directory, tmp_path, requester):
    with pytest.raises(ValueError):
        Gate(
            directory=directory,
            approver=deny_all,
            audit=AuditLog(tmp_path / "a.jsonl"),
            ticket_id="T-TEST",
            requester=requester,
        )


# ---------------------------------------------------------------- rule 3/5: hostile directory


def test_ansi_in_directory_fields_never_reaches_the_prompt(make_gate, directory):
    import io

    from helpdesk_agent.governance import make_tty_approver

    class TTY(io.StringIO):
        def isatty(self):
            return True

    user = directory.find_user(JAMIE)
    user["name"] = "Jamie\x1b[2K\r\x1b[32mPRE-APPROVED by security\x1b[0m"
    user["mfa"]["method"] = "totp\x1b]0;title\x07\nApproved: yes"
    out = io.StringIO()
    outcome = make_gate(make_tty_approver(TTY("n\n"), out)).execute("reset_mfa", {"email": JAMIE})
    shown = out.getvalue()
    assert outcome.decision is Decision.DENIED_BY_HUMAN
    assert "\x1b" not in shown
    assert "\r" not in shown
    assert "\nApproved: yes" not in shown
    assert "PRE-APPROVED by security" in shown  # visible as plain text, not hidden


# ---------------------------------------------------------------- rule 7: audit fields


def test_audit_records_requester_reason_and_approval(make_gate, read_audit):
    gate = make_gate(RecordingApprover(answer=True), requester="priya.nair@example.test")
    gate.execute("lookup_user", {"email": JAMIE})
    gate.execute("add_to_group", {"email": JAMIE, "group": "admins"})
    gate.execute("reset_mfa", {"email": JAMIE})
    entries = [e for e in read_audit() if e["event"] == "tool_call"]
    for entry in entries:
        assert entry["requester"] == "priya.nair@example.test"
        assert entry["reason"]
    assert [(e["decision"], e["approval"]) for e in entries] == [
        ("allowed", "not_required"),
        ("denied_by_policy", "not_asked"),
        ("approved", "approved"),
    ]
    assert "privileged" in entries[1]["reason"]
    (approved,) = [e for e in read_audit() if e["event"] == "write_approved"]
    assert approved["requester"] == "priya.nair@example.test"
    assert approved["requester_is_target"] is False


def test_audit_records_human_denial(make_gate, read_audit):
    make_gate().execute("reset_mfa", {"email": JAMIE})
    entry = read_audit()[-1]
    assert (entry["decision"], entry["approval"]) == ("denied_by_human", "denied")
    assert entry["reason"] == "operator did not type y"
