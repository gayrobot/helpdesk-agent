// Twin of tests/test_webui.py: the session API's request checks and the click-to-approve
// gate, run in Node against src/session.ts and src/api.ts with a scripted model. Test
// names match the Python ones. Tests that need the real runtime (bind address, static
// files and their headers, the Durable Object) are in test/worker-session.test.ts.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import {
  handleSessionApi,
  MAX_BODY_BYTES,
  SESSION_HEADER,
  TOKEN_HEADER,
  tokenHash,
} from "../src/api.ts";
import { resultFingerprint } from "../src/governance.ts";
import { MemoryStore } from "../src/memory.ts";
import { loadRunbooks } from "../src/node/runbooks.ts";
import { BM25Retriever } from "../src/retrieval.ts";
import { Session } from "../src/session.ts";
import { FakeClient, message, text, toolUse } from "./fakes.ts";

const BASE = "http://127.0.0.1:8787";
const TOKEN = "t".repeat(64);
const JAMIE = "jamie@example.test";
const RESET_JAMIE = toolUse("reset_mfa", { email: JAMIE }, "toolu_1");
const DONE = message([text("Done. Source: RB-001")], "end_turn");
const writeScript = () => [message([RESET_JAMIE], "tool_use"), DONE];
const retriever = new BM25Retriever(loadRunbooks());

const open: Session[] = [];
afterEach(() => {
  for (const s of open.splice(0)) s.shutdown();
});

async function makeSession(
  script: ConstructorParameters<typeof FakeClient>[0],
  options: { approvalTimeoutMs?: number; minReviewMs?: number; store?: MemoryStore } = {},
) {
  const store = options.store ?? new MemoryStore();
  const session = await Session.open({
    client: new FakeClient(script),
    store,
    retriever,
    approvalTimeoutMs: options.approvalTimeoutMs ?? 5_000,
    minReviewMs: options.minReviewMs ?? 0,
  });
  open.push(session);
  const hash = await tokenHash(TOKEN);

  async function request(
    method: string,
    path: string,
    body?: unknown,
    opts: { token?: boolean; origin?: boolean; headers?: Record<string, string> } = {},
  ) {
    const headers: Record<string, string> = { Host: "127.0.0.1:8787", [SESSION_HEADER]: "s" };
    if (opts.token !== false) headers[TOKEN_HEADER] = TOKEN;
    if (opts.origin !== false) headers.Origin = BASE;
    let raw: string | undefined;
    if (body !== undefined) {
      raw = typeof body === "string" ? body : JSON.stringify(body);
      headers["Content-Type"] = "application/json";
    }
    Object.assign(headers, opts.headers);
    const init: RequestInit = { method, headers };
    if (raw !== undefined) init.body = raw;
    const res = await handleSessionApi(new Request(BASE + path, init), session, hash);
    const textBody = await res.text();
    let data: unknown;
    try {
      data = JSON.parse(textBody);
    } catch {
      data = textBody;
    }
    return { status: res.status, data: data as Record<string, unknown>, headers: res.headers };
  }

  async function start(ticket = "please reset my MFA", requester = JAMIE) {
    const r = await request("POST", "/api/runs", { requester, ticket });
    assert.equal(r.status, 202, JSON.stringify(r.data));
    return r.data.run_id as string;
  }

  async function snapshot(runId: string) {
    const r = await request("GET", `/api/runs/${runId}`);
    assert.equal(r.status, 200);
    return r.data as Record<string, unknown> & {
      pending: Record<string, unknown> | null;
      events: Record<string, unknown>[];
    };
  }

  async function waitFor(
    runId: string,
    until: (s: Awaited<ReturnType<typeof snapshot>>) => boolean,
  ) {
    const deadline = Date.now() + 5_000;
    let snap = await snapshot(runId);
    while (!until(snap)) {
      if (Date.now() > deadline) throw new Error(`timed out: ${JSON.stringify(snap)}`);
      await new Promise((r) => setTimeout(r, 5));
      snap = await snapshot(runId);
    }
    return snap;
  }

  const pendingOf = async (runId: string) =>
    (await waitFor(runId, (s) => s.pending !== null)).pending as Record<string, unknown>;
  const finished = (runId: string) => waitFor(runId, (s) => s.status !== "running");
  const decide = (runId: string, body: unknown, opts = {}) =>
    request("POST", `/api/runs/${runId}/decision`, body, opts);

  return { session, store, request, start, snapshot, waitFor, pendingOf, finished, decide };
}

