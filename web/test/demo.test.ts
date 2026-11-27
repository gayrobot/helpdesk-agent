// Tier 2, the split-screen demo (src/demo.ts): each side's own sign-in, separation of
// duties across the two sides, and the limits before any model call. Mocked client, no key.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { SESSION_HEADER, TOKEN_HEADER, tokenHash } from "../src/api.ts";
import { MemoryAudit } from "../src/audit.ts";
import type { Reservation } from "../src/budget.ts";
import {
  DEMO_HELPDESK,
  DEMO_MAX_TICKETS,
  type DemoDeps,
  handleDemoApi,
  handleNewSession,
  IDENTITY_HEADER,
  personas,
  SideSignIns,
  ticketWorstCaseUsd,
} from "../src/demo.ts";
import { Directory } from "../src/directory.ts";
import { ApprovedBy, Decision, Gate } from "../src/governance.ts";
import { DevIssuer } from "../src/identity.ts";
import { MemoryEscalations, MemoryStore } from "../src/memory.ts";
import { loadRunbooks } from "../src/node/runbooks.ts";
import { BM25Retriever } from "../src/retrieval.ts";
import { Session } from "../src/session.ts";
import { FakeClient, message, text, toolUse } from "./fakes.ts";

const BASE = "http://127.0.0.1:8787";
const TOKEN = "t".repeat(64);
const JAMIE = "jamie@example.test";
const PRIYA = "priya.nair@example.test";
const ROSA = "rosa.delgado@example.test";
const THEO = "theo.park@example.test";
const MORGAN = "morgan.hale@example.test"; // in aws-prod-admins (privileged)
const DONE = message([text("Done.\nSource: RB-001")], "end_turn");
const reset = (email: string) => message([toolUse("reset_mfa", { email }, "toolu_1")], "tool_use");
const retriever = new BM25Retriever(loadRunbooks());

const open: Session[] = [];
afterEach(() => {
  for (const s of open.splice(0)) s.shutdown();
});

interface Harness {
  reservations: { visitor: string; worst: number }[];
  settled: { id: string; actual: number }[];
  reserve: (visitor: string, worst: number) => Promise<Reservation>;
}

