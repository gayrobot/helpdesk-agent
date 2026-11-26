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

before(async () => {
  worker = await startLocalWorker(0, CONFIG);
  base = await worker.url;
});

after(async () => {
  await worker?.dispose();
});

const origin = () => base.origin;

async function newSession(headers: Record<string, string> = {}) {
  return fetch(new URL("/api/sessions", base), {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin(), ...headers },
    body: "{}",
  });
}

async function session() {
  const res = await newSession();
  assert.equal(res.status, 201);
  const { session: id, token } = (await res.json()) as { session: string; token: string };
  const call = async (
    method: string,
    path: string,
    body?: unknown,
    extra: Record<string, string> = {},
  ) => {
    const headers: Record<string, string> = {
      "X-Helpdesk-Session": id,
      "X-Helpdesk-Token": token,
      Origin: origin(),
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
  return { id, token, call };
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
  assert.ok((await page.text()).includes("Helpdesk agent"));
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
  const started = await s.call("POST", "/api/runs", {
    requester: "jamie@example.test",
    ticket: "Lost my phone, please reset my MFA",
  });
  assert.equal(started.status, 202);
  const runId = started.data.run_id as string;

  // The POST has returned; the loop must still reach the write and wait for a click.
  let snap = (await s.call("GET", `/api/runs/${runId}`)).data;
  const deadline = Date.now() + 10_000;
  while (!snap.pending && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
    snap = (await s.call("GET", `/api/runs/${runId}`)).data;
  }
  const pending = snap.pending as Record<string, unknown>;
  assert.equal(pending.tool, "reset_mfa");
  assert.equal(pending.requester_is_target, true);

  // Too soon: the review delay (200 ms in the test build) refuses it.
  const early = await s.call("POST", `/api/runs/${runId}/decision`, {
    proposal_id: pending.id,
    decision: "approve",
  });
  assert.equal(early.status, 409);
  await new Promise((r) => setTimeout(r, 250));
  const approved = await s.call("POST", `/api/runs/${runId}/decision`, {
    proposal_id: pending.id,
    decision: "approve",
  });
  assert.equal(approved.status, 200);

  while (snap.status === "running" && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
    snap = (await s.call("GET", `/api/runs/${runId}`)).data;
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
  const log = (await s.call("GET", "/api/log")).data as { audit: Record<string, unknown>[] };
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
      body: "{}",
    });
    const { session: id, token } = (await created.json()) as Record<string, string>;
    const headers = () => ({
      "X-Helpdesk-Session": id as string,
      "X-Helpdesk-Token": token as string,
      Origin: url.origin,
      "Content-Type": "application/json",
    });
    const started = await fetch(new URL("/api/runs", url), {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ requester: "jamie@example.test", ticket: "reset my MFA" }),
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