const auditEvents = (store: MemoryStore) => store.audit.map((r) => r.event);

// ---------------------------------------------------------------- request checks

test("test_api_get_needs_token", async () => {
  const s = await makeSession([]);
  assert.equal(
    (await s.request("GET", "/api/requesters", undefined, { token: false })).status,
    403,
  );
  const r = await s.request("GET", "/api/requesters");
  assert.equal(r.status, 200);
  const requesters = r.data.requesters as Record<string, string>[];
  assert.ok(requesters.some((u) => u.email === JAMIE));
  assert.deepEqual(Object.keys(requesters[0] ?? {}).sort(), ["email", "name"]);
});

test("test_wrong_host_header_is_refused", async () => {
  const s = await makeSession([]);
  for (const host of ["evil.example:80", "evil.example", "127.0.0.1.evil.example:8787"]) {
    const r = await s.request("GET", "/api/requesters", undefined, { headers: { Host: host } });
    assert.equal(r.status, 403, host);
  }
});

for (const [name, opts, expected] of [
  ["no origin", { origin: false }, 403],
  ["other origin", { headers: { Origin: "http://evil.example" } }, 403],
  ["null origin", { headers: { Origin: "null" } }, 403],
  ["no token", { token: false }, 403],
  ["guessed token", { headers: { [TOKEN_HEADER]: "guess" } }, 403],
  ["text/plain", { headers: { "Content-Type": "text/plain" } }, 400],
] as const) {
  test(`test_cross_site_posts_start_nothing[${name}]`, async () => {
    const s = await makeSession(writeScript());
    const r = await s.request(
      "POST",
      "/api/runs",
      { requester: JAMIE, ticket: "reset my MFA" },
      opts,
    );
    assert.equal(r.status, expected);
    assert.equal(r.headers.get("access-control-allow-origin"), null);
    assert.equal(s.session.currentRunId(), null);
  });
}

test("test_bad_requests_are_rejected", async () => {
  const s = await makeSession([]);
  for (const body of [
    { requester: "nobody@example.test", ticket: "x" },
    { requester: "Jamie@example.test", ticket: "x" },
    { requester: JAMIE, ticket: "   " },
    { requester: JAMIE, ticket: "x".repeat(8001) },
    { requester: JAMIE },
    ["not", "an", "object"],
    "{not json",
  ]) {
    assert.equal((await s.request("POST", "/api/runs", body)).status, 400, JSON.stringify(body));
  }
  assert.equal(s.session.currentRunId(), null);
});

test("test_oversized_body_is_rejected", async () => {
  const s = await makeSession([]);
  const huge = { requester: JAMIE, ticket: "x".repeat(MAX_BODY_BYTES + 100) };
  assert.equal((await s.request("POST", "/api/runs", huge)).status, 400);
});

// ---------------------------------------------------------------- the write gate

