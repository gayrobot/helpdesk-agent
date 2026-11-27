// Tier 2 on the public hostname, end to end in workerd (test/worker/entry-public.ts opens
// it there; the real build opens it only with TIER2_PUBLIC). Requests carry the site's
// Host, as on hddemo.damiano.dev. workerd's dev server sets CF-Connecting-IP to the real
// client address, so every request here is one visitor: the tests run in order through
// that visitor's day (4 sessions, 2 tickets; wrangler.public.jsonc). Different visitors
// counting apart is tested on the ledger itself (test/budget.test.ts).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { HOST, startLocalWorker } from "../src/node/dev-worker.ts";

const SITE = "demo.example.test";
const CONFIG = new URL("./worker/wrangler.public.jsonc", import.meta.url).pathname;
let worker: Awaited<ReturnType<typeof startLocalWorker>>;
let port = 0;
// Fresh Durable Object state: the site budget must start the day empty.
const state = mkdtempSync(join(tmpdir(), "helpdesk-public-"));

before(async () => {
  worker = await startLocalWorker(0, CONFIG, state);
  port = Number((await worker.url).port);
});

after(async () => {
  await worker?.dispose();
  rmSync(state, { recursive: true, force: true });
});

async function raw(
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: unknown,
) {
  const { request } = await import("node:http");
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const all: Record<string, string> = { Host: SITE, ...headers };
  if (payload !== undefined) {
    all["Content-Type"] = "application/json";
    all.Origin = `http://${SITE}`;
  }
  return new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
    const req = request({ host: HOST, port, path, method, headers: all }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        let parsed: Record<string, unknown> = {};
        try {
          parsed = JSON.parse(data);
        } catch {}
        resolve({ status: res.statusCode ?? 0, body: parsed });
      });
    });
    req.on("error", reject);
    req.end(payload);
  });
}

const HUMAN = { turnstile: "test-human" };

async function session() {
  const created = await raw("POST", "/api/sessions", {}, HUMAN);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const base = {
    "X-Helpdesk-Session": created.body.session as string,
    "X-Helpdesk-Token": created.body.token as string,
  };
  const sides: Record<string, string> = {};
  const as = (side?: string) => ({
    ...base,
    ...(side && sides[side] ? { "X-Helpdesk-Identity": sides[side] as string } : {}),
  });
  const signIn = async (side: string, email: string) => {
    const r = await raw("POST", "/api/sign-in", as(), { side, email });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    sides[side] = r.body.token as string;
  };
  return { as, signIn };
}

/** Start a ticket from the helpdesk side and deny any write; the status of the start. */
async function runTicket(s: Awaited<ReturnType<typeof session>>, ticket: string) {
  const r = await raw("POST", "/api/runs", s.as("helpdesk"), { ticket });
  if (r.status !== 202) return r.status;
  const deadline = Date.now() + 15_000;
  for (;;) {
    const snap = (await raw("GET", `/api/runs/${r.body.run_id}`, s.as("helpdesk"))).body;
    if (snap.pending) {
      await raw("POST", `/api/runs/${r.body.run_id}/decision`, s.as("helpdesk"), {
        proposal_id: (snap.pending as Record<string, unknown>).id,
        decision: "deny",
      });
    }
    if (snap.status !== "running" || Date.now() > deadline) return 202;
    await new Promise((res) => setTimeout(res, 50));
  }
}

test("ts_t2_public_config_says_the_demo_is_open", async () => {
  const config = await raw("GET", "/api/config");
  assert.deepEqual(config.body.tiers, { ask: true, demo: true, signIn: false });
});

test("ts_t2_public_sessions_need_turnstile", async () => {
  // (Without CF-Connecting-IP the Worker refuses too, but workerd's dev server always
  // adds that header, as Cloudflare does, so it can't be left out here.)
  assert.equal((await raw("POST", "/api/sessions", {}, {})).status, 403);
  assert.equal((await raw("POST", "/api/sessions", {}, { turnstile: "nope" })).status, 403);
  await session(); // the visitor's 1st session today
});

test("ts_t2_public_full_flow_and_the_left_side_cannot_approve", async () => {
  const s = await session(); // 2nd
  await s.signIn("requester", "jamie@example.test");
  await s.signIn("helpdesk", "rosa.delgado@example.test");
  const started = await raw("POST", "/api/runs", s.as("requester"), { ticket: "reset my MFA" });
  assert.equal(started.status, 202, JSON.stringify(started.body)); // 1st ticket
  const runId = started.body.run_id as string;
  let snap: Record<string, unknown> = {};
  const deadline = Date.now() + 10_000;
  while (!snap.pending && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
    snap = (await raw("GET", `/api/runs/${runId}`, s.as("helpdesk"))).body;
  }
  const pending = snap.pending as Record<string, unknown>;
  assert.equal(pending.tool, "reset_mfa");
  const decide = (side: string, decision: string) =>
    raw("POST", `/api/runs/${runId}/decision`, s.as(side), { proposal_id: pending.id, decision });
  assert.equal((await decide("requester", "approve")).status, 403);
  assert.equal((await decide("requester", "deny")).status, 403);
  assert.equal((await decide("helpdesk", "deny")).status, 200);
  // The requester's view of the same run has no proposal; the audit is helpdesk-only.
  const left = await raw("GET", `/api/runs/${runId}`, s.as("requester"));
  assert.equal(left.status, 200);
  assert.equal(left.body.pending, undefined);
  assert.equal((await raw("GET", "/api/log", s.as("requester"))).status, 403);
  assert.equal((await raw("GET", "/api/log", s.as("helpdesk"))).status, 200);
});

test("ts_t2_public_routes_outside_the_allowlist_stay_closed", async () => {
  const s = await session(); // 3rd
  await s.signIn("helpdesk", "theo.park@example.test");
  for (const path of [
    "/api/admin/users",
    "/api/users/jamie@example.test",
    "/api/budget",
    "/api/runs/not-a-run",
    "/api/runs/0123456789abcdef/receipt",
    "/api/sessions/list",
  ]) {
    assert.equal((await raw("GET", path, s.as("helpdesk"))).status, 404, path);
  }
  // A host that isn't the site is refused before anything else.
  assert.equal((await raw("GET", "/api/config", { Host: "evil.example" })).status, 403);
});

test("ts_t2_public_tickets_per_visitor_per_day_across_sessions", async () => {
  const s = await session(); // 4th: a new session doesn't reset the visitor's tickets
  await s.signIn("helpdesk", "theo.park@example.test");
  assert.equal(await runTicket(s, "is Jamie active?"), 202); // 2nd ticket
  assert.equal(await runTicket(s, "is Priya active?"), 429); // over the visitor's 2
});

test("ts_t2_public_sessions_per_visitor_per_day", async () => {
  const fifth = await raw("POST", "/api/sessions", {}, HUMAN);
  assert.equal(fifth.status, 429);
  assert.match(String(fifth.body.error), /limit of demo sessions/);
});
