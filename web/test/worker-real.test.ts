// The real client code inside workerd, against a stub Messages API on 127.0.0.1 (never
// the real API). The key is a dummy and travels as the real one will: from this process's
// environment, through wrangler's required secret, into the Worker's environment, where
// the SDK reads it. Checks the SDK finds the key and the base URL, the background loop's
// network calls complete after the starting request has returned, and the call log
// records request ids and costs, with the key in no response.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { startLocalWorker } from "../src/node/dev-worker.ts";

const DUMMY_KEY = "sk-ant-dummy-not-a-real-key-0000";
const seen: { headers: IncomingMessage["headers"]; body: Record<string, unknown> }[] = [];
let n = 0;

function reply(content: unknown[], stop: string) {
  n += 1;
  return {
    id: `msg_stub_${n}`,
    type: "message",
    role: "assistant",
    model: "claude-sonnet-5-5",
    content,
    stop_reason: stop,
    stop_sequence: null,
    stop_details: null,
    usage: {
      input_tokens: 1200,
      output_tokens: 60,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  };
}

const stub = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    seen.push({ headers: req.headers, body: JSON.parse(raw || "{}") });
    const body =
      seen.length % 2 === 1
        ? reply(
            [
              {
                type: "tool_use",
                id: "t1",
                name: "lookup_user",
                input: { email: "jamie@example.test" },
              },
            ],
            "tool_use",
          )
        : reply(
            [{ type: "text", text: "You're active. Source: okta-verify-reenrollment" }],
            "end_turn",
          );
    res.writeHead(200, {
      "Content-Type": "application/json",
      "request-id": `req_stub_${seen.length}`,
    });
    res.end(JSON.stringify(body));
  });
});

let worker: Awaited<ReturnType<typeof startLocalWorker>>;
let base: URL;
let state: string;
const saved = { key: process.env.ANTHROPIC_API_KEY, url: process.env.ANTHROPIC_BASE_URL };

before(async () => {
  await new Promise<void>((r) => stub.listen(0, "127.0.0.1", r));
  process.env.ANTHROPIC_API_KEY = DUMMY_KEY;
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
  state = mkdtempSync(join(tmpdir(), "helpdesk-real-"));
  worker = await startLocalWorker(
    0,
    new URL("./worker/wrangler.real.jsonc", import.meta.url).pathname,
    state,
  );
  base = await worker.url;
});

after(async () => {
  await worker?.dispose();
  stub.close();
  rmSync(state, { recursive: true, force: true });
  for (const [k, v] of [
    ["ANTHROPIC_API_KEY", saved.key],
    ["ANTHROPIC_BASE_URL", saved.url],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

test("ts_real_client_runs_in_workerd_against_a_stub_api", async () => {
  const bodies: string[] = [];
  const created = await fetch(new URL("/api/sessions", base), {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: base.origin },
    body: JSON.stringify({ turnstile: "test-human" }),
  });
  bodies.push(await created.clone().text());
  const { session, token } = (await created.json()) as Record<string, string>;
  const headers: Record<string, string> = {
    "X-Helpdesk-Session": session as string,
    "X-Helpdesk-Token": token as string,
    Origin: base.origin,
    "Content-Type": "application/json",
  };
  // One side signed in is enough here: the helpdesk files the ticket and reads the log.
  const signedIn = await fetch(new URL("/api/sign-in", base), {
    method: "POST",
    headers,
    body: JSON.stringify({ side: "helpdesk", email: "theo.park@example.test" }),
  });
  bodies.push(await signedIn.clone().text());
  headers["X-Helpdesk-Identity"] = ((await signedIn.json()) as Record<string, string>)
    .token as string;
  const started = await fetch(new URL("/api/runs", base), {
    method: "POST",
    headers,
    body: JSON.stringify({ ticket: "is jamie@example.test active?" }),
  });
  assert.equal(started.status, 202);
  const { run_id: runId } = (await started.json()) as Record<string, string>;

  let snap: Record<string, unknown> = { status: "running" };
  const deadline = Date.now() + 15_000;
  while (snap.status === "running" && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    const res = await fetch(new URL(`/api/runs/${runId}`, base), { headers });
    const text = await res.text();
    bodies.push(text);
    snap = JSON.parse(text);
  }
  assert.equal(snap.status, "answered", JSON.stringify(snap));

  // The SDK found the dummy key and the stub's address in the Worker's environment.
  assert.equal(seen.length, 2);
  for (const call of seen) {
    // SDK 1.10.0 sends the API key as a bearer token (the live TypeScript eval used the
    // same code path from Node).
    assert.equal(call.headers.authorization, `Bearer ${DUMMY_KEY}`);
    assert.equal(call.headers["anthropic-version"], "2026-10-21");
    // The public demo's settings: capped output and no refusal fallback (src/demo.ts).
    assert.ok(!String(call.headers["anthropic-beta"] ?? "").includes("server-side-fallback"));
    assert.equal(call.body.model, "claude-sonnet-5-5");
    assert.equal(call.body.max_tokens, 2_000);
    assert.equal(call.body.fallbacks, undefined);
  }

  const logRes = await fetch(new URL("/api/log", base), { headers });
  const logText = await logRes.text();
  bodies.push(logText);
  const log = JSON.parse(logText) as { calls: Record<string, unknown>[] };
  assert.deepEqual(
    log.calls.map((c) => c.request_id),
    ["req_stub_1", "req_stub_2"],
  );
  assert.ok(log.calls.every((c) => Number(c.cost_usd) > 0));
  for (const b of bodies) assert.ok(!b.includes(DUMMY_KEY), "the key must not reach a response");
});