test("test_approve_click_runs_the_write", async () => {
  const s = await makeSession(writeScript());
  const runId = await s.start();
  const pending = await s.pendingOf(runId);
  assert.equal(pending.tool, "reset_mfa");
  assert.deepEqual(pending.args, { email: JAMIE });
  assert.equal(pending.requester, JAMIE);
  assert.equal(pending.target, JAMIE);
  assert.equal(pending.requester_is_target, true);
  assert.ok(String(pending.effect).includes(JAMIE));

  const r = await s.decide(runId, { proposal_id: pending.id, decision: "approve" });
  assert.deepEqual([r.status, r.data], [200, { recorded: "approve" }]);

  const final = await s.finished(runId);
  assert.equal(final.status, "answered");
  assert.equal(final.pending, null);
  assert.deepEqual(
    final.events.map((e) => e.decision),
    ["approved"],
  );
  assert.deepEqual(auditEvents(s.store), ["write_approved", "tool_call"]);
});

test("test_deny_click_denies", async () => {
  const s = await makeSession(writeScript());
  const runId = await s.start();
  const pending = await s.pendingOf(runId);
  assert.equal((await s.decide(runId, { proposal_id: pending.id, decision: "deny" })).status, 200);
  const final = await s.finished(runId);
  assert.deepEqual(
    final.events.map((e) => e.decision),
    ["denied_by_human"],
  );
  assert.ok(!auditEvents(s.store).includes("write_approved"));
});

test("test_wrong_or_replayed_proposal_id_does_nothing", async () => {
  const s = await makeSession(writeScript());
  const runId = await s.start();
  const pending = await s.pendingOf(runId);
  const id = pending.id as string;
  for (const bad of ["not-the-id", id.slice(0, -1), null, 123]) {
    assert.equal((await s.decide(runId, { proposal_id: bad, decision: "approve" })).status, 409);
  }
  assert.equal((await s.decide(runId, { proposal_id: id, decision: "yes" })).status, 400);
  assert.equal((await s.snapshot(runId)).pending?.id, id); // still waiting
  assert.equal((await s.decide(runId, { proposal_id: id, decision: "deny" })).status, 200);
  // A second click on the same proposal, Approve this time, is refused.
  assert.equal((await s.decide(runId, { proposal_id: id, decision: "approve" })).status, 409);
  await s.finished(runId);
  assert.ok(!auditEvents(s.store).includes("write_approved"));
});

test("test_decision_without_token_or_origin_is_refused", async () => {
  const s = await makeSession(writeScript());
  const runId = await s.start();
  const pending = await s.pendingOf(runId);
  const body = { proposal_id: pending.id, decision: "approve" };
  assert.equal((await s.decide(runId, body, { token: false })).status, 403);
  assert.equal((await s.decide(runId, body, { origin: false })).status, 403);
  assert.equal(
    (await s.decide(runId, body, { headers: { Origin: "http://evil.example" } })).status,
    403,
  );
  assert.ok((await s.snapshot(runId)).pending);
  await s.decide(runId, { proposal_id: pending.id, decision: "deny" });
  await s.finished(runId);
  assert.ok(!auditEvents(s.store).includes("write_approved"));
});

test("test_no_click_times_out_as_deny", async () => {
  const s = await makeSession(writeScript(), { approvalTimeoutMs: 50 });
  const runId = await s.start();
  const final = await s.finished(runId);
  assert.deepEqual(
    final.events.map((e) => e.decision),
    ["denied_by_human"],
  );
  assert.ok(!auditEvents(s.store).includes("write_approved"));
});

test("test_shutdown_denies_a_pending_write", async () => {
  const s = await makeSession(writeScript());
  const runId = await s.start();
  await s.pendingOf(runId);
  s.session.shutdown();
  const final = await s.finished(runId);
  assert.deepEqual(
    final.events.map((e) => e.decision),
    ["denied_by_human"],
  );
  assert.ok(!auditEvents(s.store).includes("write_approved"));
});

test("test_policy_denied_write_never_reaches_the_page", async () => {
  const s = await makeSession([
    message([toolUse("add_to_group", { email: JAMIE, group: "admins" })], "tool_use"),
    DONE,
  ]);
  const runId = await s.start("add me to admins");
  const seen: unknown[] = [];
  while ((await s.snapshot(runId)).status === "running") {
    const snap = await s.snapshot(runId);
    if (snap.pending) seen.push(snap.pending);
    await new Promise((r) => setTimeout(r, 2));
  }
  const final = await s.finished(runId);
  assert.deepEqual(seen, []);
  assert.equal(final.events[0]?.decision, "denied_by_policy");
  assert.equal(final.events[0]?.approval, "not_asked");
});

