// The cleanup alarm (Phase 9, Data): a session's storage is deleted a set time after its
// last use. Runs the Worker in workerd with a 1.5 s lifetime (test/worker/entry-ttl.ts).
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { startLocalWorker } from "../src/node/dev-worker.ts";

let worker: Awaited<ReturnType<typeof startLocalWorker>>;
let base: URL;
const CONFIG = new URL("./worker/wrangler.ttl.jsonc", import.meta.url).pathname;
const TTL_MS = 1_500;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  worker = await startLocalWorker(0, CONFIG);
  base = await worker.url;
});

after(async () => {
  await worker?.dispose();
});

async function newSession() {
  const res = await fetch(new URL("/api/sessions", base), {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: base.origin },
    body: JSON.stringify({ turnstile: "test-human" }),
  });
  assert.equal(res.status, 201);
  const { session, token } = (await res.json()) as Record<string, string>;
  return () =>
    fetch(new URL("/api/requesters", base), {
      headers: { "X-Helpdesk-Session": session as string, "X-Helpdesk-Token": token as string },
    });
}

test("ts_t2_an_unused_session_is_deleted_by_its_alarm", async () => {
  const get = await newSession();
  assert.equal((await get()).status, 200);
  const deadline = Date.now() + TTL_MS * 6;
  let status = 200;
  while (status === 200 && Date.now() < deadline) {
    await sleep(500);
    status = (await get()).status;
    if (status === 200) await sleep(TTL_MS); // stay idle for a full lifetime
  }
  // The token hash went with the rest of the storage: the session no longer exists.
  assert.equal(status, 403);
  const body = (await (await get()).json()) as Record<string, string>;
  assert.equal(body.error, "Unknown session.");
});

test("ts_t2_a_session_in_use_is_kept", async () => {
  const get = await newSession();
  const until = Date.now() + TTL_MS * 3;
  while (Date.now() < until) {
    assert.equal((await get()).status, 200);
    await sleep(TTL_MS / 4);
  }
});
