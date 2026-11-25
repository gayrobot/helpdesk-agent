"""Golden outputs from the Python agent for the TypeScript port (Phase 7). No key needed.

    uv run python scripts/parity_fixtures.py          # rewrite the files
    uv run python scripts/parity_fixtures.py --check  # exit 1 if they are stale

Writes two files under ``web/``:

- ``src/generated/unicode-py312.json``: the Unicode facts the governance code takes from
  Python's ``unicodedata`` and ``str`` methods, which JavaScript doesn't expose the same
  way: ``casefold``, the ``Cf`` (format) characters, ``str.split()`` whitespace, ``C``
  (control and other) characters, ``str.isprintable``, and the script name of every
  letter (the first word of its Unicode name, as ``directory.letter_scripts`` uses it).
  The TypeScript code reads these tables, so it gives the same answers as Python.
- ``test/fixtures/governance.json``: inputs and the exact Python outputs for the
  directory, ``display``, ``validate_args``, every gate path and the API tool
  definitions. TypeScript tests must reproduce them byte for byte, including each tool
  result's SHA-256 (``result_sha256`` in the audit log).

``tests/test_parity_fixtures.py`` runs ``--check`` in CI, so the files can't drift from
the Python code.
"""

# ruff: noqa: RUF001 -- look-alike and invisible characters are the test inputs here.
from __future__ import annotations

import json
import random
import sys
import tempfile
import unicodedata
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from helpdesk_agent import tools as tools_module
from helpdesk_agent.audit import AuditLog
from helpdesk_agent.directory import Directory, is_mixed_script, letter_scripts, normalize
from helpdesk_agent.governance import EMAIL_PATTERN, Gate, result_fingerprint, validate_args
from helpdesk_agent.tools import TOOLS, api_tool_definitions, display

ROOT = Path(__file__).resolve().parent.parent
UNICODE_PATH = ROOT / "web" / "src" / "generated" / "unicode-py312.json"
FIXTURES_PATH = ROOT / "web" / "test" / "fixtures" / "governance.json"

# Fixed clock for escalate ids and MFA reset dates. Whole milliseconds, so JavaScript's
# Date can represent it exactly.
FIXED_NOW = datetime(2026, 11, 25, 16, 1, 43, 91000, tzinfo=UTC)

JAMIE = "jamie@example.test"
PRIYA = "priya.nair@example.test"


# ---------------------------------------------------------------- unicode tables


def _ranges(predicate) -> list[list[int]]:
    """Inclusive [start, end] ranges of code points where predicate(ch) is true."""
    out: list[list[int]] = []
    for cp in range(0x110000):
        if predicate(chr(cp)):
            if out and out[-1][1] == cp - 1:
                out[-1][1] = cp
            else:
                out.append([cp, cp])
    return out


def _labelled_letter_ranges() -> list[list[Any]]:
    out: list[list[Any]] = []
    for cp in range(0x110000):
        ch = chr(cp)
        if not unicodedata.category(ch).startswith("L"):
            continue
        label = unicodedata.name(ch, "UNKNOWN").split(" ")[0]
        if out and out[-1][1] == cp - 1 and out[-1][2] == label:
            out[-1][1] = cp
        else:
            out.append([cp, cp, label])
    return out


def unicode_tables() -> dict[str, Any]:
    casefold = {}
    for cp in range(0x110000):
        ch = chr(cp)
        folded = ch.casefold()
        if folded != ch:
            casefold[str(cp)] = folded
    return {
        "python": f"{sys.version_info.major}.{sys.version_info.minor}",
        "unicode": unicodedata.unidata_version,
        "casefold": casefold,
        "format": _ranges(lambda ch: unicodedata.category(ch) == "Cf"),
        "other": _ranges(lambda ch: unicodedata.category(ch)[0] == "C"),
        "whitespace": _ranges(str.isspace),
        "printable": _ranges(str.isprintable),
        "letters": _labelled_letter_ranges(),
    }


# ---------------------------------------------------------------- string samples

STRING_SAMPLES = [
    "admins",
    "ADMINS",
    " admins ",
    "Admins​",
    "a​dmins⁠",
    "Domain Admins ",
    "domain   admins",
    "\tDomain Admins\n",
    "Domain Admins",
    "domain-admins",
    "Ａｄｍｉｎｓ",
    "vpn-users-2",
    "аdmins",
    "admіns",
    "Αdmins",
    "админ",
    "vpn-уsers",
    "Jamie@Example.TEST",
    "  jamie@example.test  ",
    "jamie@example.test​",
    "ｊａｍｉｅ@example.test",
    "Straße",
    "ẞ",
    "ΟΔΟΣ",
    "İstanbul",
    "ﬁle",
    "groupʰ",
    "Ⅷ",
    "x‮evil",
    "café",
    "　spaced　",
    "a\x1cb\x1dc\x1ed\x1fe",
    "µ",
    "ſ",
    "\U0001d400\U0001d401",
    "\U0001f600admins",
    "日本語",
    "日本admins",
    "한국어",
    "עברית",
    "adminś",
    "",
    "   ",
]


