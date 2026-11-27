// Identity phase I4: approver identity, separation of duties, approval receipts and the
// audit hash chain. Self-approval and approve-then-swap are refused; `audit verify`
// catches an edited line and a deleted line.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { GENESIS, MemoryAudit, verifyChain } from "../src/audit.ts";
import { mayApprove } from "../src/authz.ts";
import { GrantError, runWithGrant } from "../src/delegation.ts";
import { Directory } from "../src/directory.ts";
import { Decision } from "../src/governance.ts";
import { verifyFile } from "../src/node/audit-verify.ts";
import { FileAudit } from "../src/node/files.ts";
import { argsSha256, ReceiptAuthority } from "../src/receipts.ts";
import { TOOLS } from "../src/tools.ts";
import { JAMIE, makeGate, OPERATOR, RecordingApprover, TEST_ISSUER } from "./helpers.ts";

const THEO = OPERATOR;
const SAM = "sam.whitfield@example.test"; // Theo's manager
const MORGAN = "morgan.hale@example.test"; // Jamie's manager
const JWT = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/;

// ---------------------------------------------------------------- who may approve

test("ts_i4_approver_rules", () => {
  const d = Directory.load();
  assert.equal(mayApprove(d, THEO, JAMIE, JAMIE), null);
  assert.match(mayApprove(d, THEO, THEO, THEO) ?? "", /own request/);
  assert.match(mayApprove(d, THEO, SAM, THEO) ?? "", /own account/);
  assert.match(mayApprove(d, MORGAN, JAMIE, JAMIE) ?? "", /not an active member/);
  assert.match(mayApprove(d, "riley.okafor@example.test", JAMIE, JAMIE) ?? "", /not an active/);
});

const refusedBeforePrompt = [
  ["approver is the requester (self-approval)", THEO, THEO, THEO, /own request/],
  ["approver is the target", SAM, THEO, THEO, /own account/],
  ["approver is not in it-support", JAMIE, JAMIE, MORGAN, /not an active member/],
] as const;

for (const [name, requester, target, operator, why] of refusedBeforePrompt) {
  test(`ts_i4_refused_before_the_prompt[${name}]`, async () => {
    const approver = new RecordingApprover(true);
    const { gate, directory } = await makeGate({ requester, operator, approver: approver.approve });
    const before = JSON.stringify(directory.findUser(target));
    const outcome = await gate.execute("reset_mfa", { email: target });
    assert.equal(outcome.decision, Decision.DENIED_BY_POLICY);
    assert.match(outcome.content, why);
    assert.deepEqual(approver.proposals, [], "never asked");
    assert.equal(JSON.stringify(directory.findUser(target)), before);
  });
}

test("ts_i4_an_approval_without_a_verified_approver_is_not_honoured", async () => {
  const { gate, directory, audit } = await makeGate({
    operator: null,
    approver: new RecordingApprover(true).approve,
  });
  const before = JSON.stringify(directory.findUser(JAMIE));
  const outcome = await gate.execute("reset_mfa", { email: JAMIE });
  assert.equal(outcome.decision, Decision.DENIED_BY_HUMAN);
  assert.equal(JSON.stringify(directory.findUser(JAMIE)), before);
  assert.match(String(audit.records.at(-1)?.reason), /no verified approver/);
});

test("ts_i4_an_approver_who_loses_the_role_while_deciding_is_not_honoured", async () => {
  let dir: Directory | null = null;
  const { gate, directory } = await makeGate({
    approver: async () => {
      const theo = dir?.findUser(THEO);
      if (theo) theo.groups = theo.groups.filter((g) => g !== "it-support");
      return true;
    },
  });
  dir = directory;
  const before = JSON.stringify(directory.findUser(JAMIE));
  const outcome = await gate.execute("reset_mfa", { email: JAMIE });
  assert.equal(outcome.decision, Decision.DENIED_BY_HUMAN);
  assert.equal(JSON.stringify(directory.findUser(JAMIE)), before);
});

