// Twin of tests/test_client.py. Test names match the Python ones.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { APIConnectionError } from "@anthropic-ai/sdk";

import {
  AGENT_MODEL,
  costUsd,
  FALLBACK_BETA,
  MAX_RETRIES,
  MemoryCallLog,
  ModelCaller,
  TIMEOUT_SECONDS,
} from "../src/client.ts";
import { FakeClient, message, text } from "./fakes.ts";

const approx = (a: number | null, b: number) => {
  assert.ok(a !== null);
  assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
};

test("test_client_settings", async () => {
  assert.equal(MAX_RETRIES, 2);
  assert.equal(TIMEOUT_SECONDS, 60);
  // The TypeScript SDK takes milliseconds: the real client must pass 60_000, not 60.
  const source = await readFile(new URL("../src/node/anthropic.ts", import.meta.url), "utf8");
  assert.match(source, /timeout: TIMEOUT_SECONDS \* 1000/);
  assert.doesNotMatch(source, /apiKey/);
});

test("test_cost_sonnet", () => {
  approx(
    costUsd("claude-sonnet-5-5", {
      input_tokens: 1_000_000,
      output_tokens: 100_000,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 1_000_000,
    }),
    2.0 + 1.0 + 0.1,
  );
});

test("test_cost_haiku_long_context_rates", () => {
  approx(
    costUsd("claude-haiku-5-5", { input_tokens: 50_000, output_tokens: 1_000 }),
    (50_000 * 0.1 + 500) / 1e6,
  );
  approx(
    costUsd("claude-haiku-5-5", { input_tokens: 200_000, output_tokens: 1_000 }),
    (200_000 * 0.5 + 1_000 * 2.5) / 1e6,
  );
});

test("test_unknown_model_cost_is_none_not_zero", () => {
  assert.equal(costUsd("claude-something-else", { input_tokens: 5, output_tokens: 5 }), null);
  assert.equal(costUsd("constructor", { input_tokens: 5, output_tokens: 5 }), null);
});

test("test_request_always_sets_max_tokens_model_and_fallback", async () => {
  const fake = new FakeClient([message([text("pong")], "end_turn")]);
  await new ModelCaller(fake, new MemoryCallLog()).create("T1", "test", {
    system: "s",
    messages: [],
  });
  const sent = fake.requests[0] as unknown as Record<string, unknown>;
  assert.equal(sent.model, AGENT_MODEL);
  assert.ok(Number(sent.max_tokens) > 0);
  assert.deepEqual(sent.betas, [FALLBACK_BETA]);
  assert.equal(sent.fallbacks, "default");
  assert.ok(!("tool_choice" in sent)); // forced tool use is a 400 on Sonnet 5.5
});

test("test_one_log_line_per_call_with_required_fields", async () => {
  const log = new MemoryCallLog();
  const fake = new FakeClient([
    message([text("pong")], "end_turn", {
      usage: { input_tokens: 1200, output_tokens: 80, cache_read_input_tokens: 3000 },
    }),
  ]);
  await new ModelCaller(fake, log).create("T1", "test", {
    system: "secret system prompt",
    messages: [{ role: "user", content: "secret ticket text" }],
  });
  assert.equal(log.entries.length, 1);
  const entry = log.entries[0] as Record<string, unknown>;
  for (const key of [
    "model",
    "request_id",
    "input_tokens",
    "output_tokens",
    "cost_usd",
    "latency_ms",
    "stop_reason",
  ]) {
    assert.ok(key in entry, key);
  }
  assert.equal(entry.request_id, "req_fake");
  assert.equal(entry.cache_read_input_tokens, 3000);
  approx(entry.cost_usd as number, (1200 * 2 + 3000 * 0.1 + 80 * 10) / 1e6);
  const line = JSON.stringify(entry);
  assert.ok(!line.includes("secret system prompt")); // prompts never reach the log
  assert.ok(!line.includes("secret ticket text"));
});

test("test_cost_uses_the_model_that_served_the_reply", async () => {
  const log = new MemoryCallLog();
  const fake = new FakeClient([message([text("ok")], "end_turn", { model: "claude-sonnet-5" })]);
  await new ModelCaller(fake, log).create("T1", "t", { system: "", messages: [] });
  assert.equal(log.entries[0]?.model_requested, "claude-sonnet-5-5");
  assert.equal(log.entries[0]?.model, "claude-sonnet-5");
});

test("test_api_errors_are_logged_then_raised", async () => {
  const log = new MemoryCallLog();
  const fake = new FakeClient([new APIConnectionError({ message: "Connection error." })]);
  await assert.rejects(
    new ModelCaller(fake, log).create("T1", "t", { system: "", messages: [] }),
    APIConnectionError,
  );
  assert.equal(log.entries[0]?.error, "APIConnectionError");
  assert.equal(log.entries[0]?.status_code, null);
});

test("test_refusal_category_is_logged", async () => {
  const log = new MemoryCallLog();
  const refusal = message([], "refusal", {
    stop_details: { type: "refusal", category: "cyber", explanation: null },
  });
  await new ModelCaller(new FakeClient([refusal]), log).create("T1", "t", {
    system: "",
    messages: [],
  });
  assert.equal(log.entries[0]?.refusal_category, "cyber");
});

// ---------------------------------------------------------------- TypeScript only

test("ts_unit_tests_never_build_a_real_client", async () => {
  // Only src/node/anthropic.ts may construct the SDK client, and no test imports it.
  const { readdir } = await import("node:fs/promises");
  const dir = new URL("./", import.meta.url);
  for (const name of await readdir(dir)) {
    if (!name.endsWith(".ts")) continue;
    const source = await readFile(new URL(name, dir), "utf8");
    assert.doesNotMatch(source, /from\s+["'][^"']*node\/anthropic/, name);
    assert.doesNotMatch(source, /new Anthropic\(/, name);
  }
});

test("ts_core_imports_only_sdk_types", async () => {
  for (const file of ["client.ts", "agent.ts"]) {
    const source = await readFile(new URL(`../src/${file}`, import.meta.url), "utf8");
    for (const line of source.split("\n").filter((l) => l.includes("@anthropic-ai/sdk"))) {
      assert.match(line, /^import type|^} from/, `${file}: ${line}`);
    }
    assert.doesNotMatch(source, /^import (?!type)[^\n]*@anthropic-ai\/sdk/m, file);
  }
});
