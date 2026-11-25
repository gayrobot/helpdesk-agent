// Twin of tests/test_governance.py: every governance rule, including attempts to get
// around it. Test names match the Python ones.
//
// Adapted, with reason:
// - test_gate_refuses_a_malformed_requester: Python raises ValueError, TypeScript throws
//   TypeError; the cases are the same.
// - test_audit_failure_blocks_the_write: Python makes the log path unwritable; here the
//   audit sink rejects. Same rule: no audit record, no write.
// - test_ansi_in_directory_fields_never_reaches_the_prompt: Python reads the terminal
//   prompt; there is no terminal here, so the test reads the proposal the approver gets,
//   which is what the web page shows.
// - test_escalate_writes_ticket_without_approval: the escalation goes to the injected
//   store instead of a file.
import assert from "node:assert/strict";
import { test } from "node:test";

import { MemoryAudit } from "../src/audit.ts";
import { Directory } from "../src/directory.ts";
import { DENIED_BY_HUMAN, Decision, denyAll, Gate, resultFingerprint } from "../src/governance.ts";
import { TOOLS } from "../src/tools.ts";
import {
  FIXED_NOW,
  JAMIE,
  MemoryEscalations,
  makeGate,
  RecordingApprover,
  StubRetriever,
} from "./helpers.ts";

const PRIYA = "priya.nair@example.test";
const mfaEnrolled = (d: Directory, email = JAMIE) => d.findUser(email)?.mfa.enrolled;
const last = <T>(xs: T[]): T => xs[xs.length - 1] as T;

// ---------------------------------------------------------------- allowlist

for (const name of ["delete_user", "run_shell", "LOOKUP_USER", "lookup_user ", ""]) {
  test(`test_unknown_tools_are_rejected_and_audited[${JSON.stringify(name)}]`, async () => {
    const { gate, audit } = makeGate();
    const outcome = await gate.execute(name, { email: JAMIE });
    assert.equal(outcome.decision, Decision.UNKNOWN_TOOL);
    assert.ok(outcome.isError);
    assert.equal(last(audit.records).decision, "unknown_tool");
  });
}

// ---------------------------------------------------------------- input validation

for (const args of [
  {},
  { email: 42 },
  { email: "" },
  { email: "   " },
  { email: JAMIE, approved: true },
  { email: `${"a".repeat(300)}@example.test` },
  "jamie@example.test",
  null,
]) {
  test(`test_invalid_arguments_rejected[${JSON.stringify(args)?.slice(0, 40)}]`, async () => {
    const outcome = await makeGate().gate.execute("lookup_user", args);
    assert.equal(outcome.decision, Decision.INVALID_INPUT);
    assert.ok(outcome.isError);
  });
}

test("test_extra_argument_cannot_smuggle_approval", async () => {
  const approver = new RecordingApprover(false);
  const { gate, directory } = makeGate({ approver: approver.approve });
  const outcome = await gate.execute("reset_mfa", { email: JAMIE, human_approved: "y" });
  assert.equal(outcome.decision, Decision.INVALID_INPUT);
  assert.deepEqual(approver.proposals, []);
  assert.equal(mfaEnrolled(directory), true);
});

// ---------------------------------------------------------------- reads

test("test_read_tool_runs_without_approval", async () => {
  const approver = new RecordingApprover(false);
  const { gate, audit } = makeGate({ approver: approver.approve });
  const outcome = await gate.execute("lookup_user", { email: JAMIE });
  assert.equal(outcome.decision, Decision.ALLOWED);
  assert.equal(JSON.parse(outcome.content).name, "Jamie Rivera");
  assert.deepEqual(approver.proposals, []);
  assert.equal(last(audit.records).kind, "read");
  assert.equal(last(audit.records).decision, "allowed");
});

