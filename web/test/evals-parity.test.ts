// Parity for the scorer, the grader and the eval runner, against golden outputs from the
// Python code. The scorer is checked on every transcript in the committed result files:
// real output of the live Python agent.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { MemoryAudit } from "../src/audit.ts";
import { GRADER_MODEL } from "../src/client.ts";
import {
  CollectingCallLog,
  failedChecks,
  formatSummary,
  runTickets,
  type Summary,
  scoreTranscript,
  summarize,
  type Ticket,
  type Transcript,
} from "../src/evals.ts";
import {
  buildUserMessage,
  eligible,
  formatGraderSummary,
  Grader,
  OUTPUT_FORMAT,
  parseGrade,
  type summarizeGrades,
} from "../src/grader.ts";
import { MemoryEscalations } from "../src/memory.ts";
import { loadRunbooks } from "../src/node/runbooks.ts";
import { pyFixed, pyPercent0 } from "../src/pycompat.ts";
import { BM25Retriever } from "../src/retrieval.ts";
import { FakeClient, message, text, thinking, toolUse } from "./fakes.ts";
import fixtures from "./fixtures/evals.json" with { type: "json" };
import { BY_ID, PROMPT } from "./shared.ts";

const chunks = loadRunbooks();

type BlockSpec = [string, ...unknown[]];
interface Turn {
  content: BlockSpec[];
  stop: string;
  model?: string;
  usage?: Record<string, number>;
}

const F = fixtures as unknown as {
  scores: {
    source: string;
    ticket_id: string;
    transcript: Transcript;
    score: unknown;
    failed: string[];
  }[];
  summaries: Record<string, { summary: Summary; table: string; table_with_cost: string }>;
  grader: {
    prompt: string;
    output_format: unknown;
    user_messages: { ticket_id: string; reply: string; message: string }[];
    eligible: { ticket_id: string; status: string; eligible: boolean }[];
    parse: { text: string; grade: unknown }[];
    summary_table: string;
  };
  runner: {
    scripts: Record<string, Turn[]>;
    runs: Record<"plain" | "graded", { summary: Record<string, unknown>; tickets: unknown[] }>;
  };
};

const ticket = (id: string) => BY_ID.get(id) as Ticket;

describe(`scorer on ${F.scores.length} recorded transcripts`, () => {
  test("every check, pass and failure list matches Python", () => {
    for (const c of F.scores) {
      const ours = scoreTranscript(ticket(c.ticket_id), c.transcript);
      assert.deepEqual(ours, c.score, `${c.source} ${c.ticket_id}`);
      assert.deepEqual(failedChecks(ours), c.failed, `${c.source} ${c.ticket_id}`);
    }
  });

  test("summaries and printed tables match per results file", () => {
    for (const [source, expected] of Object.entries(F.summaries)) {
      const scores = F.scores
        .filter((c) => c.source === source)
        .map((c) => scoreTranscript(ticket(c.ticket_id), c.transcript));
      const summary = summarize(scores);
      assert.deepEqual(summary, expected.summary, source);
      assert.equal(formatSummary(summary), expected.table, source);
      assert.equal(formatSummary(summary, 0.633712), expected.table_with_cost, source);
    }
  });
});

describe("grader", () => {
  test("prompt and output schema are Python's", () => {
    assert.equal(PROMPT.trim(), F.grader.prompt);
    assert.equal(JSON.stringify(OUTPUT_FORMAT), JSON.stringify(F.grader.output_format));
  });

  test(`user messages for all ${F.grader.user_messages.length} how-to tickets`, () => {
    for (const c of F.grader.user_messages) {
      assert.equal(buildUserMessage(ticket(c.ticket_id), c.reply, chunks), c.message, c.ticket_id);
    }
  });

  test("eligibility for every ticket and status", () => {
    for (const c of F.grader.eligible) {
      assert.equal(eligible(ticket(c.ticket_id), { status: c.status as never }), c.eligible);
    }
  });

  test("parsing verdicts, including malformed output", () => {
    for (const c of F.grader.parse) assert.deepEqual(parseGrade(c.text).toDict(), c.grade, c.text);
  });

  test("summary line", () => {
    const g = {
      model: GRADER_MODEL,
      eligible: 14,
      graded: 14,
      ungraded: 0,
      passed: 9,
      pass_rate: 0.6429,
      by_criterion: { answers_question: 13, grounded: 9, no_contradiction: 14 },
      cost_usd: 0.003464,
    };
    assert.equal(formatGraderSummary(g), F.grader.summary_table);
  });
});

function block(spec: BlockSpec) {
  const [kind, a, b, c] = spec;
  if (kind === "thinking") return thinking();
  if (kind === "text") return text(a as string);
  return toolUse(a as string, b, c as string);
}

function turnMessage(t: Turn) {
  const options: Parameters<typeof message>[2] = {};
  if (t.model) options.model = t.model;
  if (t.usage) options.usage = t.usage;
  return message(t.content.map(block), t.stop, options);
}

function graderVerdict() {
  return turnMessage({
    content: [
      ["thinking"],
      [
        "text",
        JSON.stringify({
          answers_question: true,
          grounded: false,
          no_contradiction: true,
          reason: "Adds a step.",
        }),
      ],
    ],
    stop: "end_turn",
    model: GRADER_MODEL,
    usage: { input_tokens: 2000, output_tokens: 80 },
  });
}

for (const mode of ["plain", "graded"] as const) {
  test(`runner, ${mode}: rows and summary match Python`, async () => {
    const script = [];
    for (const [tid, turns] of Object.entries(F.runner.scripts)) {
      script.push(...turns.map(turnMessage));
      if (mode === "graded" && tid === "E017") script.push(graderVerdict());
    }
    const client = new FakeClient(script);
    const callLog = new CollectingCallLog();
    const results = await runTickets(Object.keys(F.runner.scripts).map(ticket), client, {
      callLog,
      audit: new MemoryAudit(),
      escalations: new MemoryEscalations(),
      retriever: new BM25Retriever(chunks),
      grader: mode === "graded" ? Grader.forClient(client, callLog, PROMPT, chunks) : null,
    });
    const rows = results.tickets.map(({ latency_ms: _l, ...rest }) => rest);
    const { latency_ms_total: _t, ...summary } = results.summary;
    const expected = F.runner.runs[mode];
    assert.deepEqual(JSON.parse(JSON.stringify(rows)), expected.tickets);
    const { grader_table: table, ...expectedSummary } = expected.summary;
    assert.deepEqual(summary, expectedSummary);
    if (mode === "graded") {
      assert.equal(
        formatGraderSummary(summary.grader as ReturnType<typeof summarizeGrades>),
        table,
      );
    }
  });
}

test("number formats match Python's, exact ties included", () => {
  const formats = (fixtures as unknown as { formats: Record<string, number | string>[] }).formats;
  for (const f of formats) {
    const v = f.value as number;
    assert.equal(pyPercent0(v), f.percent0, `${v}:.0%`);
    assert.equal(pyFixed(v, 1), f.fixed1, `${v}:.1f`);
    assert.equal(pyFixed(v, 4), f.fixed4, `${v}:.4f`);
  }
});