// ---------------------------------------------------------------- receipts

test("ts_i4_an_approved_write_carries_a_receipt_audited_by_id", async () => {
  const { gate, audit, directory } = await makeGate({
    approver: new RecordingApprover(true).approve,
  });
  const outcome = await gate.execute("reset_mfa", { email: JAMIE });
  assert.equal(outcome.decision, Decision.APPROVED);
  assert.equal(directory.findUser(JAMIE)?.mfa.enrolled, false);
  const approved = audit.records.find((r) => r.event === "write_approved");
  assert.ok(approved);
  assert.equal(approved.approver, THEO);
  assert.equal(approved.args_sha256, await argsSha256({ email: JAMIE }));
  assert.equal(typeof approved.receipt_jti, "string");
  assert.ok(!JWT.test(JSON.stringify(audit.records)), "no receipt or token in the audit");
});

test("ts_i4_approve_then_swap_at_the_gate_runs_only_what_was_approved", async () => {
  const args: Record<string, string> = { email: JAMIE };
  const { gate, directory } = await makeGate({
    approver: async () => {
      args.email = "dana.ito@example.test"; // swap the caller's object after the prompt
      return true;
    },
  });
  const dana = JSON.stringify(directory.findUser("dana.ito@example.test"));
  assert.equal((await gate.execute("reset_mfa", args)).decision, Decision.APPROVED);
  assert.equal(directory.findUser(JAMIE)?.mfa.enrolled, false, "the approved target changed");
  assert.equal(JSON.stringify(directory.findUser("dana.ito@example.test")), dana);
});

/** A handler-level setup: a valid grant for the write, and a receipt authority. */
async function handler(tool: "reset_mfa" | "add_to_group", now?: () => number) {
  const { gate } = await makeGate();
  const signIn = await TEST_ISSUER.signIn(JAMIE);
  const scope = tool === "reset_mfa" ? "directory:mfa.reset" : "directory:group.add";
  const grant = () => signIn.grant("larkspur-directory", scope, "T-TEST");
  const spec = TOOLS.get(tool);
  assert.ok(spec);
  return { gate, spec, grant, authority: new ReceiptAuthority(now), resources: signIn.resources };
}

test("ts_i4_receipt_refused[approved for one target, run for another]", async () => {
  const h = await handler("reset_mfa");
  const { token } = await h.authority.sign(THEO, "T-TEST", "reset_mfa", { email: JAMIE });
  await assert.rejects(
    runWithGrant(h.spec, h.gate.ctx, { email: MORGAN }, await h.grant(), h.resources, {
      token,
      authority: h.authority,
    }),
    /different arguments/,
  );
});

test("ts_i4_receipt_refused[approved for one group, run for another]", async () => {
  const h = await handler("add_to_group");
  const approved = { email: JAMIE, group: "figma-users" };
  const { token } = await h.authority.sign(THEO, "T-TEST", "add_to_group", approved);
  await assert.rejects(
    runWithGrant(
      h.spec,
      h.gate.ctx,
      { email: JAMIE, group: "salesforce-users" },
      await h.grant(),
      h.resources,
      { token, authority: h.authority },
    ),
    /different arguments/,
  );
});