test("test_lookup_unknown_user_is_a_tool_error", async () => {
  const outcome = await makeGate().gate.execute("lookup_user", { email: "nobody@example.test" });
  assert.equal(outcome.decision, Decision.TOOL_ERROR);
  assert.ok(outcome.isError);
});

test("test_list_devices", async () => {
  const outcome = await makeGate().gate.execute("list_devices", {
    email: "kofi.mensah@example.test",
  });
  const devices = JSON.parse(outcome.content).devices;
  assert.ok(devices.length > 0 && devices[0].compliant === false);
});

// ---------------------------------------------------------------- write gate

test("test_write_denied_by_human_changes_nothing", async () => {
  const approver = new RecordingApprover(false);
  const { gate, directory, audit } = makeGate({ approver: approver.approve });
  const outcome = await gate.execute("reset_mfa", { email: JAMIE });
  assert.equal(outcome.decision, Decision.DENIED_BY_HUMAN);
  assert.equal(outcome.content, DENIED_BY_HUMAN);
  assert.equal(approver.proposals.length, 1);
  assert.equal(mfaEnrolled(directory), true);
  assert.deepEqual(
    audit.records.map((e) => e.event),
    ["tool_call"],
  );
  assert.equal(last(audit.records).decision, "denied_by_human");
});

test("test_write_approved_runs_and_is_audited_before_acting", async () => {
  const approver = new RecordingApprover(true);
  const { gate, directory, audit } = makeGate({ approver: approver.approve });
  const outcome = await gate.execute("reset_mfa", { email: JAMIE });
  assert.equal(outcome.decision, Decision.APPROVED);
  assert.ok(!outcome.isError);
  assert.equal(mfaEnrolled(directory), false);
  assert.deepEqual(
    audit.records.map((e) => e.event),
    ["write_approved", "tool_call"],
  );
  assert.ok(String(audit.records[0]?.effect).includes("Jamie Rivera"));
});

test("test_proposal_describes_exactly_what_will_happen", async () => {
  const approver = new RecordingApprover(false);
  await makeGate({ approver: approver.approve }).gate.execute("add_to_group", {
    email: JAMIE,
    group: "figma-users",
  });
  assert.equal(approver.proposals.length, 1);
  const [proposal] = approver.proposals;
  assert.ok(proposal);
  assert.equal(proposal.tool, "add_to_group");
  assert.deepEqual(proposal.args, { email: JAMIE, group: "figma-users" });
  assert.ok(proposal.description.includes("Jamie Rivera"));
  assert.ok(proposal.description.includes("figma-users"));
});

for (const answer of [1, "y", "yes", null, {}, "true", [true]]) {
  test(`test_only_literal_true_from_approver_counts[${JSON.stringify(answer)}]`, async () => {
    const { gate, directory } = makeGate({ approver: async () => answer });
    const outcome = await gate.execute("reset_mfa", { email: JAMIE });
    assert.equal(outcome.decision, Decision.DENIED_BY_HUMAN);
    assert.equal(mfaEnrolled(directory), true);
  });
}

test("test_approver_exception_fails_closed", async () => {
  for (const approver of [
    () => {
      throw new Error("terminal went away");
    },
    async () => {
      throw new Error("page went away");
    },
  ]) {
    const { gate, directory } = makeGate({ approver });
    const outcome = await gate.execute("reset_mfa", { email: JAMIE });
    assert.equal(outcome.decision, Decision.INTERNAL_ERROR);
    assert.equal(mfaEnrolled(directory), true);
  }
});

test("test_deny_all_is_the_eval_default", async () => {
  const { gate, directory } = makeGate({ approver: denyAll });
  const outcome = await gate.execute("add_to_group", { email: JAMIE, group: "figma-users" });
  assert.equal(outcome.decision, Decision.DENIED_BY_HUMAN);
  assert.ok(!directory.findUser(JAMIE)?.groups.includes("figma-users"));
});

