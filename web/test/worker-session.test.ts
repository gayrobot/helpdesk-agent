// The whole thing in workerd: the page, session creation, the Durable Object and the
// approval flow, using the test build (test/worker/entry.ts: a scripted model, no key).
// Twins of the test_webui.py cases that need a real server, plus the runtime behaviour
// unit tests can't show: a run keeps going after the request that started it returns.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { HOST, startLocalWorker } from "../src/node/dev-worker.ts";

let worker: Awaited<ReturnType<typeof startLocalWorker>>;
let base: URL;
const CONFIG = new URL("./worker/wrangler.test.jsonc", import.meta.url).pathname;

// Fresh Durable Object state, so the site budget's daily session counts start at zero.
const freshState = mkdtempSync(join(tmpdir(), "helpdesk-session-"));

before(async () => {
  worker = await startLocalWorker(0, CONFIG, freshState);
  base = await worker.url;
});

after(async () => {
  await worker?.dispose();
  rmSync(freshState, { recursive: true, force: true });
});

const origin = () => base.origin;

// The test build's Turnstile accepts only this token (test/worker/entry.ts).
const HUMAN = JSON.stringify({ turnstile: "test-human" });

async function newSession(headers: Record<string, string> = {}, body = HUMAN) {
  return fetch(new URL("/api/sessions", base), {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin(), ...headers },
    body,
  });
}

type Side = "requester" | "helpdesk";

async function session() {
  const res = await newSession();
  assert.equal(res.status, 201);
  const { session: id, token } = (await res.json()) as { session: string; token: string };
  const sides: Partial<Record<Side, string>> = {};
  const call = async (
    method: string,
    path: string,
    body?: unknown,
    side?: Side,
    extra: Record<string, string> = {},
  ) => {
    const headers: Record<string, string> = {
      "X-Helpdesk-Session": id,
      "X-Helpdesk-Token": token,
      Origin: origin(),
      ...(side && sides[side] ? { "X-Helpdesk-Identity": sides[side] as string } : {}),
      ...extra,
    };
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    const r = await fetch(new URL(path, base), init);
    return { status: r.status, data: (await r.json()) as Record<string, unknown> };
  };
  const signIn = async (side: Side, email: string) => {
    const r = await call("POST", "/api/sign-in", { side, email });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    sides[side] = r.data.token as string;
  };
  return { id, token, call, signIn };
}

test("test_binds_to_loopback_only", () => {
  assert.equal(base.hostname, HOST);
});

test("test_page_carries_token_and_security_headers", async () => {
  // The page carries no token now: it asks for a session. It must still be served with
  // the strict headers, and the session endpoint must send no CORS headers.
  const page = await fetch(base);
  assert.equal(page.status, 200);
  const csp = page.headers.get("content-security-policy") ?? "";
  assert.ok(csp.includes("frame-ancestors 'none'"));
  assert.ok(csp.includes("script-src 'self'"));
  assert.ok(!csp.includes("unsafe-inline"));
  assert.equal(page.headers.get("x-content-type-options"), "nosniff");
  assert.ok((await page.text()).includes("Helpdesk demo"));
  const created = await newSession();
  assert.equal(created.status, 201);
  assert.equal(created.headers.get("access-control-allow-origin"), null);
});

for (const path of [
  "/index.htm",
  "/../wrangler.jsonc",
  "/.env.tpl",
  "/src/api.ts",
  "/_headers",
  "/x",
]) {
  test(`test_only_listed_static_files_exist[${path}]`, async () => {
    const res = await fetch(new URL(path, base));
    assert.equal(res.status, 404, path);
  });
}

