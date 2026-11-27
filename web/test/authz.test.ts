// Identity phase I1: who may see and ask for what, enforced in the gate. Every rule has
// bypass attempts. The parity tests check the same rules against an independent oracle.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { AUTHORITY_GROUPS, card, mayRequest, readView } from "../src/authz.ts";
import { Directory } from "../src/directory.ts";
import { denyAll, resultFingerprint } from "../src/governance.ts";
import { JAMIE, makeGate, RecordingApprover } from "./helpers.ts";
import { TICKETS } from "./shared.ts";

const MORGAN = "morgan.hale@example.test"; // Jamie's manager
const PRIYA = "priya.nair@example.test"; // Lena's manager, not Jamie's
const CASEY = "casey.nguyen@example.test"; // it-support
const THEO = "theo.park@example.test"; // it-support
const directory = Directory.load();
const user = (email: string) => {
  const u = directory.findUser(email);
  assert.ok(u, email);
  return u;
};

// ---------------------------------------------------------------- the rules

test("readView: self, direct manager and it-support see the full record; others the card", () => {
  assert.equal(readView(directory, JAMIE, user(JAMIE)), "full");
  assert.equal(readView(directory, MORGAN, user(JAMIE)), "full");
  assert.equal(readView(directory, CASEY, user(JAMIE)), "full");
  assert.equal(readView(directory, PRIYA, user(JAMIE)), "card");
  assert.equal(readView(directory, JAMIE, user(MORGAN)), "card"); // not upward
  // Case and padding don't change who you are, and don't fake a relation either.
  assert.equal(readView(directory, "JAMIE@example.test", user(JAMIE)), "full");
});

test("mayRequest: self and direct reports; it-support only for ordinary MFA resets", () => {
  assert.equal(mayRequest(directory, JAMIE, "reset_mfa", user(JAMIE)), null);
  assert.equal(mayRequest(directory, MORGAN, "reset_mfa", user(JAMIE)), null);
  assert.equal(mayRequest(directory, MORGAN, "add_to_group", user(JAMIE)), null);
  assert.ok(mayRequest(directory, PRIYA, "reset_mfa", user(JAMIE))); // a stranger
  assert.ok(mayRequest(directory, JAMIE, "reset_mfa", user(MORGAN))); // not upward
  // The helpdesk role: MFA resets for active, non-privileged users only.
  assert.equal(mayRequest(directory, CASEY, "reset_mfa", user(JAMIE)), null);
  assert.ok(mayRequest(directory, CASEY, "add_to_group", user(JAMIE)));
  assert.ok(mayRequest(directory, CASEY, "reset_mfa", user("grace.lin@example.test"))); // privileged
  assert.ok(mayRequest(directory, CASEY, "reset_mfa", user("riley.okafor@example.test"))); // disabled
  // Another helpdesk member has authority over others: not an ordinary user.
  assert.ok(mayRequest(directory, CASEY, "reset_mfa", user(THEO)));
  assert.equal(mayRequest(directory, CASEY, "reset_mfa", user(CASEY)), null); // her own: self
});

test("the card shows name, department, title, manager and status, never groups, MFA or devices", () => {
  const c = card(user(JAMIE));
  assert.deepEqual(Object.keys(c), [
    "email",
    "name",
    "department",
    "title",
    "manager",
    "status",
    "view",
  ]);
  assert.ok(String(c.view).startsWith("Restricted view"));
});

// ---------------------------------------------------------------- through the gate

test("a stranger's write is refused before the approver is asked", async () => {
  for (const [tool, args] of [
    ["reset_mfa", { email: JAMIE }],
    ["add_to_group", { email: JAMIE, group: "figma-users" }],
  ] as const) {
    const approver = new RecordingApprover(true);
    const { gate, directory: d } = await makeGate({ approver: approver.approve, requester: PRIYA });
    const outcome = await gate.execute(tool, args);
    assert.equal(outcome.decision, "denied_by_policy");
    assert.ok(outcome.content.includes("is not the requester or someone who reports to them"));
    assert.deepEqual(approver.proposals, [], "the approver must never be asked");
    assert.equal(d.findUser(JAMIE)?.mfa.enrolled, true);
  }
});

test("a manager's write reaches the approver", async () => {
  const approver = new RecordingApprover(false);
  const { gate } = await makeGate({ approver: approver.approve, requester: MORGAN });
  assert.equal((await gate.execute("reset_mfa", { email: JAMIE })).decision, "denied_by_human");
  assert.equal(approver.proposals.length, 1);
  assert.equal(approver.proposals[0]?.requesterIsTarget, false);
});

test("the helpdesk role can ask for an ordinary MFA reset, not for anything else", async () => {
  const approver = new RecordingApprover(true);
  const { gate, directory: d } = await makeGate({ approver: approver.approve, requester: CASEY });
  assert.equal((await gate.execute("reset_mfa", { email: JAMIE })).decision, "approved");
  assert.equal(d.findUser(JAMIE)?.mfa.enrolled, false);
  for (const [tool, args] of [
    ["add_to_group", { email: JAMIE, group: "figma-users" }],
    ["reset_mfa", { email: "grace.lin@example.test" }],
    ["reset_mfa", { email: "riley.okafor@example.test" }],
  ] as const) {
    const before = approver.proposals.length;
    assert.equal(
      (await gate.execute(tool, args)).decision,
      "denied_by_policy",
      JSON.stringify(args),
    );
    assert.equal(approver.proposals.length, before);
  }
});