async function demo(
  script: ConstructorParameters<typeof FakeClient>[0],
  options: { modelCallsOn?: boolean; maxTickets?: number; reserve?: Harness["reserve"] } = {},
) {
  const store = new MemoryStore();
  const client = new FakeClient(script);
  const issuer = new DevIssuer();
  const session = await Session.open({
    client,
    store,
    retriever,
    issuer,
    operators: DEMO_HELPDESK,
    approvalTimeoutMs: 5_000,
    minReviewMs: 0,
  });
  open.push(session);
  const signIns = new SideSignIns(issuer);
  const hash = await tokenHash(TOKEN);
  const directory = Directory.load();
  const waits: Promise<unknown>[] = [];
  const h: Harness = {
    reservations: [],
    settled: [],
    reserve:
      options.reserve ??
      (async (visitor, worst) => {
        h.reservations.push({ visitor, worst });
        return { ok: true, id: `r${h.reservations.length}` };
      }),
  };
  const deps: DemoDeps = {
    modelCallsOn: options.modelCallsOn ?? true,
    visitor: "visitor-key",
    reserveTicket: (v, w) => h.reserve(v, w),
    settle: async (id, actual) => {
      h.settled.push({ id, actual });
    },
    waitUntil: (p) => {
      waits.push(p);
    },
    ...(options.maxTickets === undefined ? {} : { maxTickets: options.maxTickets }),
  };
  const tokens: Record<string, string> = {};

  async function request(
    method: string,
    path: string,
    body?: unknown,
    opts: { identity?: string | null; headers?: Record<string, string> } = {},
  ) {
    const headers: Record<string, string> = {
      Host: "127.0.0.1:8787",
      [SESSION_HEADER]: "s",
      [TOKEN_HEADER]: TOKEN,
      Origin: BASE,
    };
    if (opts.identity) headers[IDENTITY_HEADER] = opts.identity;
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    Object.assign(headers, opts.headers);
    const res = await handleDemoApi(
      new Request(BASE + path, init),
      session,
      hash,
      signIns,
      directory,
      deps,
    );
    return { status: res.status, data: (await res.json()) as Record<string, unknown> };
  }

  async function signIn(side: "requester" | "helpdesk", email: string) {
    const r = await request("POST", "/api/sign-in", { side, email });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    tokens[side] = r.data.token as string;
    return r.data.token as string;
  }

  const as = (side: "requester" | "helpdesk") => tokens[side] as string;

  async function start(side: "requester" | "helpdesk", ticket = "please reset MFA") {
    const r = await request("POST", "/api/runs", { ticket }, { identity: as(side) });
    assert.equal(r.status, 202, JSON.stringify(r.data));
    return r.data.run_id as string;
  }

  async function view(runId: string, side: "requester" | "helpdesk" = "helpdesk") {
    return request("GET", `/api/runs/${runId}`, undefined, { identity: as(side) });
  }

  async function waitFor(runId: string, until: (d: Record<string, unknown>) => boolean) {
    const deadline = Date.now() + 5_000;
    for (;;) {
      const r = await view(runId);
      if (until(r.data)) return r.data;
      if (Date.now() > deadline) throw new Error(`timed out: ${JSON.stringify(r.data)}`);
      await new Promise((res) => setTimeout(res, 5));
    }
  }

  const pendingOf = async (runId: string) =>
    (await waitFor(runId, (d) => d.pending !== null)).pending as Record<string, unknown>;
  const finished = async (runId: string) => {
    const d = await waitFor(runId, (x) => x.status !== "running");
    await Promise.all(waits);
    return d;
  };
  const decide = (runId: string, proposalId: unknown, decision: string, side = "helpdesk") =>
    request(
      "POST",
      `/api/runs/${runId}/decision`,
      { proposal_id: proposalId, decision },
      { identity: as(side as "requester" | "helpdesk") },
    );

  return {
    session,
    store,
    client,
    h,
    as,
    request,
    signIn,
    start,
    view,
    pendingOf,
    finished,
    decide,
  };
}

const auditEvents = (store: MemoryStore) => store.audit.map((r) => r.event);

// ---------------------------------------------------------------- sign-in

test("ts_t2_each_side_signs_in_only_as_its_own_personas", async () => {
  const d = await demo([]);
  const lists = personas(Directory.load());
  assert.deepEqual(
    lists.helpdesk.map((p) => p.email),
    [ROSA, THEO],
  );
  assert.ok(lists.requester.some((p) => p.email === JAMIE));
  // No it-support member signs in on the left, not even the super admin.
  assert.ok(
    !lists.requester.some((p) => [ROSA, THEO, "sam.whitfield@example.test"].includes(p.email)),
  );
  for (const [side, email] of [
    ["requester", ROSA],
    ["requester", "sam.whitfield@example.test"],
    ["helpdesk", JAMIE],
    ["helpdesk", "sam.whitfield@example.test"],
    ["helpdesk", "nobody@example.test"],
    ["admin", ROSA],
  ]) {
    const r = await d.request("POST", "/api/sign-in", { side, email });
    assert.equal(r.status, 400, `${side} ${email}`);
  }
  const ok = await d.request("POST", "/api/sign-in", { side: "helpdesk", email: THEO });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.simulated, true);
});

test("ts_t2_routes_need_a_side_token_from_this_session", async () => {
  const d = await demo([]);
  const none = await d.request("GET", "/api/current");
  assert.equal(none.status, 401);
  const forged = await d.request("GET", "/api/current", undefined, { identity: "a.b.c" });
  assert.equal(forged.status, 401);
  // A real token from another session's issuer fails here.
  const other = new SideSignIns(new DevIssuer());
  const { token } = await other.signIn("helpdesk", ROSA);
  assert.equal((await d.request("GET", "/api/log", undefined, { identity: token })).status, 401);
  // Without this session's own token nothing is answered, side token or not.
  const wrongSession = await d.request("GET", "/api/current", undefined, {
    identity: token,
    headers: { [TOKEN_HEADER]: "x".repeat(64) },
  });
  assert.equal(wrongSession.status, 403);
});