test("ts_sessions_are_created_only_from_this_page", async () => {
  assert.equal((await newSession({ Origin: "http://evil.example" })).status, 403);
  const noOrigin = await fetch(new URL("/api/sessions", base), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(noOrigin.status, 403);
  assert.equal((await newSession({ "Content-Type": "text/plain" })).status, 400);
  // No Turnstile token, or a wrong one: no session.
  assert.equal((await newSession({}, "{}")).status, 403);
  assert.equal((await newSession({}, JSON.stringify({ turnstile: "nope" }))).status, 403);
});

test("ts_unknown_session_or_wrong_token_is_refused", async () => {
  const s = await session();
  const other = await session();
  const get = (sessionId: string, token: string) =>
    fetch(new URL("/api/requesters", base), {
      headers: { "X-Helpdesk-Session": sessionId, "X-Helpdesk-Token": token },
    });
  assert.equal((await get(s.id, s.token)).status, 200);
  assert.equal((await get(s.id, other.token)).status, 403); // another session's token
  assert.equal((await get("0".repeat(64), s.token)).status, 403); // not a real id
  assert.equal((await get("not-an-id", s.token)).status, 403);
  // A real id that was never initialised (no token) is refused by the object itself.
  const fresh = (s.id.slice(0, -1) + (s.id.endsWith("0") ? "1" : "0")).toLowerCase();
  assert.equal((await get(fresh, s.token)).status, 403);
});

test("ts_a_run_keeps_going_after_the_request_that_started_it", async () => {
  const s = await session();
  await s.signIn("requester", "jamie@example.test");
  await s.signIn("helpdesk", "theo.park@example.test");
  const started = await s.call(
    "POST",
    "/api/runs",
    { ticket: "Lost my phone, please reset my MFA" },
    "requester",
  );
  assert.equal(started.status, 202);
  const runId = started.data.run_id as string;

  // The POST has returned; the loop must still reach the write and wait for a click.
  const view = async () => (await s.call("GET", `/api/runs/${runId}`, undefined, "helpdesk")).data;
  let snap = await view();
  const deadline = Date.now() + 10_000;
  while (!snap.pending && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
    snap = await view();
  }
  const pending = snap.pending as Record<string, unknown>;
  assert.equal(pending.tool, "reset_mfa");
  assert.equal(pending.requester_is_target, true);
  const decide = (side: Side) =>
    s.call(
      "POST",
      `/api/runs/${runId}/decision`,
      { proposal_id: pending.id, decision: "approve" },
      side,
    );

  // The requester's side can't approve, whatever the timing.
  assert.equal((await decide("requester")).status, 403);
  // Too soon: the review delay (200 ms in the test build) refuses it.
  assert.equal((await decide("helpdesk")).status, 409);
  await new Promise((r) => setTimeout(r, 250));
  const approved = await decide("helpdesk");
  assert.equal(approved.status, 200);

  while (snap.status === "running" && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
    snap = await view();
  }
  assert.equal(snap.status, "answered");
  const events = snap.events as Record<string, unknown>[];
  assert.deepEqual(
    events.map((e) => [e.tool, e.decision]),
    [
      ["lookup_user", "allowed"],
      ["reset_mfa", "approved"],
    ],
  );
  assert.ok(String(snap.final_text).includes("MFA"));

  // The session's own audit trail, stored in the Durable Object: the approval is recorded
  // before the write's tool_call record.
  assert.equal((await s.call("GET", "/api/log", undefined, "requester")).status, 403);
  const log = (await s.call("GET", "/api/log", undefined, "helpdesk")).data as {
    audit: Record<string, unknown>[];
  };
  assert.deepEqual(
    log.audit.map((r) => [r.event, r.tool, r.decision ?? null]),
    [
      ["tool_call", "lookup_user", "allowed"],
      ["write_approved", "reset_mfa", null],
      ["tool_call", "reset_mfa", "approved"],
    ],
  );
});

test("test_wrong_host_header_is_refused", async () => {
  // fetch() can't set Host, so this uses a raw HTTP request (DNS rebinding sends the
  // attacker's hostname to this address).
  const { request } = await import("node:http");
  const status = await new Promise<number>((resolve, reject) => {
    const req = request(
      {
        host: HOST,
        port: Number(base.port),
        path: "/api/sessions",
        method: "POST",
        headers: {
          Host: "evil.example",
          Origin: "http://evil.example",
          "Content-Type": "application/json",
        },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on("error", reject);
    req.end("{}");
  });
  assert.equal(status, 403);
});

test("ts_restart_mid_proposal_comes_back_interrupted_with_no_write", async () => {
  // A second Worker on its own state folder: start a run, leave the write pending, stop
  // the Worker, start it again on the same state, and read the run back.
  const state = mkdtempSync(join(tmpdir(), "helpdesk-do-state-"));
  try {
    let w = await startLocalWorker(0, CONFIG, state);
    let url = await w.url;
    const created = await fetch(new URL("/api/sessions", url), {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: url.origin },
      body: HUMAN,
    });
    const { session: id, token } = (await created.json()) as Record<string, string>;
    const sides: Record<string, string> = {};
    const headers = (side = "helpdesk") => ({
      "X-Helpdesk-Session": id as string,
      "X-Helpdesk-Token": token as string,
      "X-Helpdesk-Identity": sides[side] ?? "",
      Origin: url.origin,
      "Content-Type": "application/json",
    });
    const signIn = async (side: string, email: string) => {
      const r = await fetch(new URL("/api/sign-in", url), {
        method: "POST",
        headers: headers(side),
        body: JSON.stringify({ side, email }),
      });
      sides[side] = ((await r.json()) as Record<string, string>).token as string;
    };
    await signIn("requester", "jamie@example.test");
    await signIn("helpdesk", "rosa.delgado@example.test");
    const started = await fetch(new URL("/api/runs", url), {
      method: "POST",
      headers: headers("requester"),
      body: JSON.stringify({ ticket: "reset my MFA" }),
    });
    const { run_id: runId } = (await started.json()) as Record<string, string>;
    const deadline = Date.now() + 10_000;
    let snap: Record<string, unknown> = {};
    while (!snap.pending && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
      snap = (await (
        await fetch(new URL(`/api/runs/${runId}`, url), { headers: headers() })
      ).json()) as Record<string, unknown>;
    }
    assert.ok(snap.pending, "the write should be waiting");
    await w.dispose();

    w = await startLocalWorker(0, CONFIG, state);
    url = await w.url;
    try {
      // The sign-in key was in memory only: the old token is refused, so sign in again.
      const stale = await fetch(new URL(`/api/runs/${runId}`, url), { headers: headers() });
      assert.equal(stale.status, 401);
      await signIn("helpdesk", "rosa.delgado@example.test");
      snap = (await (
        await fetch(new URL(`/api/runs/${runId}`, url), { headers: headers() })
      ).json()) as Record<string, unknown>;
      assert.equal(snap.status, "interrupted");
      assert.equal(snap.pending, null);
      const log = (await (
        await fetch(new URL("/api/log", url), { headers: headers() })
      ).json()) as { audit: Record<string, unknown>[] };
      assert.ok(!log.audit.some((r) => r.event === "write_approved"));
    } finally {
      await w.dispose();
    }
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- the public site (tier 1)

async function raw(
  host: string,
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: string,
) {
  const { request } = await import("node:http");
  return new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
    const req = request(
      { host: HOST, port: Number(base.port), path, method, headers: { Host: host, ...headers } },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          let parsed: Record<string, unknown> = {};
          try {
            parsed = JSON.parse(data);
          } catch {}
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

test("ts_config_on_loopback_uses_the_turnstile_test_key_and_shows_the_demo", async () => {
  const config = await (await fetch(new URL("/api/config", base))).json();
  assert.deepEqual(config, {
    turnstileSiteKey: "1x00000000000000000000AA",
    answersOn: true,
    tiers: { ask: true, demo: true, signIn: false },
  });
});

test("ts_on_the_public_hostname_tier_2_is_off_and_ask_is_guarded", async () => {
  const site = "demo.example.test";
  const config = await raw(site, "GET", "/api/config");
  assert.equal(config.status, 200);
  assert.deepEqual(config.body.tiers, { ask: true, demo: false, signIn: false });
  assert.equal(config.body.turnstileSiteKey, "test-sitekey");
  const json = { "Content-Type": "application/json", Origin: `http://${site}` };
  // The split-screen demo's API doesn't exist on the public hostname yet.
  assert.equal((await raw(site, "POST", "/api/sessions", json, "{}")).status, 404);
  // Nor does any route behind it, with or without a plausible session.
  const sid = { "X-Helpdesk-Session": "0".repeat(64), "X-Helpdesk-Token": "t" };
  for (const path of [
    "/api/current",
    "/api/requesters",
    "/api/log",
    "/api/runs/0123456789abcdef",
  ]) {
    assert.equal((await raw(site, "GET", path, sid)).status, 404, path);
  }
  for (const path of ["/api/sign-in", "/api/runs", "/api/runs/0123456789abcdef/decision"]) {
    assert.equal((await raw(site, "POST", path, { ...json, ...sid }, "{}")).status, 404, path);
  }
  // /api/ask without Cloudflare's visitor IP header, and without a Turnstile token.
  const question = JSON.stringify({ question: "How do I set up the VPN?" });
  assert.equal((await raw(site, "POST", "/api/ask", json, question)).status, 403);
  const withIp = { ...json, "CF-Connecting-IP": "203.0.113.7" };
  assert.equal((await raw(site, "POST", "/api/ask", withIp, question)).status, 403);
  // Wrong origin, and a host that isn't the site.
  assert.equal(
    (await raw(site, "POST", "/api/ask", { ...withIp, Origin: "http://evil.example" }, question))
      .status,
    403,
  );
  assert.equal((await raw("evil.example", "GET", "/api/config")).status, 403);
});

test("ts_each_page_has_its_own_security_policy", async () => {
  const csp = async (path: string) =>
    (await fetch(new URL(path, base))).headers.get("content-security-policy") ?? "";
  const home = await csp("/");
  const ask = await csp("/ask/");
  const demo = await csp("/demo/");
  assert.ok(!home.includes("challenges.cloudflare.com"));
  // The demo page runs Turnstile before a session is created.
  assert.ok(demo.includes("script-src 'self' https://challenges.cloudflare.com"));
  assert.equal(demo.split("Content-Security-Policy").length, 1);
  assert.ok(ask.includes("script-src 'self' https://challenges.cloudflare.com"));
  assert.ok(ask.includes("frame-src https://challenges.cloudflare.com"));
  assert.equal(ask.split("Content-Security-Policy").length, 1); // one policy, not two joined
  assert.ok(!ask.includes("script-src 'self';"));
});