test("test_audit_failure_blocks_the_write", async () => {
  const directory = Directory.load();
  const gate = new Gate({
    directory,
    approver: async () => true,
    audit: {
      record: async () => {
        throw new Error("disk full");
      },
    },
    escalations: new MemoryEscalations(),
    retriever: new StubRetriever(),
    ticketId: "T-TEST",
    requester: JAMIE,
  });
  await assert.rejects(gate.execute("reset_mfa", { email: JAMIE }), /disk full/);
  assert.equal(mfaEnrolled(directory), true);
});

// ---------------------------------------------------------------- deny list

for (const group of [
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
]) {
  test(`test_privileged_groups_refused_even_when_human_would_approve[${JSON.stringify(group)}]`, async () => {
    const approver = new RecordingApprover(true);
    const { gate, directory } = makeGate({ approver: approver.approve });
    const outcome = await gate.execute("add_to_group", { email: JAMIE, group });
    assert.equal(outcome.decision, Decision.DENIED_BY_POLICY);
    assert.deepEqual(approver.proposals, [], "the human must never be asked");
    const jamie = directory.findUser(JAMIE);
    assert.ok(jamie);
    assert.deepEqual(directory.privilegedMemberships(jamie), []);
  });
}

test("test_injected_title_does_not_unlock_admins", async () => {
  const approver = new RecordingApprover(true);
  const outcome = await makeGate({ approver: approver.approve }).gate.execute("add_to_group", {
    email: "eli.novak@example.test",
    group: "admins",
  });
  assert.equal(outcome.decision, Decision.DENIED_BY_POLICY);
  assert.deepEqual(approver.proposals, []);
});

test("test_unknown_group_is_an_error_not_a_create", async () => {
  const approver = new RecordingApprover(true);
  const { gate, directory } = makeGate({ approver: approver.approve });
  const outcome = await gate.execute("add_to_group", { email: JAMIE, group: "brand-new-group" });
  assert.equal(outcome.decision, Decision.TOOL_ERROR);
  assert.deepEqual(approver.proposals, []);
  assert.equal(directory.findGroup("brand-new-group"), null);
});

test("test_already_member_is_an_error_without_prompt", async () => {
  const approver = new RecordingApprover(true);
  const outcome = await makeGate({ approver: approver.approve }).gate.execute("add_to_group", {
    email: JAMIE,
    group: "engineering",
  });
  assert.equal(outcome.decision, Decision.TOOL_ERROR);
  assert.deepEqual(approver.proposals, []);
});

for (const email of [
  "sam.whitfield@example.test",
  "rosa.delgado@example.test",
  "grace.lin@example.test",
]) {
  test(`test_mfa_reset_refused_for_privileged_accounts[${email}]`, async () => {
    const approver = new RecordingApprover(true);
    const { gate, directory } = makeGate({ approver: approver.approve });
    const outcome = await gate.execute("reset_mfa", { email });
    assert.equal(outcome.decision, Decision.DENIED_BY_POLICY);
    assert.deepEqual(approver.proposals, []);
    assert.equal(mfaEnrolled(directory, email), true);
  });
}

for (const [tool, args] of [
  ["reset_mfa", { email: "riley.okafor@example.test" }],
  ["add_to_group", { email: "riley.okafor@example.test", group: "vpn-users" }],
] as const) {
  test(`test_writes_refused_for_disabled_accounts[${tool}]`, async () => {
    const approver = new RecordingApprover(true);
    const outcome = await makeGate({ approver: approver.approve }).gate.execute(tool, args);
    assert.equal(outcome.decision, Decision.DENIED_BY_POLICY);
    assert.deepEqual(approver.proposals, []);
  });
}

// ---------------------------------------------------------------- escalate

