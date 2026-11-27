// Tier 1, the anonymous runbook chat (src/ask.ts): only search_runbooks, cheap limits, and
// no model call unless the switch is on, Turnstile passes and the budget reserves.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ASK_MAX_TOKENS,
  ASK_MODEL,
  ASK_SYSTEM_PROMPT,
  ASK_WORST_CASE_USD,
  type AskRouteDeps,
  askRunbooks,
  handleAsk,
  worstCaseUsd,
} from "../src/ask.ts";
import { DevIssuer } from "../src/identity.ts";
import { loadRunbooks } from "../src/node/runbooks.ts";
import { BM25Retriever } from "../src/retrieval.ts";
import { FakeClient, message, text, toolUse } from "./fakes.ts";

const retriever = new BM25Retriever(loadRunbooks());
const issuer = new DevIssuer();

test("the reservation covers the worst case at Haiku's prices", () => {
  assert.ok(worstCaseUsd() <= ASK_WORST_CASE_USD, `${worstCaseUsd()} > ${ASK_WORST_CASE_USD}`);
});

test("only search_runbooks is offered, on Haiku, short, without fallbacks", async () => {
  const fake = new FakeClient([
    message([toolUse("search_runbooks", { query: "set up vpn" })], "tool_use"),
    message([text("Install Savory Connect.\nSource: vpn-setup")], "end_turn", {
      model: ASK_MODEL,
    }),
  ]);
  const result = await askRunbooks("How do I set up the VPN?", { client: fake, retriever, issuer });
  assert.equal(result.status, "answered");
  assert.equal(result.source, "vpn-setup");
  assert.equal(result.answer, "Install Savory Connect.");
  assert.deepEqual(result.searches, ["set up vpn"]);
  const req = fake.requests[0] as unknown as Record<string, unknown>;
  assert.deepEqual(
    (req.tools as { name: string }[]).map((t) => t.name),
    ["search_runbooks"],
  );
  assert.equal(req.model, ASK_MODEL);
  assert.equal(req.max_tokens, ASK_MAX_TOKENS);
  assert.ok(!("fallbacks" in req) && !("betas" in req));
  assert.deepEqual(req.output_config, { effort: "low" });
  assert.equal(req.system, ASK_SYSTEM_PROMPT);
});

test("any other tool the model tries is an unknown tool", async () => {
  const fake = new FakeClient([
    message(
      [
        toolUse("lookup_user", { email: "jamie@example.test" }, "a"),
        toolUse("reset_mfa", { email: "jamie@example.test" }, "b"),
        toolUse("add_to_group", { email: "jamie@example.test", group: "vpn-users" }, "c"),
        toolUse("escalate", { summary: "x" }, "d"),
      ],
      "tool_use",
    ),
    message([text("I can only answer how-to questions.")], "end_turn"),
  ]);
  await askRunbooks("reset my MFA", { client: fake, retriever, issuer });
  const last = fake.requests[1]?.messages.at(-1);
  assert.ok(last && Array.isArray(last.content));
  const results = (last.content as { content: string }[]).map((r) => r.content);
  for (const r of results) assert.match(r, /^Unknown tool/);
});

function deps(overrides: Partial<AskRouteDeps> = {}) {
  const log: string[] = [];
  const d: AskRouteDeps = {
    modelCallsOn: true,
    visitor: "v1",
    remoteip: "203.0.113.7",
    verifyTurnstile: async () => {
      log.push("turnstile");
      return true;
    },
    reserve: async () => {
      log.push("reserve");
      return { ok: true, id: "r1" };
    },
    settle: async (_id, usd) => {
      log.push(`settle ${Number.isNaN(usd) ? "unknown" : usd}`);
    },
    answer: async () => {
      log.push("answer");
      return { status: "answered", answer: "a", source: "vpn-setup", searches: [], costUsd: 0.003 };
    },
    ...overrides,
  };
  return { d, log };
}

test("the happy path: check, reserve, answer, settle at the real cost", async () => {
  const { d, log } = deps();
  const reply = await handleAsk({ question: "How?", turnstile: "t" }, d);
  assert.equal(reply.status, 200);
  assert.deepEqual(log, ["turnstile", "reserve", "answer", "settle 0.003"]);
  assert.equal(reply.body.source, "vpn-setup");
});

test("each refusal comes before any model call", async () => {
  const cases: [string, Record<string, unknown>, Partial<AskRouteDeps>, number, string[]][] = [
    ["empty question", { question: " " }, {}, 400, []],
    ["too long", { question: "x".repeat(601) }, {}, 400, []],
    ["not a string", { question: 5 }, {}, 400, []],
    ["switch off", { question: "q" }, { modelCallsOn: false }, 503, []],
    ["turnstile fails", { question: "q" }, { verifyTurnstile: async () => false }, 403, []],
    [
      "budget unreachable",
      { question: "q" },
      {
        reserve: async () => {
          throw new Error("down");
        },
      },
      503,
      ["turnstile"],
    ],
    [
      "budget says no",
      { question: "q" },
      { reserve: async () => ({ ok: false, reason: "limit" }) },
      429,
      ["turnstile"],
    ],
  ];
  for (const [name, data, overrides, status, expectedLog] of cases) {
    const { d, log } = deps(overrides);
    const reply = await handleAsk(data, d);
    assert.equal(reply.status, status, name);
    assert.ok(!log.includes("answer"), `${name}: no model call`);
    assert.deepEqual(
      log.filter((l) => l !== "reserve"),
      expectedLog,
      name,
    );
  }
});

test("a failed answer keeps the whole reservation", async () => {
  const { d, log } = deps({
    answer: async () => {
      throw new Error("model down");
    },
  });
  const reply = await handleAsk({ question: "q", turnstile: "t" }, d);
  assert.equal(reply.status, 500);
  assert.ok(!JSON.stringify(reply.body).includes("model down"));
  assert.deepEqual(log, ["turnstile", "reserve", "settle unknown"]);
});
