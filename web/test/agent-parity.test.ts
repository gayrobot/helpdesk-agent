// Byte parity for the model caller and the agent loop, against golden outputs from the
// Python code (scripts/parity_fixtures.py ran the real Python agent on these scripts).
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { APIConnectionError } from "@anthropic-ai/sdk";

import { Agent, buildFirstRequest, renderTicket, SYSTEM_PROMPT } from "../src/agent.ts";
import { costUsd, MemoryCallLog, ModelCaller } from "../src/client.ts";
import { FakeClient, message, text, thinking, toolUse } from "./fakes.ts";
import fixtures from "./fixtures/agent.json" with { type: "json" };
import { JAMIE, makeGate, withoutTs } from "./helpers.ts";
import { predict } from "./i1-oracle.ts";

type BlockSpec = [string, ...unknown[]];
interface Turn {
  content?: BlockSpec[];
  stop?: string;
  model?: string;
  usage?: Record<string, number>;
  stop_details?: Record<string, unknown> | null;
  error?: string;
}
interface Run {
  name: string;
  requester?: string;
  approver?: string;
  body?: string;
  turns: Turn[];
  result: unknown;
  requests: { roles: string[]; first: unknown; user_turns: unknown[] }[];
  first_request: Record<string, unknown>;
  calls: Record<string, unknown>[];
  audit: Record<string, unknown>[];
  escalations: unknown[];
}

const F = fixtures as unknown as {
  system_prompt: string;
  render_ticket: { args: [string, string, string]; output: string }[];
  request_params: Record<string, unknown>;
  costs: { model: string; usage: Record<string, unknown>; cost: number | null }[];
  runs: Run[];
};

function block(spec: BlockSpec) {
  const [kind, a, b, c] = spec;
  if (kind === "thinking") return thinking();
  if (kind === "text") return text(a as string);
  return toolUse(a as string, b, c as string);
}

function script(turns: Turn[]) {
  return turns.map((t) => {
    if (t.error) return new APIConnectionError({ message: "Connection error." });
    const options: Parameters<typeof message>[2] = {};
    if (t.model) options.model = t.model;
    if (t.usage) options.usage = t.usage;
    if ("stop_details" in t) options.stop_details = t.stop_details ?? null;
    return message((t.content ?? []).map(block), t.stop ?? null, options);
  });
}

test("system prompt is byte-identical", () => {
  assert.equal(SYSTEM_PROMPT, F.system_prompt);
});

test("renderTicket escapes exactly like Python", () => {
  for (const c of F.render_ticket) assert.equal(renderTicket(...c.args), c.output);
});

test("request params are identical, key order included", () => {
  const first = buildFirstRequest("T-1", JAMIE, "Lost my phone, please reset my MFA");
  const ours = {
    default: new ModelCaller(null, new MemoryCallLog()).requestParams(first),
    "low effort, no tools": new ModelCaller(null, new MemoryCallLog(), {
      effort: "low",
    }).requestParams({
      system: "",
      messages: [{ role: "user", content: "Reply with the single word: pong" }],
    }),
    "no effort, format, no fallbacks": new ModelCaller(null, new MemoryCallLog(), {
      model: "claude-haiku-5-5",
      effort: null,
      fallbacks: false,
      maxTokens: 1024,
    }).requestParams({
      system: "grade",
      messages: [{ role: "user", content: "x" }],
      outputFormat: { type: "json_schema", schema: { type: "object" } },
    }),
  };
  assert.equal(JSON.stringify(ours), JSON.stringify(F.request_params));
});

test(`costUsd matches Python for ${F.costs.length} model/usage pairs`, () => {
  for (const c of F.costs) {
    assert.equal(costUsd(c.model, c.usage), c.cost, `${c.model} ${JSON.stringify(c.usage)}`);
  }
});

describe(`agent runs: ${F.runs.length} scripts`, () => {
  for (const run of F.runs) {
    test(run.name, async () => {
      const fake = new FakeClient(script(run.turns));
      const calls = new MemoryCallLog();
      const { gate, audit, escalations } = await makeGate({
        requester: run.requester ?? JAMIE,
        ticketId: "T-AGENT",
        approver: async () => run.approver === "approve",
      });
      const result = await new Agent(new ModelCaller(fake, calls), gate).run(run.body ?? "help");

      // Identity phase I1: predict, independently (test/i1-oracle.ts), which tool calls
      // change. A run with none must match Python byte for byte.
      const requester = run.requester ?? JAMIE;
      const pyEvents = (run.result as { events: Record<string, unknown>[] }).events;
      const predictions = pyEvents.map((e) =>
        e.type === "tool_call"
          ? predict(requester, String(e.tool), e.args, String(e.decision))
          : ({ kind: "same" } as const),
      );
      if (predictions.some((p) => p.kind !== "same")) {
        const tsEvents = JSON.parse(JSON.stringify(result)).events as Record<string, unknown>[];
        assert.equal(tsEvents.length, pyEvents.length);
        tsEvents.forEach((e, i) => {
          const p = predictions[i];
          if (p?.kind === "refused") assert.equal(e.decision, "denied_by_policy");
          else if (p?.kind === "card") assert.equal(e.decision, "allowed");
          else assert.deepEqual(e, pyEvents[i]);
        });
        // The model calls are scripted, so the call log still matches exactly.
        assert.deepEqual(
          calls.entries.map(({ latency_ms: _l, ...rest }) => rest),
          run.calls,
        );
        return;
      }
      assert.deepEqual(JSON.parse(JSON.stringify(result)), run.result);
      assert.equal(fake.requests.length, run.requests.length);
      for (const [i, req] of fake.requests.entries()) {
        const expected = run.requests[i];
        assert.ok(expected);
        assert.deepEqual(
          req.messages.map((m) => m.role),
          expected.roles,
        );
        assert.deepEqual(req.messages[0]?.content, expected.first);
        assert.deepEqual(
          req.messages
            .slice(1)
            .filter((m) => m.role === "user")
            .map((m) => m.content),
          expected.user_turns,
        );
      }
      if (fake.requests[0]) {
        const { messages: _m, ...rest } = fake.requests[0];
        assert.equal(JSON.stringify(rest), JSON.stringify(run.first_request));
      }
      assert.deepEqual(
        calls.entries.map(({ latency_ms: _l, ...rest }) => rest),
        run.calls,
      );
      assert.deepEqual(withoutTs(audit.records), run.audit);
      assert.deepEqual(escalations.saved, run.escalations);
    });
  }
});