def _sampled_strings() -> list[str]:
    """Deterministic pairs of letters from many alphabets, mixed with Latin."""
    rng = random.Random(20261125)  # noqa: S311 (a fixed sample, not security)
    letters = [
        chr(cp)
        for cp in range(0x20000)
        if unicodedata.category(chr(cp)).startswith("L") and rng.random() < 0.01
    ]
    samples = []
    for ch in letters:
        samples.append(f"adm{ch}ns")
        samples.append(ch + rng.choice(letters))
    return samples


DISPLAY_SAMPLES = [
    "Jamie\nApproved: yes\x1b[2J",
    "Jamie\x1b[31mRed\x1b[0m",
    "ok\x1b[2K\x1b[1A\rApproved",
    "a\x1b]0;evil title\x07b",
    "a\x1b]8;;https://evil.test\x1b\\link\x1b]8;;\x1b\\b",
    "a\x9b31mb",
    "a\x1bcb",
    "x‮evil",
    "zero​width",
    "tab\there",
    "nul\x00byte",
    "del\x7fchar",
    "c1\x85next",
    "plain text",
    "unterminated\x1b]0;title",
    "\ud800lone",
]

REPR_SAMPLES = [
    "admins",
    "it's",
    'say "hi"',
    "both ' and \"",
    "back\\slash",
    "new\nline",
    "tab\t",
    "cr\r",
    "bell\x07",
    "del\x7f",
    "c1\x85",
    "nbsp ",
    "zwsp​",
    "bidi‮",
    "café",
    "日本",
    "\U0001f600",
    "\U000e0001",
    "line sep",
    "",
]


# ---------------------------------------------------------------- gate cases