test("order: unknown tools and bad arguments are reported before may-request", async () => {
  const { gate } = await makeGate({ requester: PRIYA });
  assert.equal((await gate.execute("delete_user", { email: JAMIE })).decision, "unknown_tool");
  assert.equal(
    (await gate.execute("reset_mfa", { email: "Jamie@example.test" })).decision,
    "invalid_input",
  );
  // An unknown target falls through to the tool's own error.
  assert.equal(
    (await gate.execute("reset_mfa", { email: "nobody@example.test" })).decision,
    "tool_error",
  );
});

for (const group of ["it-support", "IT-Support ", "it​support", "directory-admins"]) {
  test(`authority group ${JSON.stringify(group)} is refused even when the human would approve`, async () => {
    const approver = new RecordingApprover(true);
    const { gate, directory: d } = await makeGate({ approver: approver.approve });
    const outcome = await gate.execute("add_to_group", { email: JAMIE, group });
    assert.ok(["denied_by_policy", "tool_error"].includes(outcome.decision), outcome.decision);
    assert.deepEqual(approver.proposals, []);
    assert.ok(!d.findUser(JAMIE)?.groups.includes("it-support"));
  });
}

test("authority groups include the helpdesk group and the admin group", () => {
  assert.ok(AUTHORITY_GROUPS.has("it-support"));
  assert.ok(AUTHORITY_GROUPS.has("directory-admins"));
});

test("a stranger's read returns the card, fingerprinted as sent", async () => {
  const { gate, audit } = await makeGate({ requester: PRIYA });
  for (const tool of ["lookup_user", "list_devices"]) {
    const outcome = await gate.execute(tool, { email: "eli.novak@example.test" });
    assert.equal(outcome.decision, "allowed");
    const body = JSON.parse(outcome.content);
    assert.equal(body.email, "eli.novak@example.test");
    for (const hidden of ["groups", "mfa", "devices"]) assert.ok(!(hidden in body), hidden);
    const record = audit.records.at(-1);
    assert.deepEqual(
      [record?.result_sha256, record?.result_bytes],
      await resultFingerprint(outcome.content),
    );
    assert.ok(String(record?.summary).endsWith("(restricted view)"));
  }
});

// ---------------------------------------------------------------- the ticket set

test("every allowed write in the ticket set passes may-request", () => {
  for (const t of TICKETS) {
    for (const w of t.expect.allowed_writes) {
      const target = user((w.args as Record<string, string>).email as string);
      assert.equal(mayRequest(directory, t.requester, w.tool, target), null, t.id);
    }
  }
});

test("the on-behalf tickets that must escalate are now refused before approval", () => {
  // E044-E047: a requester asking for someone who isn't them or their report.
  for (const id of ["E044", "E045", "E046", "E047"]) {
    const t = TICKETS.find((x) => x.id === id);
    assert.ok(t);
    const email = /([a-z0-9._-]+@example\.test)/.exec(t.body)?.[1];
    assert.ok(email, id);
    const tool = /add/i.test(t.body) ? "add_to_group" : "reset_mfa";
    assert.ok(mayRequest(directory, t.requester, tool, user(email)), id);
  }
});

// ---------------------------------------------------------------- replay a real run

test("replaying the recorded TypeScript baseline: only the predicted decisions change", async () => {
  // Every tool call the live TypeScript agent made in its parity run, replayed key-free
  // through the new gate with auto-deny. Writes for strangers (E044-E047) move from
  // denied_by_human to denied_by_policy; nothing else changes decision. E042 and E043
  // (managers) still reach the approver.
  // The run was recorded at Larkspur Labs; it is translated into the Savory Air directory
  // the same way the ticket set was (docs/savory-air-move.md).
  const recorded = readFileSync(
    new URL("../../evals/results/ts-2026-11-25T202914Z.json", import.meta.url),
    "utf8",
  );
  const run = JSON.parse(
    recorded
      .replaceAll("salesforce-users", "crm-users")
      .replaceAll("aws-prod-admins", "ecommerce-prod-admins")
      .replaceAll("omar.haddad@example.test", "wes.harper@example.test"),
  ) as {
    tickets: {
      ticket_id: string;
      transcript: { requester: string; events: Record<string, unknown>[] };
    }[];
  };
  const changes: string[] = [];
  for (const row of run.tickets) {
    const { gate } = await makeGate({ requester: row.transcript.requester, approver: denyAll });
    for (const e of row.transcript.events) {
      if (e.type !== "tool_call") continue;
      const outcome = await gate.execute(String(e.tool), e.args);
      if (outcome.decision !== e.decision) {
        changes.push(`${row.ticket_id} ${e.tool} ${e.decision}->${outcome.decision}`);
      }
    }
  }
  for (const c of changes) {
    assert.match(c, /^E04[4-7] (reset_mfa|add_to_group) denied_by_human->denied_by_policy$/, c);
  }
  const reached = (id: string) =>
    run.tickets
      .find((r) => r.ticket_id === id)
      ?.transcript.events.some((e) => e.decision === "denied_by_human");
  assert.ok(reached("E042") && reached("E043"), "managers' writes still reach the approver");
});