test("ts_t2_the_requester_is_the_signed_in_persona_not_the_body", async () => {
  const d = await demo([DONE]);
  await d.signIn("requester", JAMIE);
  const r = await d.request(
    "POST",
    "/api/runs",
    { requester: PRIYA, ticket: "hello" },
    { identity: d.as("requester") },
  );
  assert.equal(r.status, 202);
  await d.signIn("helpdesk", THEO);
  const done = await d.finished(r.data.run_id as string);
  assert.equal(done.requester, JAMIE);
});

// ---------------------------------------------------------------- separation of duties

test("ts_t2_a_helpdesk_filed_reset_needs_the_other_persona", async () => {
  const d = await demo([reset(JAMIE), DONE]);
  await d.signIn("helpdesk", THEO);
  const runId = await d.start("helpdesk", `Please reset MFA for ${JAMIE}`);
  const pending = await d.pendingOf(runId);
  assert.equal(pending.requester, THEO);
  // Theo filed it: his own Approve is refused, with the rule, and the write stays pending.
  const own = await d.decide(runId, pending.id, "approve");
  assert.equal(own.status, 409);
  assert.match(String(own.data.rule), /filed this request, and nobody approves their own request/);
  const still = await d.pendingOf(runId);
  assert.equal(still.id, pending.id);
  assert.deepEqual(
    (still.refusals as { approver: string }[]).map((r) => r.approver),
    [THEO],
  );
  assert.equal(d.session.peek(runId)?.status, "running");
  // Switch the right side to Rosa: her Approve runs the reset.
  await d.signIn("helpdesk", ROSA);
  const rosa = await d.decide(runId, pending.id, "approve");
  assert.equal(rosa.status, 200, JSON.stringify(rosa.data));
  assert.equal(rosa.data.by, ROSA);
  const done = await d.finished(runId);
  assert.equal(done.status, "answered");
  const call = (done.events as Record<string, unknown>[]).find((e) => e.tool === "reset_mfa");
  assert.equal(call?.decision, "approved");
  const approved = d.store.audit.find((r) => r.event === "write_approved");
  assert.equal(approved?.approver, ROSA);
  const refused = d.store.audit.find((r) => r.event === "approval_refused");
  assert.equal(refused?.approver, THEO);
  assert.ok(
    auditEvents(d.store).indexOf("approval_refused") <
      auditEvents(d.store).indexOf("write_approved"),
  );
});

