// The server-side Turnstile check (src/turnstile.ts), against a fake Siteverify.
import assert from "node:assert/strict";
import { test } from "node:test";

import { SITEVERIFY_URL, verifyTurnstile } from "../src/turnstile.ts";

function fakeFetch(reply: unknown, opts: { status?: number; throws?: boolean } = {}) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    if (opts.throws) throw new Error("network down");
    return new Response(typeof reply === "string" ? reply : JSON.stringify(reply), {
      status: opts.status ?? 200,
    });
  }) as unknown as typeof fetch;
  return { f, calls };
}

test("a successful token for the right hostname verifies", async () => {
  const { f, calls } = fakeFetch({ success: true, hostname: "hddemo.damiano.dev" });
  const ok = await verifyTurnstile("tok", {
    secret: "s",
    remoteip: "203.0.113.7",
    expectedHostname: "hddemo.damiano.dev",
    fetch: f,
  });
  assert.equal(ok, true);
  assert.equal(calls[0]?.url, SITEVERIFY_URL);
  assert.deepEqual(calls[0]?.body, { secret: "s", response: "tok", remoteip: "203.0.113.7" });
});

test("every failure is a no", async () => {
  const cases: [string, unknown, Parameters<typeof verifyTurnstile>[1]][] = [
    ["success false", "tok", { secret: "s", fetch: fakeFetch({ success: false }).f }],
    ["success as a string", "tok", { secret: "s", fetch: fakeFetch({ success: "true" }).f }],
    [
      "wrong hostname",
      "tok",
      {
        secret: "s",
        expectedHostname: "a.test",
        fetch: fakeFetch({ success: true, hostname: "b.test" }).f,
      },
    ],
    ["network error", "tok", { secret: "s", fetch: fakeFetch({}, { throws: true }).f }],
    ["HTTP 500", "tok", { secret: "s", fetch: fakeFetch({ success: true }, { status: 500 }).f }],
    ["not JSON", "tok", { secret: "s", fetch: fakeFetch("<html>").f }],
    ["no token", undefined, { secret: "s", fetch: fakeFetch({ success: true }).f }],
    ["empty token", "", { secret: "s", fetch: fakeFetch({ success: true }).f }],
    ["token too long", "x".repeat(2049), { secret: "s", fetch: fakeFetch({ success: true }).f }],
    ["no secret", "tok", { secret: "", fetch: fakeFetch({ success: true }).f }],
  ];
  for (const [name, token, options] of cases) {
    assert.equal(await verifyTurnstile(token, options), false, name);
  }
});