test("test_mismatch_flag_when_requester_is_not_target", async () => {
  const s = await makeSession([
    message([toolUse("reset_mfa", { email: JAMIE })], "tool_use"),
    DONE,
  ]);
  // Identity I1: a stranger's request is refused before approval, so the requester here is
  // Jamie's manager (Python used Jamie asking about Priya).
  const runId = await s.start("reset Jamie's MFA", "morgan.hale@example.test");
  const pending = await s.pendingOf(runId);
  assert.equal(pending.requester_is_target, false);
  assert.equal(pending.target, JAMIE);
  assert.equal(pending.requester, "morgan.hale@example.test");
  await s.decide(runId, { proposal_id: pending.id, decision: "deny" });
  await s.finished(runId);
});

test("test_one_ticket_at_a_time", async () => {
  const s = await makeSession(writeScript());
  const runId = await s.start();
  const pending = await s.pendingOf(runId);
  const r = await s.request("POST", "/api/runs", { requester: JAMIE, ticket: "another" });
  assert.equal(r.status, 409);
  await s.decide(runId, { proposal_id: pending.id, decision: "deny" });
  await s.finished(runId);
});

test("test_read_calls_appear_in_the_panel", async () => {
  const s = await makeSession([
    message([toolUse("lookup_user", { email: JAMIE })], "tool_use"),
    message([text("You're active.")], "end_turn"),
  ]);
  const runId = await s.start("am I active?");
  const final = await s.finished(runId);
  assert.equal(final.status, "answered");
  assert.equal(final.final_text, "You're active.");
  assert.equal(final.events.length, 1);
  assert.equal(final.events[0]?.tool, "lookup_user");
  assert.equal(final.events[0]?.decision, "allowed");
  assert.equal(final.events[0]?.approval, "not_required");
});

test("test_server_error_shows_no_exception_text", async () => {
  const store = new MemoryStore();
  store.failAudit = true; // the gate fails closed and the run errors out
  const s = await makeSession(
    [message([toolUse("lookup_user", { email: JAMIE })], "tool_use"), DONE],
    { store },
  );
  const runId = await s.start();
  const final = await s.finished(runId);
  assert.equal(final.status, "server_error");
  assert.ok(!JSON.stringify(final).includes("audit store down"));
});

test("test_no_response_carries_the_environment", async () => {
  const sentinel = "sk-ant-test-sentinel-value";
  const before = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = sentinel;
  try {
    const s = await makeSession(writeScript());
    const bodies: unknown[] = [(await s.request("GET", "/api/requesters")).data];
    const runId = await s.start();
    const snap = await s.waitFor(runId, (x) => x.pending !== null);
    bodies.push(snap);
    await s.decide(runId, { proposal_id: snap.pending?.id, decision: "deny" });
    bodies.push(await s.finished(runId));
    for (const b of bodies) assert.ok(!JSON.stringify(b).includes(sentinel));
  } finally {
    if (before === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = before;
  }
});

// ---------------------------------------------------------------- double-click guard

test("test_approve_too_soon_after_display_is_refused", async () => {
  const s = await makeSession(writeScript(), { minReviewMs: 150 });
  const runId = await s.start();
  const pending = await s.pendingOf(runId);
  const body = { proposal_id: pending.id, decision: "approve" };
  assert.equal((await s.decide(runId, body)).status, 409);
  assert.equal((await s.snapshot(runId)).pending?.id, pending.id);
  await new Promise((r) => setTimeout(r, 180));
  assert.equal((await s.decide(runId, body)).status, 200);
  await s.finished(runId);
  assert.deepEqual(auditEvents(s.store), ["write_approved", "tool_call"]);
});

test("test_approve_before_the_page_saw_it_is_refused", async () => {
  // The review clock starts at the first snapshot; an id learnt another way can't skip it.
  const s = await makeSession(writeScript(), { minReviewMs: 0 });
  const runId = await s.start();
  const deadline = Date.now() + 5_000;
  const internals = s.session as unknown as {
    runs: Map<string, { pending: { id: string } | null }>;
  };
  while (!internals.runs.get(runId)?.pending && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2));
  }
  const id = internals.runs.get(runId)?.pending?.id as string;
  assert.equal(s.session.decide(runId, id, true), false);
  assert.equal(s.session.decide(runId, id, false), true); // Deny always works
  await s.finished(runId);
});

