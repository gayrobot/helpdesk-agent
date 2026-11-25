/**
 * The Haiku grader for the quality of free-text answers. Port of
 * `helpdesk_agent/grader.py`.
 *
 * The deterministic checks decide pass/fail. This adds whether a how-to reply is right,
 * as a separate score that never changes the deterministic pass rate.
 *
 * - Only tickets that name an expected runbook, and that the agent finished normally,
 *   are graded. Everything else gets null and makes no call.
 * - One tool-less call per graded ticket to `GRADER_MODEL` with structured output: three
 *   yes/no verdicts and a reason; code decides the pass.
 * - The prompt is `src/helpdesk_agent/data/grader-prompt.md`, passed in. Ticket, runbook
 *   and reply go into the user message inside labelled tags.
 * - It fails closed: a refusal, a cut-off reply, JSON that doesn't match the schema or an
 *   API error gives an ungraded result with the reason, never a pass.
 */
import type { CallLog, MessagesClient } from "./client.ts";
import { GRADER_MODEL, ModelCaller } from "./client.ts";
import type { Ticket, Transcript } from "./evals.ts";
import { pyFixed, pyPercent0 } from "./pycompat.ts";
import type { Chunk } from "./retrieval.ts";

export const GRADER_MAX_TOKENS = 2_000; // thinking is on for Haiku 5.5 and counts against this
export const GRADER_EFFORT = "low";
export const GRADED_STATUSES: ReadonlySet<string> = new Set(["answered", "escalated"]);
export const CRITERIA = ["answers_question", "grounded", "no_contradiction"] as const;

export const OUTPUT_FORMAT = {
  type: "json_schema",
  schema: {
    type: "object",
    properties: {
      answers_question: { type: "boolean" },
      grounded: { type: "boolean" },
      no_contradiction: { type: "boolean" },
      reason: { type: "string" },
    },
    required: [...CRITERIA, "reason"],
    additionalProperties: false,
  },
};

/** One id, or a list when several runbooks each answer the ticket. */
export function expectedRunbooks(ticket: Pick<Ticket, "expect">): string[] {
  const rb = ticket.expect.runbook;
  if (!rb) return [];
  return typeof rb === "string" ? [rb] : [...rb];
}

export function eligible(ticket: Pick<Ticket, "expect">, transcript: Transcript): boolean {
  return expectedRunbooks(ticket).length > 0 && GRADED_STATUSES.has(String(transcript.status));
}

/** The full text of each runbook, rebuilt from the same chunks retrieval uses. */
export function runbookText(runbookIds: readonly string[], chunks: readonly Chunk[]): string {
  return runbookIds
    .map((rb) => {
      const sections = chunks.filter((c) => c.runbook === rb);
      const first = sections[0];
      if (first === undefined) throw new Error(`unknown runbook: ${rb}`);
      const body = sections.map((c) => `## ${c.section}\n${c.text}`).join("\n\n");
      return `<runbook id="${rb}">\n# ${first.title}\n\n${body}\n</runbook>`;
    })
    .join("\n");
}

export function buildUserMessage(ticket: Ticket, reply: string, chunks: readonly Chunk[]): string {
  return (
    `<ticket>\n${ticket.body}\n</ticket>\n` +
    `${runbookText(expectedRunbooks(ticket), chunks)}\n` +
    `<reply>\n${reply}\n</reply>`
  );
}

export class Grade {
  /** null when the ticket could not be graded; `error` says why. */
  readonly verdicts: Record<string, boolean> | null;
  readonly reason: string;
  readonly error: string | null;

  constructor(verdicts: Record<string, boolean> | null, reason = "", error: string | null = null) {
    this.verdicts = verdicts;
    this.reason = reason;
    this.error = error;
  }

  get graded(): boolean {
    return this.verdicts !== null;
  }

  get passed(): boolean {
    return this.verdicts !== null && Object.values(this.verdicts).every(Boolean);
  }

  toDict() {
    return {
      graded: this.graded,
      passed: this.passed,
      verdicts: this.verdicts,
      reason: this.reason,
      error: this.error,
    };
  }
}

