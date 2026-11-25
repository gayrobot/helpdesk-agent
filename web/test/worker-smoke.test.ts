// Runs the real Worker in workerd (no key, no network) and checks the core bundles and
// works there: the bundled runbooks give the same chunks as the files Node reads.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { bundledChunks, bundledRunbookSources } from "../src/bundled.ts";
import { HOST, startLocalWorker } from "../src/node/dev-worker.ts";
import { loadRunbooks, runbookSources } from "../src/node/runbooks.ts";

test("bundled runbooks equal the runbook folder, file for file", () => {
  assert.deepEqual(
    Object.fromEntries(bundledRunbookSources()),
    Object.fromEntries(runbookSources()),
  );
  assert.deepEqual(bundledChunks(), loadRunbooks());
  assert.equal(bundledChunks().length, 65);
});

let worker: Awaited<ReturnType<typeof startLocalWorker>>;
let base: URL;

before(async () => {
  worker = await startLocalWorker(0);
  base = await worker.url;
});

after(async () => {
  await worker?.dispose();
});

test("the Worker listens on loopback only", () => {
  assert.equal(base.hostname, HOST);
});

test("health: the core runs in workerd with the bundled data", async () => {
  const res = await fetch(new URL("/api/health", base));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, runbooks: 14, chunks: 65, users: 30 });
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
});

test("unknown routes are 404, and the local explorer API is off", async () => {
  assert.equal((await fetch(new URL("/", base))).status, 404);
  const explorer = await fetch(new URL("/cdn-cgi/local/explorer/api/local/workers", base));
  assert.equal(explorer.status, 404);
});