test("test_escalate_writes_ticket_without_approval", async () => {
  const approver = new RecordingApprover(false);
  const { gate, escalations } = makeGate({ approver: approver.approve });
  const outcome = await gate.execute("escalate", {
    summary: "Requester asked for admins; refused by policy.",
  });
  assert.equal(outcome.decision, Decision.ALLOWED);
  const ticket = JSON.parse(outcome.content).ticket;
  const [saved] = escalations.saved;
  assert.equal(saved?.id, ticket);
  assert.equal(saved?.source_ticket, "T-TEST");
  assert.deepEqual(approver.proposals, []);
});

// ---------------------------------------------------------------- audit shape

test("test_audit_lines_are_json_with_required_fields", async () => {
  const { gate, audit } = makeGate();
  await gate.execute("lookup_user", { email: JAMIE });
  await gate.execute("nope", {});
  await gate.execute("reset_mfa", { email: JAMIE });
  const required = [
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
  ];
  for (const entry of audit.records) {
    for (const key of required) assert.ok(key in entry, key);
    assert.doesNotThrow(() => JSON.parse(JSON.stringify(entry)));
  }
  assert.deepEqual(
    audit.records.map((e) => e.decision),
    ["allowed", "unknown_tool", "denied_by_human"],
  );
});

test("test_audit_truncates_long_values", async () => {
  const { gate, audit } = makeGate();
  await gate.execute("escalate", { summary: "x".repeat(1500) });
  const args = last(audit.records).args as { summary: string };
  assert.ok(args.summary.length < 400);
});

// ---------------------------------------------------------------- rule 2: email format

const BAD_EMAILS = [
  "Jamie@example.test", // uppercase
  "jamie@example.test ", // trailing space
  " jamie@example.test", // leading space
  "jamie@example.test\n", // trailing newline
  "jamie@example.test​", // zero-width space
  "jаmie@example.test", // Cyrillic a
  "ｊａｍｉｅ@example.test", // fullwidth
  "jamie@example.com", // other domain
  "jamie@example.test.evil.test", // suffix trick
  "jamie@evil.example.test", // subdomain
  "jamie@example.test@evil.test",
  "jamie+admin@example.test", // plus addressing
  "jamie@example․test", // one-dot leader instead of '.'
  "@example.test",
];

for (const tool of ["lookup_user", "list_devices", "reset_mfa"]) {
  for (const email of BAD_EMAILS) {
    test(`test_email_must_match_the_strict_pattern[${tool}-${JSON.stringify(email)}]`, async () => {
      const approver = new RecordingApprover(true);
      const { gate, audit } = makeGate({ approver: approver.approve });
      const outcome = await gate.execute(tool, { email });
      assert.equal(outcome.decision, Decision.INVALID_INPUT);
      assert.ok(outcome.content.includes("example.test"));
      assert.deepEqual(approver.proposals, []);
      assert.equal(last(audit.records).approval, "not_asked");
    });
  }
}

test("test_email_rule_applies_to_add_to_group", async () => {
  const approver = new RecordingApprover(true);
  const outcome = await makeGate({ approver: approver.approve }).gate.execute("add_to_group", {
    email: "Jamie@example.test",
    group: "vpn-users",
  });
  assert.equal(outcome.decision, Decision.INVALID_INPUT);
  assert.deepEqual(approver.proposals, []);
});

// ---------------------------------------------------------------- rule 4: mixed scripts

for (const group of ["аdmins", "domain-аdmins", "Αdmins", "vpn-уsers"]) {
  test(`test_mixed_script_group_rejected_before_deny_check[${JSON.stringify(group)}]`, async () => {
    const approver = new RecordingApprover(true);
    const { gate, directory, audit } = makeGate({ approver: approver.approve });
    const outcome = await gate.execute("add_to_group", { email: JAMIE, group });
    assert.equal(outcome.decision, Decision.INVALID_INPUT);
    assert.ok(outcome.content.includes("alphabets"));
    assert.deepEqual(approver.proposals, []);
    const jamie = directory.findUser(JAMIE);
    assert.ok(jamie);
    assert.deepEqual(directory.privilegedMemberships(jamie), []);
    assert.equal(last(audit.records).decision, "invalid_input");
  });
}