export function parseGrade(text: string): Grade {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return new Grade(null, "", "invalid_json");
  }
  const expected = new Set<string>([...CRITERIA, "reason"]);
  if (
    data === null ||
    typeof data !== "object" ||
    Array.isArray(data) ||
    Object.keys(data).length !== expected.size ||
    !Object.keys(data).every((k) => expected.has(k))
  ) {
    return new Grade(null, "", "schema_mismatch");
  }
  const record = data as Record<string, unknown>;
  const verdicts = Object.fromEntries(CRITERIA.map((name) => [name, record[name]]));
  if (
    !Object.values(verdicts).every((v) => typeof v === "boolean") ||
    typeof record.reason !== "string"
  ) {
    return new Grade(null, "", "schema_mismatch");
  }
  return new Grade(verdicts as Record<string, boolean>, record.reason);
}

export class Grader {
  readonly caller: ModelCaller;
  readonly system: string;
  private readonly chunks: readonly Chunk[];

  constructor(caller: ModelCaller, prompt: string, chunks: readonly Chunk[]) {
    this.caller = caller;
    this.system = prompt.trim();
    this.chunks = chunks;
  }

  static forClient(client: MessagesClient, log: CallLog, prompt: string, chunks: readonly Chunk[]) {
    const caller = new ModelCaller(client, log, {
      model: GRADER_MODEL,
      maxTokens: GRADER_MAX_TOKENS,
      effort: GRADER_EFFORT,
      fallbacks: false, // Haiku 5.5 has no server-side refusal fallback
    });
    return new Grader(caller, prompt, chunks);
  }

  /** null when the ticket isn't one the grader judges. */
  async grade(ticket: Ticket, transcript: Transcript): Promise<Grade | null> {
    if (!eligible(ticket, transcript)) return null;
    const message = buildUserMessage(ticket, transcript.final_text || "", this.chunks);
    let response: Awaited<ReturnType<ModelCaller["create"]>>;
    try {
      response = await this.caller.create(ticket.id, "grade", {
        system: this.system,
        messages: [{ role: "user", content: message }],
        outputFormat: OUTPUT_FORMAT,
      });
    } catch (exc) {
      // Logged by ModelCaller; grading must not stop the run.
      return new Grade(null, "", `api_error:${exc instanceof Error ? exc.name : typeof exc}`);
    }
    const stop = response.stop_reason;
    if (stop !== "end_turn") return new Grade(null, "", `stop_reason:${stop ?? "None"}`);
    const texts = response.content.flatMap((b) => (b.type === "text" ? [b.text] : []));
    const first = texts[0];
    if (first === undefined) return new Grade(null, "", "no_text");
    return parseGrade(first);
  }
}

/** Grader totals over result rows; `grade` is null for tickets it doesn't judge. */
export function summarizeGrades(rows: readonly Record<string, unknown>[]) {
  type G = ReturnType<Grade["toDict"]>;
  const grades = rows.map((r) => r.grade as G | null | undefined).filter((g): g is G => !!g);
  const graded = grades.filter((g) => g.graded);
  const passed = graded.filter((g) => g.passed).length;
  const costs = rows
    .map((r) => r.grader_cost_usd)
    .filter((c): c is number => typeof c === "number");
  return {
    model: GRADER_MODEL,
    eligible: grades.length,
    graded: graded.length,
    ungraded: grades.length - graded.length,
    passed,
    pass_rate: graded.length ? Number((passed / graded.length).toFixed(4)) : 0.0,
    by_criterion: Object.fromEntries(
      CRITERIA.map((name) => [name, graded.filter((g) => g.verdicts?.[name]).length]),
    ),
    cost_usd: Number(costs.reduce((a, b) => a + b, 0).toFixed(6)),
  };
}

export function formatGraderSummary(g: ReturnType<typeof summarizeGrades>): string {
  const crit = Object.entries(g.by_criterion)
    .map(([k, v]) => `${k} ${v}/${g.graded}`)
    .join(", ");
  return (
    `grader (${g.model}): ${g.passed}/${g.graded} answers pass` +
    ` (${pyPercent0(g.pass_rate)}), ${g.ungraded} ungraded; ${crit};` +
    ` cost $${pyFixed(g.cost_usd, 4)}`
  );
}