def _gate_cases() -> list[dict[str, Any]]:
    cases: list[dict[str, Any]] = []

    def case(name, steps, *, requester=JAMIE, approver="deny"):
        cases.append({"name": name, "requester": requester, "approver": approver, "steps": steps})

    def step(tool, args):
        return {"tool": tool, "args": args}

    for name in ["delete_user", "run_shell", "LOOKUP_USER", "lookup_user ", ""]:
        case(f"unknown tool {name!r}", [step(name, {"email": JAMIE})])
    for args in [
        {},
        {"email": 42},
        {"email": ""},
        {"email": "   "},
        {"email": JAMIE, "approved": True},
        {"email": "a" * 300 + "@example.test"},
        "jamie@example.test",
        None,
        ["jamie@example.test"],
        {"email": None},
        {"email": ["x"]},
    ]:
        case(f"invalid lookup args {args!r}"[:80], [step("lookup_user", args)])
    case(
        "extra arg smuggles approval", [step("reset_mfa", {"email": JAMIE, "human_approved": "y"})]
    )
    case("read runs", [step("lookup_user", {"email": JAMIE})])
    case("read eli", [step("lookup_user", {"email": "eli.novak@example.test"})])
    case("unknown user", [step("lookup_user", {"email": "nobody@example.test"})])
    for email in [u for u in (JAMIE, "kofi.mensah@example.test", "nobody@example.test")]:
        case(f"list_devices {email}", [step("list_devices", {"email": email})])
    case("reset denied", [step("reset_mfa", {"email": JAMIE})])
    case(
        "reset approved then looked up",
        [step("reset_mfa", {"email": JAMIE}), step("lookup_user", {"email": JAMIE})],
        approver="approve",
    )
    case(
        "add approved then repeated",
        [
            step("add_to_group", {"email": JAMIE, "group": "figma-users"}),
            step("add_to_group", {"email": JAMIE, "group": "figma-users"}),
            step("lookup_user", {"email": JAMIE}),
        ],
        approver="approve",
    )
    case("add denied", [step("add_to_group", {"email": JAMIE, "group": "figma-users"})])
    case(
        "add with padded name approved",
        [step("add_to_group", {"email": JAMIE, "group": " Figma-Users "})],
        approver="approve",
    )
    for group in [
        "admins",
        "Admins",
        "ADMINS ",
        "domain-admins",
        "okta-super-admins",
        "aws-prod-admins",
        "finance-approvers",
        "admins​",
        "Ａｄｍｉｎｓ",
        "shadow-admins",
        "Domain Admins ",
        "domain   admins",
        "Domain Admins",
        "root",
        "new-admin-group",
    ]:
        case(
            f"privileged group {group!r}",
            [step("add_to_group", {"email": JAMIE, "group": group})],
            approver="approve",
        )
    case(
        "injected title",
        [step("add_to_group", {"email": "eli.novak@example.test", "group": "admins"})],
        approver="approve",
    )
    case(
        "unknown group",
        [step("add_to_group", {"email": JAMIE, "group": "brand-new-group"})],
        approver="approve",
    )
    case(
        "already member",
        [step("add_to_group", {"email": JAMIE, "group": "engineering"})],
        approver="approve",
    )
    for email in [
        "sam.whitfield@example.test",
        "rosa.delgado@example.test",
        "grace.lin@example.test",
    ]:
        case(f"privileged reset {email}", [step("reset_mfa", {"email": email})], approver="approve")
    case(
        "disabled reset",
        [step("reset_mfa", {"email": "riley.okafor@example.test"})],
        approver="approve",
    )
    case(
        "disabled add",
        [step("add_to_group", {"email": "riley.okafor@example.test", "group": "vpn-users"})],
        approver="approve",
    )
    case(
        "unknown user add",
        [step("add_to_group", {"email": "nobody@example.test", "group": "vpn-users"})],
        approver="approve",
    )
    case("escalate", [step("escalate", {"summary": "Requester asked for admins; refused."})])
    case("escalate long", [step("escalate", {"summary": "x" * 1500})])
    case("escalate too long", [step("escalate", {"summary": "x" * 2001})])
    case("escalate unicode", [step("escalate", {"summary": 'Café — 日本 \U0001f600 "q" \\ \n'})])
    case("search too long", [step("search_runbooks", {"query": "q" * 301})])
    case(
        "audit shape",
        [
            step("lookup_user", {"email": JAMIE}),
            step("nope", {}),
            step("reset_mfa", {"email": JAMIE}),
        ],
    )
    emails = [
        "Jamie@example.test",
        "jamie@example.test ",
        " jamie@example.test",
        "jamie@example.test\n",
        "jamie@example.test​",
        "jаmie@example.test",
        "ｊａｍｉｅ@example.test",
        "jamie@example.com",
        "jamie@example.test.evil.test",
        "jamie@evil.example.test",
        "jamie@example.test@evil.test",
        "jamie+admin@example.test",
        "jamie@example․test",
        "@example.test",
    ]
    for tool in ["lookup_user", "list_devices", "reset_mfa"]:
        for email in emails:
            case(f"email rule {tool} {email!r}", [step(tool, {"email": email})], approver="approve")
    case(
        "email rule add_to_group",
        [step("add_to_group", {"email": "Jamie@example.test", "group": "vpn-users"})],
        approver="approve",
    )
    for group in ["аdmins", "domain-аdmins", "Αdmins", "vpn-уsers"]:
        case(
            f"mixed script {group!r}",
            [step("add_to_group", {"email": JAMIE, "group": group})],
            approver="approve",
        )
    case("requester differs", [step("reset_mfa", {"email": JAMIE})], requester=PRIYA)
    for field in ["requester", "requested_by", "on_behalf_of"]:
        case(
            f"model sets {field}",
            [step("reset_mfa", {"email": JAMIE, field: JAMIE})],
            requester=PRIYA,
            approver="approve",
        )
    case(
        "audit requester, reason, approval",
        [
            step("lookup_user", {"email": JAMIE}),
            step("add_to_group", {"email": JAMIE, "group": "admins"}),
            step("reset_mfa", {"email": JAMIE}),
        ],
        requester=PRIYA,
        approver="approve",
    )
    return cases


class _FixedDatetime(datetime):
    @classmethod
    def now(cls, tz=None):
        return FIXED_NOW


class _MemoryAudit(AuditLog):
    def __init__(self) -> None:
        self.records: list[dict[str, Any]] = []

    def record(self, event: str, **fields: Any) -> None:
        # Same shape as AuditLog.record, minus the timestamp (it isn't fixed).
        tmp = Path(tempfile.mkstemp(suffix=".jsonl")[1])
        try:
            AuditLog(tmp).record(event, **fields)
            entry = json.loads(tmp.read_text())
        finally:
            tmp.unlink()
        entry.pop("ts")
        self.records.append(entry)