test("test_double_click_cannot_approve_the_next_write", async () => {
  const s = await makeSession(
    [
      message(
        [
          toolUse("reset_mfa", { email: JAMIE }, "toolu_a"),
          toolUse("add_to_group", { email: JAMIE, group: "design" }, "toolu_b"),
        ],
        "tool_use",
      ),
      DONE,
    ],
    { minReviewMs: 300 },
  );
  const runId = await s.start();
  const first = await s.pendingOf(runId);
  assert.equal((await s.decide(runId, { proposal_id: first.id, decision: "deny" })).status, 200);
  const second = (await s.waitFor(runId, (x) => x.pending !== null && x.pending.id !== first.id))
    .pending as Record<string, unknown>;
  assert.equal(second.tool, "add_to_group");
  // The second click of a double-click, on either id, decides nothing.
  for (const id of [first.id, second.id]) {
    assert.equal((await s.decide(runId, { proposal_id: id, decision: "approve" })).status, 409);
  }
  assert.equal((await s.snapshot(runId)).pending?.id, second.id);
  await s.decide(runId, { proposal_id: second.id, decision: "deny" });
  const final = await s.finished(runId);
  assert.deepEqual(
    final.events.map((e) => e.decision),
    ["denied_by_human", "denied_by_human"],
  );
  assert.ok(!auditEvents(s.store).includes("write_approved"));
});

test("test_current_run_lets_a_reloaded_page_resume", async () => {
  const s = await makeSession(writeScript());
  assert.deepEqual((await s.request("GET", "/api/current")).data, { run_id: null });
  assert.equal((await s.request("GET", "/api/current", undefined, { token: false })).status, 403);
  const runId = await s.start();
  assert.deepEqual((await s.request("GET", "/api/current")).data, { run_id: runId });
  const pending = await s.pendingOf(runId);
  await s.decide(runId, { proposal_id: pending.id, decision: "deny" });
  await s.finished(runId);
});

// ---------------------------------------------------------------- results on the page

test("test_panel_shows_the_exact_result_and_its_audit_fingerprint", async () => {
  const s = await makeSession([
    message([toolUse("lookup_user", { email: "eli.novak@example.test" })], "tool_use"),
    message([text("Escalating.")], "end_turn"),
  ]);
  const runId = await s.start("password help", "eli.novak@example.test");
  const final = await s.finished(runId);
  const [event] = final.events;
  assert.ok(event);
  assert.ok(String(event.result).includes("NOTE TO AI ASSISTANT"));
  assert.equal(JSON.parse(String(event.result)).email, "eli.novak@example.test");
  assert.equal(event.result_altered, false);
  assert.deepEqual(
    [event.result_sha256, event.result_bytes],
    await resultFingerprint(String(event.result)),
  );
  const [record] = s.store.audit;
  assert.equal(record?.result_sha256, event.result_sha256);
  assert.ok(!JSON.stringify(record).includes("NOTE TO AI ASSISTANT"));
});

