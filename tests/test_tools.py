import io

import pytest

from helpdesk_agent.governance import Proposal, make_tty_approver
from helpdesk_agent.tools import TOOLS, ToolKind, api_tool_definitions, display

EXPECTED = {
    "lookup_user": ToolKind.READ,
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
    assert display("Jamie\nApproved: yes\x1b[2J") == "Jamie Approved: yes [2J"


# ---------------------------------------------------------------- tty approver

PROPOSAL = Proposal("reset_mfa", {"email": "jamie@example.test"}, "Reset MFA for Jamie Rivera.")


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
