/**
 * `npm run eval -- [--limit N] [--category C]... [--grade] [--dry-run] [--tickets PATH]`
 *
 * Runs the TypeScript agent over evals/tickets.jsonl with every write auto-denied, the
 * same way `helpdesk-agent eval` runs the Python one. Live runs need the key, which only
 * `op run --env-file=.env.tpl -- npm --prefix web run eval` provides. `--dry-run` lists
 * what would run and builds no client.
 *
 * Results go to evals/results/ts-<UTC time>.json (summary.implementation is
 * "typescript"); the call and audit logs go to logs/ts/, apart from Python's.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import type { MessagesClient } from "../client.ts";
import { CollectingCallLog, formatSummary, parseTickets, runTickets } from "../evals.ts";
import { formatGraderSummary, Grader } from "../grader.ts";
import { MemoryEscalations } from "../memory.ts";
import { pyFixed } from "../pycompat.ts";
import { FileAudit, FileCallLog } from "./files.ts";
import { defaultRetriever, loadRunbooks } from "./runbooks.ts";

const REPO = new URL("../../../", import.meta.url);

export interface EvalDeps {
  /** Builds the model client. The real one is imported only on a live run. */
  clientFactory?: () => MessagesClient | Promise<MessagesClient>;
  out?: { write(text: string): unknown };
  /** Where results and logs are written; defaults to the repository root. */
  root?: URL;
  now?: () => Date;
}

const realClient = async () => (await import("./anthropic.ts")).makeClient();

/** Python's `%Y-%m-%dT%H%M%SZ`. */
function stamp(d: Date): string {
  return d
    .toISOString()
    .replace(/:/g, "")
    .replace(/\.\d+Z$/, "Z");
}

export async function main(argv: string[], deps: EvalDeps = {}): Promise<number> {
  const out = deps.out ?? process.stdout;
  const root = deps.root ?? REPO;
  const at = (p: string) => (isAbsolute(p) ? p : fileURLToPath(new URL(p, root)));
  const { values } = parseArgs({
    args: argv,
    options: {
      tickets: { type: "string", default: fileURLToPath(new URL("evals/tickets.jsonl", REPO)) },
      category: { type: "string", multiple: true },
      limit: { type: "string" },
      grade: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
    },
  });

  let tickets = parseTickets(readFileSync(at(values.tickets), "utf8"));
  if (values.category?.length) {
    const wanted = new Set(values.category);
    tickets = tickets.filter((t) => wanted.has(t.category));
  }
  if (values.limit !== undefined) tickets = tickets.slice(0, Number.parseInt(values.limit, 10));

  if (values["dry-run"]) {
    const byCategory: Record<string, number> = {};
    for (const t of tickets) byCategory[t.category] = (byCategory[t.category] ?? 0) + 1;
    out.write(
      `${JSON.stringify({ dry_run: true, tickets: tickets.length, by_category: byCategory }, null, 2)}\n`,
    );
    return 0;
  }

  const client = await (deps.clientFactory ?? realClient)();
  const callLog = new CollectingCallLog(new FileCallLog(at("logs/ts/calls.jsonl")));
  const grader = values.grade
    ? Grader.forClient(
        client,
        callLog,
        readFileSync(new URL("src/helpdesk_agent/data/grader-prompt.md", REPO), "utf8"),
        loadRunbooks(),
      )
    : null;

  const results = await runTickets(tickets, client, {
    callLog,
    audit: new FileAudit(at("logs/ts/eval-audit.jsonl")),
    escalations: new MemoryEscalations(), // discarded, as Python's temp directory is
    retriever: defaultRetriever(),
    grader,
    onTicket: (ticket, score) => {
      const failed = Object.entries(score.checks)
        .filter(([, v]) => v === false)
        .map(([k]) => k);
      const mark = score.passed ? "pass" : `FAIL ${failed.join(",")}`;
      out.write(`${ticket.id} ${ticket.category.padEnd(18)} ${mark}\n`);
    },
  });
  results.summary.implementation = "typescript";

  const file = `evals/results/ts-${stamp((deps.now ?? (() => new Date()))())}.json`;
  mkdirSync(at("evals/results"), { recursive: true });
  writeFileSync(at(file), `${JSON.stringify(results, null, 2)}\n`);

  const summary = results.summary;
  out.write(`\n${formatSummary(summary, summary.cost_usd as number)}\n`);
  if (summary.grader) {
    out.write(
      `${formatGraderSummary(summary.grader as Parameters<typeof formatGraderSummary>[0])}\n`,
    );
  }
  out.write(`latency: ${pyFixed((summary.latency_ms_total as number) / 1000, 1)}s total\n`);
  out.write(`Results: ${file}\n`);
  return 0;
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