test("ts_i4_receipt_refused[missing, reused, expired, other ticket, tool or signer]", async () => {
  const args = { email: JAMIE };
  let clock = 1_800_000_000;
  const h = await handler("reset_mfa", () => clock);
  const run = (token: unknown, authority = h.authority, a: object = args) =>
    h
      .grant()
      .then((g) =>
        runWithGrant(h.spec, h.gate.ctx, a as never, g, h.resources, { token, authority }),
      );
  await assert.rejects(
    h.grant().then((g) => runWithGrant(h.spec, h.gate.ctx, args, g, h.resources, null)),
    /no approval receipt/,
  );
  await assert.rejects(run(undefined), /no approval receipt/);
  // Used once.
  const once = (await h.authority.sign(THEO, "T-TEST", "reset_mfa", args)).token;
  await run(once);
  await assert.rejects(run(once), /already used/);
  // Expired: 120 seconds plus skew.
  const old = (await h.authority.sign(THEO, "T-TEST", "reset_mfa", args)).token;
  clock += 200;
  await assert.rejects(run(old), /expired/);
  // Another ticket, another tool, another signer.
  const other = (await h.authority.sign(THEO, "T-OTHER", "reset_mfa", args)).token;
  await assert.rejects(run(other), /another ticket/);
  const tool = (await h.authority.sign(THEO, "T-TEST", "add_to_group", args)).token;
  await assert.rejects(run(tool), /another tool/);
  const forger = new ReceiptAuthority(() => clock);
  const forged = (await forger.sign(THEO, "T-TEST", "reset_mfa", args)).token;
  await assert.rejects(run(forged), /bad signature/);
  // Signed by the requester for themself.
  const self = (await h.authority.sign(JAMIE, "T-TEST", "reset_mfa", args)).token;
  await assert.rejects(
    run(self),
    (e: Error) => e instanceof GrantError && /own request/.test(e.message),
  );
});

// ---------------------------------------------------------------- the hash chain

async function trail() {
  const { gate, audit } = await makeGate({ approver: new RecordingApprover(true).approve });
  await gate.execute("lookup_user", { email: JAMIE });
  await gate.execute("reset_mfa", { email: JAMIE });
  await gate.execute("search_runbooks", { query: "vpn" });
  return audit;
}

test("ts_i4_every_record_links_to_the_one_before", async () => {
  const audit = await trail();
  assert.equal(audit.records[0]?.prev, GENESIS);
  assert.deepEqual(await verifyChain(audit.records), { ok: true, records: audit.records.length });
});

test("ts_i4_verify_catches_an_edited_record", async () => {
  const records = (await trail()).records.map((r) => ({ ...r }));
  (records[1] as Record<string, unknown>).decision = "allowed";
  assert.deepEqual(await verifyChain(records), {
    ok: false,
    brokenAt: 1,
    why: "hash does not match the record",
  });
});

test("ts_i4_verify_catches_a_deleted_and_a_reordered_record", async () => {
  const records = (await trail()).records;
  const deleted = [...records.slice(0, 1), ...records.slice(2)];
  assert.deepEqual(await verifyChain(deleted), {
    ok: false,
    brokenAt: 1,
    why: "prev does not match the record before",
  });
  const swapped = [records[1], records[0], ...records.slice(2)] as typeof records;
  assert.equal((await verifyChain(swapped)).ok, false);
  const truncatedHead = records.slice(1);
  assert.equal((await verifyChain(truncatedHead)).ok, false);
});

test("ts_i4_file_audit_chains_across_instances_and_audit_verify_reads_it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "audit-"));
  try {
    const path = join(dir, "audit.jsonl");
    await new FileAudit(path).record("tool_call", { tool: "a" });
    await new FileAudit(path).record("tool_call", { tool: "b" }); // a new process, same file
    const sink = new FileAudit(path);
    await sink.record("tool_call", { tool: "c" });
    await sink.record("tool_call", { tool: "d" });
    assert.equal(await verifyFile(path), "ok: 4 records, chain intact");
    const lines = (await readFile(path, "utf8")).trimEnd().split("\n");
    await writeFile(path, `${[lines[0], lines[2], lines[3]].join("\n")}\n`);
    assert.match(await verifyFile(path), /broken at record 2/);
    await writeFile(
      path,
      `${lines.map((l) => l.replace('"tool":"c"', '"tool":"x"')).join("\n")}\n`,
    );
    assert.match(await verifyFile(path), /broken at record 3: hash/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ts_i4_memory_audit_chains_overlapping_writes_in_order", async () => {
  const audit = new MemoryAudit();
  await Promise.all([1, 2, 3, 4].map((n) => audit.record("tool_call", { n })));
  assert.equal((await verifyChain(audit.records)).ok, true);
});
