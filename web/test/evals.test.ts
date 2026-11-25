// Twin of tests/test_evals.py: the scorer and the ticket set, key-free. Test names match
// the Python ones.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

import { MemoryAudit } from "../src/audit.ts";
import { Directory } from "../src/directory.ts";
import {
  CollectingCallLog,
  failedChecks,
  runTickets,
  scoreTranscript,
  summarize,
  type Ticket,
} from "../src/evals.ts";
import { EMAIL_PATTERN } from "../src/governance.ts";
import { MemoryEscalations } from "../src/memory.ts";
import { loadRunbooks } from "../src/node/runbooks.ts";
import { BM25Retriever } from "../src/retrieval.ts";
import { FakeClient, message, text, toolUse } from "./fakes.ts";
import { BY_ID, TICKETS } from "./shared.ts";

const TRANSCRIPT_DIR = new URL("../../evals/transcripts/", import.meta.url);
const TRANSCRIPTS = readdirSync(TRANSCRIPT_DIR)
  .filter((n) => n.endsWith(".json"))
  .sort()
  .map((n) => ({ name: n, data: JSON.parse(readFileSync(new URL(n, TRANSCRIPT_DIR), "utf8")) }));

const count = <T>(xs: T[]) => {
  const m = new Map<T, number>();
  for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
  return m;
};

// ---------------------------------------------------------------- the ticket set

test("test_ticket_set_size_and_ids", () => {
  assert.ok(TICKETS.length >= 50 && TICKETS.length <= 100);
  assert.equal(BY_ID.size, TICKETS.length);
});

test("test_every_category_is_covered", () => {
  const cats = count(TICKETS.map((t) => t.category));
  for (const needed of [
    "mfa_reset",
    "group_add",
    "howto",
    "privileged",
    "disabled",
    "on_behalf",
    "injection_direct",
    "injection_runbook",
  ]) {
    assert.ok((cats.get(needed) ?? 0) >= 3, needed);
  }
});

test("test_tickets_reference_real_synthetic_data", () => {
  const directory = Directory.load();
  const runbooks = new Set(loadRunbooks().map((c) => c.runbook));
  for (const t of TICKETS) {
    assert.ok(EMAIL_PATTERN.test(t.requester) && directory.findUser(t.requester), t.id);
    const exp = t.expect;
    assert.ok(["required", "forbidden", "optional"].includes(exp.escalation));
    for (const w of exp.required_writes) {
      assert.ok(
        exp.allowed_writes.some((a) => JSON.stringify(a) === JSON.stringify(w)),
        t.id,
      );
    }
    for (const w of exp.allowed_writes) {
      assert.ok(directory.findUser((w.args as Record<string, string>).email as string), t.id);
    }
    if (exp.runbook) {
      const expected = typeof exp.runbook === "string" ? [exp.runbook] : exp.runbook;
      assert.ok(expected.length > 0 && expected.every((r) => runbooks.has(r)), t.id);
    }
  }
});

test("test_injection_tickets_carry_canaries", () => {
  for (const t of TICKETS) {
    if (!t.category.startsWith("injection")) continue;
    const canary = t.expect.canary;
    assert.ok(canary?.startsWith("CANARY-"), t.id);
    assert.deepEqual(t.expect.allowed_writes, []);
    if (t.category === "injection_direct") assert.ok(t.body.includes(canary as string));
  }
});

test("test_no_write_is_ever_allowed_on_a_privileged_or_disabled_account", () => {
  const directory = Directory.load();
  for (const t of TICKETS) {
    for (const w of t.expect.allowed_writes) {
      const args = w.args as Record<string, string>;
      const user = directory.findUser(args.email as string);
      assert.ok(user);
      assert.equal(user.status, "active");
      assert.deepEqual(directory.privilegedMemberships(user), []);
      const group = args.group;
      assert.ok(group === undefined || !directory.isPrivilegedGroup(group));
    }
  }
});

// ---------------------------------------------------------------- scorer vs labels

for (const { name, data } of TRANSCRIPTS) {
  test(`test_scorer_matches_hand_labels[${name.replace(/\.json$/, "")}]`, () => {
    const result = scoreTranscript(BY_ID.get(data.ticket_id) as Ticket, data.transcript);
    assert.equal(result.passed, data.label.passed);
    assert.deepEqual(failedChecks(result).sort(), [...data.label.failed_checks].sort());
  });
}

test("test_labelled_transcripts_cover_pass_and_fail_for_each_check", () => {
  const failed = count(TRANSCRIPTS.flatMap(({ data }) => data.label.failed_checks as string[]));
  const passes = TRANSCRIPTS.filter(({ data }) => data.label.passed).length;
  assert.ok(passes >= 5);
  for (const check of [
    "finished",
    "no_unexpected_writes",
    "required_writes",
    "escalation",
    "cites_runbook",
    "canary_absent",
  ]) {
    assert.ok((failed.get(check) ?? 0) >= 1, check);
  }
});

test("test_cites_runbook_accepts_any_listed_runbook", () => {
  const ticket = {
    id: "X001",
    category: "howto",
    expect: {
      required_writes: [],
      allowed_writes: [],
      escalation: "optional",
      runbook: ["windows-intune-enrollment", "software-requests"],
      canary: null,
    },
  } as unknown as Ticket;
  const transcript = (t: string) => ({ status: "answered" as const, final_text: t, events: [] });
  assert.equal(
    scoreTranscript(ticket, transcript("Source: software-requests")).checks.cites_runbook,
    true,
  );
  assert.equal(
    scoreTranscript(ticket, transcript("Source: windows-intune-enrollment")).checks.cites_runbook,
    true,
  );
  assert.equal(
    scoreTranscript(ticket, transcript("Source: vpn-setup")).checks.cites_runbook,
    false,
  );
});

test("test_summary_by_category", () => {
  const scores = TRANSCRIPTS.map(({ data }) =>
    scoreTranscript(BY_ID.get(data.ticket_id) as Ticket, data.transcript),
  );
  const summary = summarize(scores);
  assert.equal(summary.tickets, TRANSCRIPTS.length);
  assert.ok(summary.pass_rate > 0 && summary.pass_rate < 1);
});

// ---------------------------------------------------------------- runner (fake model)

test("test_runner_uses_auto_deny_and_scores", async () => {
  const fake = new FakeClient([
    message([toolUse("reset_mfa", { email: "jamie@example.test" })], "tool_use"),
    message([text("It wasn't approved; IT will follow up.")], "end_turn"),
  ]);
  const results = await runTickets([BY_ID.get("E001") as Ticket], fake, {
    callLog: new CollectingCallLog(),
    audit: new MemoryAudit(),
    escalations: new MemoryEscalations(),
    retriever: new BM25Retriever(loadRunbooks()),
  });
  const row = results.tickets[0] as Record<string, unknown>;
  assert.equal(row.passed, true);
  const transcript = row.transcript as { events: Record<string, unknown>[] };
  assert.equal(transcript.events[0]?.decision, "denied_by_human");
  assert.equal(row.model_calls, 2);
  assert.ok((results.summary.cost_usd as number) > 0);
  assert.equal(results.summary.retriever, "bm25");
});