for (const group of ["Domain Admins ", "domain   admins", "Domain Admins"]) {
  test(`test_padded_privileged_names_denied_by_policy[${JSON.stringify(group)}]`, async () => {
    const approver = new RecordingApprover(true);
    const outcome = await makeGate({ approver: approver.approve }).gate.execute("add_to_group", {
      email: JAMIE,
      group,
    });
    assert.equal(outcome.decision, Decision.DENIED_BY_POLICY);
    assert.deepEqual(approver.proposals, []);
  });
}

// ---------------------------------------------------------------- rule 9: requester

test("test_requester_comes_from_the_harness", async () => {
  const approver = new RecordingApprover(false);
  await makeGate({ approver: approver.approve, requester: PRIYA }).gate.execute("reset_mfa", {
    email: JAMIE,
  });
  const [proposal] = approver.proposals;
  assert.equal(approver.proposals.length, 1);
  assert.equal(proposal?.requester, PRIYA);
  assert.equal(proposal?.target, JAMIE);
  assert.equal(proposal?.requesterIsTarget, false);
});

test("test_requester_matching_target_is_recognised", async () => {
  const approver = new RecordingApprover(false);
  await makeGate({ approver: approver.approve }).gate.execute("reset_mfa", { email: JAMIE });
  assert.equal(approver.proposals[0]?.requesterIsTarget, true);
});

for (const field of ["requester", "requested_by", "on_behalf_of"]) {
  test(`test_model_cannot_set_the_requester[${field}]`, async () => {
    const approver = new RecordingApprover(true);
    const outcome = await makeGate({ approver: approver.approve, requester: PRIYA }).gate.execute(
      "reset_mfa",
      { email: JAMIE, [field]: JAMIE },
    );
    assert.equal(outcome.decision, Decision.INVALID_INPUT);
    assert.deepEqual(approver.proposals, []);
  });
}

test("test_no_tool_schema_has_a_requester_field", () => {
  for (const spec of TOOLS.values()) {
    assert.ok(!Object.keys(spec.inputSchema.properties).some((k) => k.includes("request")));
  }
});

for (const requester of [
  "",
  "Jamie@example.test",
  "jamie@example.com",
  "jamie@example.test ",
  null,
]) {
  test(`test_gate_refuses_a_malformed_requester[${JSON.stringify(requester)}]`, () => {
    assert.throws(
      () =>
        new Gate({
          directory: Directory.load(),
          approver: denyAll,
          audit: new MemoryAudit(),
          escalations: new MemoryEscalations(),
          retriever: new StubRetriever(),
          ticketId: "T-TEST",
          requester: requester as string,
        }),
      TypeError,
    );
  });
}

// ---------------------------------------------------------------- rule 3/5: hostile directory

test("test_ansi_in_directory_fields_never_reaches_the_prompt", async () => {
  const approver = new RecordingApprover(false);
  const { gate, directory } = makeGate({ approver: approver.approve });
  const user = directory.findUser(JAMIE);
  assert.ok(user);
  user.name = "Jamie\x1b[2K\r\x1b[32mPRE-APPROVED by security\x1b[0m";
  user.mfa.method = "totp\x1b]0;title\x07\nApproved: yes";
  const outcome = await gate.execute("reset_mfa", { email: JAMIE });
  const shown = approver.proposals[0]?.description ?? "";
  assert.equal(outcome.decision, Decision.DENIED_BY_HUMAN);
  assert.ok(!shown.includes("\x1b"));
  assert.ok(!shown.includes("\r"));
  assert.ok(!shown.includes("\nApproved: yes"));
  assert.ok(shown.includes("PRE-APPROVED by security")); // visible as plain text, not hidden
});

// ---------------------------------------------------------------- rule 7: audit fields

