/**
 * `npm run eval -- [--limit N] [--category C]... [--grade] [--dry-run]`
 *
 * Runs the TypeScript agent over evals/tickets.jsonl with every write auto-denied, the
 * same way `helpdesk-agent eval` runs the Python one. Live runs need the key, which only
 * `op run --env-file=.env.tpl -- npm run eval` provides. `--dry-run` lists what would run
 * and builds no client.
 *
 * Results go to evals/results/ts-<UTC time>.json (summary.implementation is
 * "typescript"); the call and audit logs go to logs/ts/, apart from Python's.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { CollectingCallLog, formatSummary, parseTickets, runTickets } from "../evals.ts";
import { formatGraderSummary, Grader } from "../grader.ts";
import { MemoryEscalations } from "../memory.ts";
import { pyFixed } from "../pycompat.ts";
import { makeClient } from "./anthropic.ts";
import { FileAudit, FileCallLog } from "./files.ts";
import { defaultRetriever, loadRunbooks } from "./runbooks.ts";

const REPO = new URL("../../../", import.meta.url);
const repoPath = (p: string) => new URL(p, REPO).pathname;

const { values } = parseArgs({
  options: {
    tickets: { type: "string", default: "evals/tickets.jsonl" },
    category: { type: "string", multiple: true },
    limit: { type: "string" },
    grade: { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
  },
});

let tickets = parseTickets(readFileSync(repoPath(values.tickets), "utf8"));
if (values.category?.length) {
  const wanted = new Set(values.category);
  tickets = tickets.filter((t) => wanted.has(t.category));
}
if (values.limit !== undefined) tickets = tickets.slice(0, Number.parseInt(values.limit, 10));

if (values["dry-run"]) {
  const byCategory: Record<string, number> = {};
  for (const t of tickets) byCategory[t.category] = (byCategory[t.category] ?? 0) + 1;
  process.stdout.write(
    `${JSON.stringify({ dry_run: true, tickets: tickets.length, by_category: byCategory }, null, 2)}\n`,
  );
  process.exit(0);
}

const client = makeClient();
const callLog = new CollectingCallLog(new FileCallLog(repoPath("logs/ts/calls.jsonl")));
const grader = values.grade
  ? Grader.forClient(
      client,
      callLog,
      readFileSync(repoPath("src/helpdesk_agent/data/grader-prompt.md"), "utf8"),
      loadRunbooks(),
    )
  : null;

const results = await runTickets(tickets, client, {
  callLog,
  audit: new FileAudit(repoPath("logs/ts/eval-audit.jsonl")),
  escalations: new MemoryEscalations(), // discarded, as Python's temp directory is
  retriever: defaultRetriever(),
  grader,
  onTicket: (ticket, score) => {
    const failed = Object.entries(score.checks)
      .filter(([, v]) => v === false)
      .map(([k]) => k);
    const mark = score.passed ? "pass" : `FAIL ${failed.join(",")}`;
    process.stdout.write(`${ticket.id} ${ticket.category.padEnd(18)} ${mark}\n`);
  },
});
results.summary.implementation = "typescript";

const stamp = new Date()
  .toISOString()
  .replace(/[-:]/g, "")
  .replace(/\.\d+Z$/, "Z");
const day = `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}`;
const file = `evals/results/ts-${day}${stamp.slice(8)}.json`;
mkdirSync(repoPath("evals/results"), { recursive: true });
writeFileSync(repoPath(file), `${JSON.stringify(results, null, 2)}\n`);

const summary = results.summary;
process.stdout.write(`\n${formatSummary(summary, summary.cost_usd as number)}\n`);
if (summary.grader) {
  process.stdout.write(
    `${formatGraderSummary(summary.grader as Parameters<typeof formatGraderSummary>[0])}\n`,
  );
}
process.stdout.write(
  `latency: ${pyFixed((summary.latency_ms_total as number) / 1000, 1)}s total\n`,
);
process.stdout.write(`Results: ${file}\n`);