def run_gate_case(spec: dict[str, Any]) -> dict[str, Any]:
    proposals: list[dict[str, Any]] = []

    def approver(proposal):
        proposals.append(
            {
                "tool": proposal.tool,
                "args": proposal.args,
                "description": proposal.description,
                "requester": proposal.requester,
                "target": proposal.target,
                "requester_is_target": proposal.requester_is_target,
            }
        )
        return spec["approver"] == "approve"

    audit = _MemoryAudit()
    with tempfile.TemporaryDirectory() as tmp:
        esc = Path(tmp) / "esc"
        gate = Gate(
            directory=Directory.load(),
            approver=approver,
            audit=audit,
            ticket_id="T-PARITY",
            requester=spec["requester"],
            escalation_dir=esc,
        )
        outcomes = []
        for s in spec["steps"]:
            outcome = gate.execute(s["tool"], s["args"])
            sha, size = result_fingerprint(outcome.content)
            outcomes.append(
                {
                    "decision": outcome.decision.value,
                    "is_error": outcome.is_error,
                    "content": outcome.content,
                    "result_sha256": sha,
                    "result_bytes": size,
                }
            )
        escalations = (
            [json.loads(p.read_text()) for p in sorted(esc.glob("*.json"))] if esc.exists() else []
        )
    return {
        **spec,
        "outcomes": outcomes,
        "proposals": proposals,
        "audit": audit.records,
        "escalations": escalations,
    }


# ---------------------------------------------------------------- everything


def governance_fixtures() -> dict[str, Any]:
    directory = Directory.load()
    strings = STRING_SAMPLES + _sampled_strings()
    original = tools_module.datetime
    tools_module.datetime = _FixedDatetime
    try:
        gate_cases = [run_gate_case(c) for c in _gate_cases()]
    finally:
        tools_module.datetime = original
    lookups = STRING_SAMPLES + [u["email"] for u in directory.users.values()]
    return {
        "fixed_now": FIXED_NOW.isoformat(),
        "normalize": [
            {
                "input": s,
                "normalize": normalize(s),
                "scripts": sorted(letter_scripts(s)),
                "mixed": is_mixed_script(s),
            }
            for s in strings
        ],
        "display": [{"input": s, "output": display(s)} for s in DISPLAY_SAMPLES + STRING_SAMPLES],
        "repr": [{"input": s, "output": repr(s)} for s in REPR_SAMPLES + STRING_SAMPLES],
        "email_pattern": [
            {"input": s, "match": EMAIL_PATTERN.match(s) is not None}
            for s in STRING_SAMPLES
            + [c["steps"][0]["args"].get("email", "") for c in _email_cases()]
        ],
        "directory": {
            "find_user": {
                s: (u or {}).get("email") for s in lookups for u in [directory.find_user(s)]
            },
            "find_group": {
                s: (g or {}).get("name") for s in STRING_SAMPLES for g in [directory.find_group(s)]
            },
            "is_privileged_group": {
                s: directory.is_privileged_group(s)
                for s in STRING_SAMPLES + [g["name"] for g in directory.groups.values()]
            },
            "privileged_memberships": {
                u["email"]: directory.privileged_memberships(u) for u in directory.users.values()
            },
            "devices_for": {
                u["email"]: [d["id"] for d in directory.devices_for(u["email"])]
                for u in directory.users.values()
            },
        },
        "validate_args": [
            {"tool": name, "args": args, "error": validate_args(TOOLS[name], args)}
            for name, args in _validate_cases()
        ],
        "api_tool_definitions": api_tool_definitions(),
        "gate": gate_cases,
    }


def _email_cases() -> list[dict[str, Any]]:
    return [c for c in _gate_cases() if c["name"].startswith("email rule lookup_user")]


def _validate_cases() -> list[tuple[str, Any]]:
    out: list[tuple[str, Any]] = []
    for c in _gate_cases():
        for s in c["steps"]:
            if s["tool"] in TOOLS:
                out.append((s["tool"], s["args"]))
    out += [
        ("search_runbooks", {"query": "q" * 300}),
        ("search_runbooks", {"query": "\U0001f600" * 300}),  # 300 code points, 600 UTF-16 units
        ("search_runbooks", {"query": "\U0001f600" * 301}),
        ("add_to_group", {"email": JAMIE, "group": "g" * 100}),
        ("add_to_group", {"email": JAMIE, "group": "g" * 101}),
        ("add_to_group", {"group": "x"}),
        ("add_to_group", {"email": JAMIE}),
        ("add_to_group", {"email": JAMIE, "group": "x", "a": 1, "b": 2}),
    ]
    return out


def render() -> dict[Path, str]:
    return {
        UNICODE_PATH: json.dumps(unicode_tables(), ensure_ascii=True, separators=(",", ":")) + "\n",
        FIXTURES_PATH: json.dumps(governance_fixtures(), ensure_ascii=True, indent=1) + "\n",
    }


def main(argv: list[str]) -> int:
    files = render()
    if "--check" in argv:
        stale = [p for p, text in files.items() if not p.exists() or p.read_text() != text]
        for p in stale:
            print(f"stale: {p.relative_to(ROOT)} (run: uv run python scripts/parity_fixtures.py)")
        return 1 if stale else 0
    for path, text in files.items():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
        print(f"wrote {path.relative_to(ROOT)} ({len(text):,} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