test("test_audit_records_requester_reason_and_approval", async () => {
  const { gate, audit } = makeGate({
    approver: new RecordingApprover(true).approve,
    requester: PRIYA,
  });
  await gate.execute("lookup_user", { email: JAMIE });
  await gate.execute("add_to_group", { email: JAMIE, group: "admins" });
  await gate.execute("reset_mfa", { email: JAMIE });
  const entries = audit.records.filter((e) => e.event === "tool_call");
  for (const entry of entries) {
    assert.equal(entry.requester, PRIYA);
    assert.ok(entry.reason);
  }
  assert.deepEqual(
    entries.map((e) => [e.decision, e.approval]),
    [
      ["allowed", "not_required"],
      ["denied_by_policy", "not_asked"],
      ["approved", "approved"],
    ],
  );
  assert.ok(String(entries[1]?.reason).includes("privileged"));
  const approved = audit.records.filter((e) => e.event === "write_approved");
  assert.equal(approved.length, 1);
  assert.equal(approved[0]?.requester, PRIYA);
  assert.equal(approved[0]?.requester_is_target, false);
});

test("test_audit_records_human_denial", async () => {
  const { gate, audit } = makeGate();
  await gate.execute("reset_mfa", { email: JAMIE });
  const entry = last(audit.records);
  assert.deepEqual([entry.decision, entry.approval], ["denied_by_human", "denied"]);
  assert.equal(entry.reason, "operator did not type y");
});

test("test_audit_fingerprints_the_exact_result_sent_to_the_model", async () => {
  const { gate, audit } = makeGate();
  const outcomes = [
    await gate.execute("lookup_user", { email: "eli.novak@example.test" }),
    await gate.execute("nope", {}),
    await gate.execute("reset_mfa", { email: JAMIE }),
  ];
  assert.equal(audit.records.length, outcomes.length);
  for (const [i, outcome] of outcomes.entries()) {
    const entry = audit.records[i];
    assert.deepEqual(
      [entry?.result_sha256, entry?.result_bytes],
      await resultFingerprint(outcome.content),
    );
  }
  assert.ok(outcomes[0]?.content.includes("NOTE TO AI ASSISTANT"));
  assert.ok(!JSON.stringify(audit.records[0]).includes("NOTE TO AI ASSISTANT"));
});

// ---------------------------------------------------------------- TypeScript only

test("ts_audit_timestamps_use_the_injected_clock", async () => {
  const { gate, audit } = makeGate();
  await gate.execute("lookup_user", { email: JAMIE });
  assert.equal(last(audit.records).ts, "2026-11-25T16:01:43.091+00:00");
  assert.equal(FIXED_NOW.toISOString(), "2026-11-25T16:01:43.091Z");
});

test("ts_audit_sink_failure_on_a_read_propagates", async () => {
  // Python: AuditLog.record raises and the exception reaches the agent loop. Same here.
  const gate = new Gate({
    directory: Directory.load(),
    approver: denyAll,
    audit: { record: async () => Promise.reject(new Error("audit down")) },
    escalations: new MemoryEscalations(),
    retriever: new StubRetriever(),
    ticketId: "T-TEST",
    requester: JAMIE,
  });
  await assert.rejects(gate.execute("lookup_user", { email: JAMIE }), /audit down/);
});

test("ts_escalation_ids_are_unique_within_a_millisecond", async () => {
  // JavaScript clocks stop at milliseconds; a per-gate counter fills the last 3 digits.
  const { gate, escalations } = makeGate();
  const ids = [];
  for (const summary of ["one", "two", "three"]) {
    ids.push(JSON.parse((await gate.execute("escalate", { summary })).content).ticket);
  }
  assert.deepEqual(ids, [
    "ESC-20261125-160143091000",
    "ESC-20261125-160143091001",
    "ESC-20261125-160143091002",
  ]);
  assert.deepEqual(
    escalations.saved.map((r) => r.id),
    ids,
  );
});
