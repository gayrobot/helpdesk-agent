/**
 * `npm run eval-retrieval [-- --json]`: recall@3 and MRR for the TypeScript retrievers on
 * evals/retrieval.jsonl. No key, no network.
 */
import { readFileSync } from "node:fs";

import { BM25Retriever } from "../retrieval.ts";
import { formatTable, parseQueries, score, scoreToDict } from "../retrieval-eval.ts";
import { loadRunbooks } from "./runbooks.ts";

const queriesPath = new URL("../../../evals/retrieval.jsonl", import.meta.url);
const queries = parseQueries(readFileSync(queriesPath, "utf8"));
const scores = [score(new BM25Retriever(loadRunbooks()), queries)];
if (process.argv.includes("--json")) {
  process.stdout.write(`${JSON.stringify(scores.map(scoreToDict), null, 2)}\n`);
} else {
  process.stdout.write(`${formatTable(scores)}\n`);
}