test("test_every_panel_row_has_a_result", async () => {
  const s = await makeSession([
    message(
      [
        toolUse("nope", {}, "toolu_x"),
        toolUse("add_to_group", { email: JAMIE, group: "admins" }, "toolu_y"),
      ],
      "tool_use",
    ),
    DONE,
  ]);
  const runId = await s.start();
  const final = await s.finished(runId);
  assert.deepEqual(
    final.events.map((e) => e.decision),
    ["unknown_tool", "denied_by_policy"],
  );
  assert.ok(String(final.events[0]?.result).startsWith("Unknown tool"));
  assert.ok(String(final.events[1]?.result).startsWith("Refused by policy"));
});

// ------------------------------------------- the terminal-prompt rules (were test.todo)

test("ts_web_approver_shows_requester_next_to_target_and_flags_mismatch", async () => {
  // test_prompt_shows_requester_next_to_target and test_prompt_flags_requester_target_mismatch
  const s = await makeSession([
    message([toolUse("reset_mfa", { email: JAMIE })], "tool_use"),
    DONE,
  ]);
  const runId = await s.start("reset Jamie", "morgan.hale@example.test"); // Jamie's manager
  const pending = await s.pendingOf(runId);
  assert.equal(pending.requester, "morgan.hale@example.test");
  assert.equal(pending.target, JAMIE);
  assert.equal(pending.requester_is_target, false);
  await s.decide(runId, { proposal_id: pending.id, decision: "deny" });
  await s.finished(runId);
});

test("ts_web_approver_strips_escapes_from_every_field", async () => {
  // test_prompt_strips_escapes_from_every_field: hostile directory fields reach the page
  // only through display().
  const store = new MemoryStore();
  const { Directory } = await import("../src/directory.ts");
  const d = Directory.load();
  const jamie = d.findUser(JAMIE);
  assert.ok(jamie);
  jamie.name = "Jamie\x1b[2K\r\x1b[32mPRE-APPROVED\x1b[0m‮";
  jamie.mfa.method = "totp\x1b]0;title\x07\nApproved: yes";
  store.directory = {
    company: d.company,
    users: [...d.users.values()],
    groups: [...d.groups.values()],
    devices: d.devices,
    apps: d.apps,
  };
  const s = await makeSession(writeScript(), { store });
  const runId = await s.start();
  const pending = await s.pendingOf(runId);
  const shown = JSON.stringify(pending);
  for (const bad of ["\\u001b", "\\r", "\\n", "‮"]) assert.ok(!shown.includes(bad), bad);
  assert.ok(String(pending.effect).includes("PRE-APPROVED")); // visible, not hidden
  await s.decide(runId, { proposal_id: pending.id, decision: "deny" });
  await s.finished(runId);
});

test("ts_only_an_explicit_approve_on_that_proposal_approves", async () => {
  // test_tty_approver_needs_exact_y: only "approve" for the pending id counts.
  for (const decision of ["Approve", "yes", "y", true, 1, null]) {
    const s = await makeSession(writeScript());
    const runId = await s.start();
    const pending = await s.pendingOf(runId);
    assert.equal((await s.decide(runId, { proposal_id: pending.id, decision })).status, 400);
    await s.decide(runId, { proposal_id: pending.id, decision: "deny" });
    await s.finished(runId);
    assert.ok(!auditEvents(s.store).includes("write_approved"));
  }
});

// ---------------------------------------------------------------- TypeScript only

test("ts_restart_mid_run_fails_closed", async () => {
  // A run stored as running (the process went away) comes back interrupted, its pending
  // write unmade, and nothing resumes.
  const store = new MemoryStore();
  const first = await makeSession(writeScript(), { store });
  const runId = await first.start();
  await first.pendingOf(runId);
  // Simulate a restart: a new Session over the same store, the old one gone.
  const second = await makeSession([], { store });
  const snap = await second.snapshot(runId);
  assert.equal(snap.status, "interrupted");
  assert.equal(snap.pending, null);
  assert.ok(String(snap.final_text).includes("not made"));
  assert.ok(!auditEvents(store).includes("write_approved"));
  // A new run is allowed: the interrupted one no longer blocks the session.
  second.session.shutdown();
});

