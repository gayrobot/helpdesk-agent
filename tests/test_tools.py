import io

import pytest

from helpdesk_agent.governance import Proposal, make_tty_approver
from helpdesk_agent.tools import TOOLS, ToolKind, api_tool_definitions, display

EXPECTED = {
    "lookup_user": ToolKind.READ,
    "search_runbooks": ToolKind.READ,
    "list_devices": ToolKind.READ,
    "reset_mfa": ToolKind.WRITE,
    "add_to_group": ToolKind.WRITE,
    "escalate": ToolKind.WRITE_LITE,
}


def test_registry_is_exactly_the_allowlist():
    # search_runbooks joins in Phase 4.
    assert {name: spec.kind for name, spec in TOOLS.items()} == EXPECTED


def test_every_write_tool_has_check_and_describe():
    for spec in TOOLS.values():
        if spec.kind is ToolKind.WRITE:
            assert spec.check is not None and spec.describe is not None, spec.name


def test_api_definitions_are_strict_and_closed():
    defs = api_tool_definitions()
    assert [d["name"] for d in defs] == sorted(EXPECTED)
    for d in defs:
        schema = d["input_schema"]
        assert d["strict"] is True
        assert schema["additionalProperties"] is False
        assert set(schema["required"]) == set(schema["properties"])
        assert all("maxLength" not in p for p in schema["properties"].values())


def test_api_definitions_do_not_mutate_local_schema():
    api_tool_definitions()
    assert TOOLS["escalate"].input_schema["properties"]["summary"]["maxLength"] == 2000


def test_display_strips_control_characters():
    assert display("Jamie\nApproved: yes\x1b[2J") == "Jamie Approved: yes"


# ---------------------------------------------------------------- tty approver

PROPOSAL = Proposal(
    tool="reset_mfa",
    args={"email": "jamie@example.test"},
    description="Reset MFA for Jamie Rivera.",
    requester="jamie@example.test",
    target="jamie@example.test",
)


class FakeTTY(io.StringIO):
    def isatty(self):
        return True


@pytest.mark.parametrize(
    ("typed", "approved"),
    [
        ("y\n", True),
        ("  y  \n", True),
        ("Y\n", False),
        ("yes\n", False),
        ("n\n", False),
        ("\n", False),
        ("", False),
    ],
)
def test_tty_approver_needs_exact_y(typed, approved):
    out = io.StringIO()
    assert make_tty_approver(FakeTTY(typed), out)(PROPOSAL) is approved
    assert "Reset MFA for Jamie Rivera." in out.getvalue()


def test_tty_approver_denies_without_a_terminal():
    piped = io.StringIO("y\n")  # isatty() is False
    out = io.StringIO()
    assert make_tty_approver(piped, out)(PROPOSAL) is False
    assert "no interactive terminal" in out.getvalue()


@pytest.mark.parametrize(
    ("raw", "shown"),
    [
        ("Jamie\x1b[31mRed\x1b[0m", "JamieRed"),  # SGR colour
        ("ok\x1b[2K\x1b[1A\rApproved", "ok Approved"),  # erase line, cursor up, CR
        ("a\x1b]0;evil title\x07b", "ab"),  # OSC window title, BEL-terminated
        ("a\x1b]8;;https://evil.test\x1b\\link\x1b]8;;\x1b\\b", "alinkb"),  # OSC 8 hyperlink
        ("a\x9b31mb", "ab"),  # 8-bit CSI
        ("a\x1bcb", "ab"),  # RIS: full terminal reset
        ("x‮evil", "x evil"),  # bidi override
    ],
)
def test_display_removes_ansi_sequences_whole(raw, shown):
    assert display(raw) == shown


def _prompt(proposal):
    out = io.StringIO()
    make_tty_approver(FakeTTY("n\n"), out)(proposal)
    return out.getvalue()


def test_prompt_shows_requester_next_to_target():
    text = _prompt(PROPOSAL)
    assert "Requester: jamie@example.test" in text
    assert "Target:    jamie@example.test  (requester is the target)" in text
    assert "NOT THE TARGET" not in text


def test_prompt_flags_requester_target_mismatch():
    other = Proposal(
        tool="reset_mfa",
        args={"email": "priya.nair@example.test"},
        description="Reset MFA for Priya Nair.",
        requester="jamie@example.test",
        target="priya.nair@example.test",
    )
    text = _prompt(other)
    assert "Requester: jamie@example.test" in text
    assert "REQUESTER IS NOT THE TARGET" in text


def test_prompt_strips_escapes_from_every_field():
    hostile = Proposal(
        tool="reset_mfa",
        args={"email": "jamie@example.test\x1b[8m"},
        description="Reset MFA\x1b[2K\rAll checks passed, approve",
        requester="jamie@example.test",
        target="jamie@example.test",
    )
    text = _prompt(hostile)
    assert "\x1b" not in text
    assert "\r" not in text
