/**
 * Retrieval eval: recall@3 and MRR per retriever, key-free. Port of
 * `helpdesk_agent/retrieval_eval.py`.
 *
 * Each line of `evals/retrieval.jsonl` is a how-to question and the runbook that should
 * answer it. A hit is any returned chunk from that runbook.
 */
import type { RankingRetriever } from "./retrieval.ts";
import { TOP_K } from "./retrieval.ts";

export const MRR_DEPTH = 10;

export interface RetrievalQuery {
  id: string;
  query: string;
  expected_runbook: string;
}

export interface RetrievalScore {
  retriever: string;
  queries: number;
  recallAt3: number;
  mrr: number;
  misses: string[];
}

export function parseQueries(jsonl: string): RetrievalQuery[] {
  return jsonl
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as RetrievalQuery);
}

export function score(
  retriever: RankingRetriever,
  queries: readonly RetrievalQuery[],
): RetrievalScore {
  let hits = 0;
  let reciprocal = 0.0;
  const misses: string[] = [];
  for (const q of queries) {
    const ranked = retriever.rank(q.query, MRR_DEPTH).map(([c]) => c.runbook);
    if (ranked.slice(0, TOP_K).includes(q.expected_runbook)) hits += 1;
    else misses.push(q.id);
    const at = ranked.indexOf(q.expected_runbook);
    if (at >= 0) reciprocal += 1 / (at + 1);
  }
  const n = queries.length;
  return {
    retriever: retriever.name,
    queries: n,
    recallAt3: hits / n,
    mrr: reciprocal / n,
    misses,
  };
}

/** Python's `RetrievalScore.to_dict()`, rounded to 4 places. */
export function scoreToDict(s: RetrievalScore) {
  return {
    retriever: s.retriever,
    queries: s.queries,
    "recall@3": Number(s.recallAt3.toFixed(4)),
    mrr: Number(s.mrr.toFixed(4)),
    misses: s.misses,
  };
}

export function formatTable(scores: readonly RetrievalScore[]): string {
  const lines = [
    `${"retriever".padEnd(12)} ${"queries".padStart(7)} ${"recall@3".padStart(9)} ${"MRR".padStart(6)}`,
  ];
  for (const s of scores) {
    lines.push(
      `${s.retriever.padEnd(12)} ${String(s.queries).padStart(7)} ` +
        `${s.recallAt3.toFixed(3).padStart(9)} ${s.mrr.toFixed(3).padStart(6)}`,
    );
  }
  return lines.join("\n");
}