test("ts_t2_the_left_side_can_never_approve", async () => {
  const d = await demo([reset(JAMIE), DONE]);
  await d.signIn("requester", JAMIE);
  await d.signIn("helpdesk", THEO);
  const runId = await d.start("requester", "reset my MFA");
  const pending = await d.pendingOf(runId);
  for (const choice of ["approve", "deny"]) {
    const r = await d.decide(runId, pending.id, choice, "requester");
    assert.equal(r.status, 403);
    assert.match(String(r.data.error), /requester side can't approve/);
  }
  // Nothing was decided: the helpdesk can still answer it.
  assert.equal((await d.pendingOf(runId)).id, pending.id);
  const deny = await d.decide(runId, pending.id, "deny");
  assert.equal(deny.status, 200);
  const done = await d.finished(runId);
  assert.ok(!auditEvents(d.store).includes("write_approved"));
  assert.equal(
    (done.events as Record<string, unknown>[]).find((e) => e.tool === "reset_mfa")?.decision,
    "denied_by_human",
  );
});

test("ts_t2_the_left_side_sees_its_reply_not_the_proposal_or_the_audit", async () => {
  const d = await demo([reset(JAMIE), DONE]);
  await d.signIn("requester", JAMIE);
  await d.signIn("helpdesk", ROSA);
  const runId = await d.start("requester", "reset my MFA");
  await d.pendingOf(runId);
  const left = await d.view(runId, "requester");
  assert.equal(left.status, 200);
  assert.equal(left.data.pending, undefined);
  assert.equal(left.data.events, undefined);
  assert.equal(
    (await d.request("GET", "/api/log", undefined, { identity: d.as("requester") })).status,
    403,
  );
  // Another requester can't read Jamie's run.
  const priya = await d.signIn("requester", PRIYA);
  assert.equal(
    (await d.request("GET", `/api/runs/${runId}`, undefined, { identity: priya })).status,
    404,
  );
  assert.deepEqual((await d.request("GET", "/api/current", undefined, { identity: priya })).data, {
    run_id: null,
  });
});

test("ts_t2_privileged_resets_and_grants_are_refused_before_anyone_is_asked", async () => {
  const grant = message(
    [toolUse("add_to_group", { email: JAMIE, group: "admins" }, "toolu_2")],
    "tool_use",
  );
  const d = await demo([reset(MORGAN), grant, DONE]);
  await d.signIn("helpdesk", THEO);
  const runId = await d.start("helpdesk", "reset Morgan's MFA and make Jamie an admin");
  const done = await d.finished(runId);
  const events = done.events as Record<string, unknown>[];
  assert.equal(events.length, 2);
  for (const e of events) assert.equal(e.decision, "denied_by_policy", JSON.stringify(e));
  assert.equal(done.pending, null);
  assert.ok(!auditEvents(d.store).includes("write_approved"));
});

test("ts_t2_gate_honours_only_its_own_operators", async () => {
  const issuer = new DevIssuer();
  const outsider = await issuer.signIn(ROSA); // a valid sign-in, but not one of the gate's
  const pool = [await issuer.signIn(ROSA), await issuer.signIn(THEO)];
  const gate = new Gate({
    directory: Directory.load(),
    approver: () => new ApprovedBy(outsider),
    audit: new MemoryAudit(),
    escalations: new MemoryEscalations(),
    retriever,
    ticketId: "T-1",
    signIn: await issuer.signIn(JAMIE),
    operators: pool,
  });
  const out = await gate.execute("reset_mfa", { email: JAMIE });
  assert.equal(out.decision, Decision.DENIED_BY_HUMAN);
  assert.throws(
    () =>
      new Gate({
        directory: Directory.load(),
        approver: () => false,
        audit: new MemoryAudit(),
        escalations: new MemoryEscalations(),
        retriever,
        ticketId: "T-2",
        signIn: pool[0] as never,
        operator: pool[0] as never,
        operators: pool,
      }),
    /not both/,
  );
});

// ---------------------------------------------------------------- limits

test("ts_t2_ticket_cap_per_session", async () => {
  const d = await demo([DONE, DONE, DONE], { maxTickets: 2 });
  await d.signIn("requester", JAMIE);
  await d.signIn("helpdesk", THEO);
  await d.finished(await d.start("requester", "one"));
  await d.finished(await d.start("helpdesk", "two"));
  const third = await d.request(
    "POST",
    "/api/runs",
    { ticket: "three" },
    { identity: d.as("requester") },
  );
  assert.equal(third.status, 429);
  assert.match(String(third.data.error), /used its 2 tickets/);
  assert.equal(d.client.requests.length, 2);
  assert.ok(DEMO_MAX_TICKETS <= 20, "the cap counts stored runs, which keep at most 20");
});

test("ts_t2_budget_is_reserved_before_and_settled_after_each_ticket", async () => {
  const d = await demo([DONE]);
  await d.signIn("requester", JAMIE);
  await d.signIn("helpdesk", THEO);
  const runId = await d.start("requester", "hello");
  await d.finished(runId);
  assert.deepEqual(d.h.reservations, [{ visitor: "visitor-key", worst: ticketWorstCaseUsd() }]);
  assert.equal(d.h.settled.length, 1);
  assert.equal(d.h.settled[0]?.id, "r1");
  assert.ok(Math.abs((d.h.settled[0]?.actual ?? 0) - 0.003) < 1e-9); // 1000 in, 100 out
});

test("ts_t2_a_refused_reservation_or_the_kill_switch_makes_no_model_call", async () => {
  const refused = await demo([DONE], {
    reserve: async () => ({ ok: false, reason: "You've reached today's limit of demo tickets." }),
  });
  await refused.signIn("requester", JAMIE);
  const r = await refused.request(
    "POST",
    "/api/runs",
    { ticket: "hi" },
    { identity: await refused.signIn("requester", JAMIE) },
  );
  assert.equal(r.status, 429);
  assert.equal(refused.client.requests.length, 0);
  const broken = await demo([DONE], { reserve: async () => Promise.reject(new Error("down")) });
  const b = await broken.request(
    "POST",
    "/api/runs",
    { ticket: "hi" },
    { identity: await broken.signIn("requester", JAMIE) },
  );
  assert.equal(b.status, 503);
  assert.equal(broken.client.requests.length, 0);
  const off = await demo([DONE], { modelCallsOn: false });
  const o = await off.request(
    "POST",
    "/api/runs",
    { ticket: "hi" },
    { identity: await off.signIn("requester", JAMIE) },
  );
  assert.equal(o.status, 503);
  assert.equal(off.client.requests.length, 0);
  assert.equal(off.h.reservations.length, 0);
});

test("ts_t2_one_ticket_worst_case_fits_the_daily_budget_twice", () => {
  // DEFAULT_LIMITS.dailyUsd is $2; a ticket's worst case must leave room for another.
  assert.ok(ticketWorstCaseUsd() < 1, String(ticketWorstCaseUsd()));
});

// ---------------------------------------------------------------- session creation

function newSessionDeps(over: Partial<Parameters<typeof handleNewSession>[1]> = {}) {
  const calls: string[] = [];
  const deps: Parameters<typeof handleNewSession>[1] = {
    modelCallsOn: true,
    saltSet: true,
    visitor: "v",
    remoteip: "203.0.113.7",
    verifyTurnstile: async (token) => {
      calls.push("turnstile");
      return token === "good";
    },
    allowSession: async () => {
      calls.push("allow");
      return true;
    },
    create: async () => {
      calls.push("create");
      return { session: "a".repeat(64), token: "b".repeat(64) };
    },
    ...over,
  };
  return { deps, calls };
}

test("ts_t2_new_sessions_need_turnstile_then_the_visitor_limit", async () => {
  const ok = newSessionDeps();
  assert.equal((await handleNewSession({ turnstile: "good" }, ok.deps)).status, 201);
  assert.deepEqual(ok.calls, ["turnstile", "allow", "create"]);

  const noToken = newSessionDeps();
  assert.equal((await handleNewSession({}, noToken.deps)).status, 403);
  assert.deepEqual(noToken.calls, ["turnstile"]);

  const limited = newSessionDeps({ allowSession: async () => false });
  const r = await handleNewSession({ turnstile: "good" }, limited.deps);
  assert.equal(r.status, 429);
  assert.ok(!limited.calls.includes("create"));

  for (const over of [{ modelCallsOn: false }, { saltSet: false }]) {
    const off = newSessionDeps(over);
    assert.equal((await handleNewSession({ turnstile: "good" }, off.deps)).status, 503);
    assert.deepEqual(off.calls, []); // checked before Turnstile is even asked
  }

  const ledgerDown = newSessionDeps({ allowSession: async () => Promise.reject(new Error("x")) });
  assert.equal((await handleNewSession({ turnstile: "good" }, ledgerDown.deps)).status, 503);
  const siteverifyDown = newSessionDeps({
    verifyTurnstile: async () => Promise.reject(new Error("x")),
  });
  assert.equal((await handleNewSession({ turnstile: "good" }, siteverifyDown.deps)).status, 403);
});