test("ts_the_session_keeps_its_directory_between_tickets", async () => {
  // The visitor's own copy: an approved MFA reset is visible to the next ticket.
  const s = await makeSession([
    ...writeScript(),
    message([toolUse("lookup_user", { email: JAMIE })], "tool_use"),
    message([text("ok")], "end_turn"),
  ]);
  const first = await s.start();
  const pending = await s.pendingOf(first);
  await s.decide(first, { proposal_id: pending.id, decision: "approve" });
  await s.finished(first);
  const second = await s.start("am I enrolled?");
  const final = await s.finished(second);
  const profile = JSON.parse(String(final.events[0]?.result));
  assert.equal(profile.mfa.enrolled, false);
  assert.equal(s.store.directory?.users.find((u) => u.email === JAMIE)?.mfa.enrolled, false);
});

test("ts_log_route_returns_this_sessions_records", async () => {
  const s = await makeSession(writeScript());
  assert.equal((await s.request("GET", "/api/log", undefined, { token: false })).status, 403);
  const runId = await s.start();
  const pending = await s.pendingOf(runId);
  await new Promise((r) => setTimeout(r, 1));
  await s.decide(runId, { proposal_id: pending.id, decision: "approve" });
  await s.finished(runId);
  const log = (await s.request("GET", "/api/log")).data as {
    audit: Record<string, unknown>[];
    calls: Record<string, unknown>[];
  };
  // The approval is recorded before the write's own tool_call record.
  assert.deepEqual(
    log.audit.map((r) => [r.event, r.decision ?? null]),
    [
      ["write_approved", null],
      ["tool_call", "approved"],
    ],
  );
  assert.equal(log.calls.length, 2);
  assert.ok(log.calls.every((c) => c.request_id === "req_fake" && Number(c.cost_usd) > 0));
});

test("ts_an_approved_write_survives_a_restart", async () => {
  // Two writes in one turn: the first approved (and applied), the second still pending
  // when the process goes away. The first must be stored; the second must not happen.
  const store = new MemoryStore();
  const first = await makeSession(
    [
      message(
        [
          toolUse("reset_mfa", { email: JAMIE }, "toolu_a"),
          toolUse("add_to_group", { email: JAMIE, group: "design" }, "toolu_b"),
        ],
        "tool_use",
      ),
      DONE,
    ],
    { store },
  );
  const runId = await first.start();
  const a = await first.pendingOf(runId);
  assert.equal((await first.decide(runId, { proposal_id: a.id, decision: "approve" })).status, 200);
  await first.waitFor(runId, (x) => x.pending !== null && x.pending.id !== a.id);

  const second = await makeSession([], { store });
  assert.equal((await second.snapshot(runId)).status, "interrupted");
  const jamie = store.directory?.users.find((u) => u.email === JAMIE);
  assert.equal(jamie?.mfa.enrolled, false); // the approved reset was kept
  assert.ok(!jamie?.groups.includes("design")); // the pending add never ran
});

test("ts_no_token_reaches_a_response_log_or_storage", async () => {
  // Identity I1: a principal is minted per run from a signed token. The token must not
  // appear in anything the page, the logs or storage can see.
  const JWT = /eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/;
  const s = await makeSession(writeScript());
  const runId = await s.start();
  const pending = await s.pendingOf(runId);
  await new Promise((r) => setTimeout(r, 1));
  await s.decide(runId, { proposal_id: pending.id, decision: "approve" });
  const final = await s.finished(runId);
  const seen = [
    final,
    (await s.request("GET", "/api/log")).data,
    s.store.audit,
    s.store.calls,
    s.store.runs,
    s.store.directory,
  ];
  for (const item of seen) assert.doesNotMatch(JSON.stringify(item), JWT);
});
