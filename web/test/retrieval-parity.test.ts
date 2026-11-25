// Parity for runbook chunking, tokenizing, BM25 ranking and the retrieval eval, against
// golden outputs from the Python code. The queries include every search the live Python
// agent made in the committed eval runs.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { resultFingerprint } from "../src/governance.ts";
import { loadRunbooks } from "../src/node/runbooks.ts";
import {
  BM25Retriever,
  chunkMarkdown,
  EmbeddingRetriever,
  HybridRetriever,
  tokenize,
} from "../src/retrieval.ts";
import { parseQueries, score, scoreToDict } from "../src/retrieval-eval.ts";
import fixtures from "./fixtures/retrieval.json" with { type: "json" };
import { makeGate, withoutTs } from "./helpers.ts";
import { KeywordEmbedder, QUERIES_JSONL } from "./retrieval.test.ts";

type Ranked = [string, number][];
const F = fixtures as unknown as {
  chunks: Record<string, string>[];
  chunk_markdown: { markdown: string; chunks: Record<string, string>[] }[];
  tokenize: { text: string; tokens: string[] }[];
  bm25: { query: string; ranked: Ranked }[];
  hybrid: { query: string; ranked: Ranked }[];
  score: unknown;
  agent_query_count: number;
  gate: {
    name: string;
    steps: { tool: string; args: unknown }[];
    outcomes: { decision: string; content: string; result_sha256: string; result_bytes: number }[];
    audit: Record<string, unknown>[];
  }[];
};

const chunks = loadRunbooks();
const bm25 = new BM25Retriever(chunks);

/** Same ids in the same order; scores equal to the last bit or within 1e-12 relative. */
function assertRanked(actual: [{ id: string }, number][], expected: Ranked, label: string) {
  assert.deepEqual(
    actual.map(([c]) => c.id),
    expected.map(([id]) => id),
    label,
  );
  actual.forEach(([, s], i) => {
    const e = (expected[i] as [string, number])[1];
    assert.ok(Math.abs(s - e) <= 1e-12 * Math.max(1, Math.abs(e)), `${label}: ${s} vs ${e}`);
  });
}

test("the same 65 chunks, field for field", () => {
  assert.deepEqual(chunks, F.chunks);
});

test("chunkMarkdown edge cases", () => {
  for (const c of F.chunk_markdown) {
    assert.deepEqual(chunkMarkdown("doc", c.markdown), c.chunks, JSON.stringify(c.markdown));
  }
});

test(`tokenize (${F.tokenize.length} texts)`, () => {
  for (const c of F.tokenize) assert.deepEqual(tokenize(c.text), c.tokens, c.text);
});

test(`BM25 top 10 for ${F.bm25.length} queries, ${F.agent_query_count} of them from live runs`, () => {
  for (const c of F.bm25) assertRanked(bm25.rank(c.query, 10), c.ranked, c.query);
});

test("hybrid (BM25 + keyword embedder) top 5", () => {
  const hybrid = new HybridRetriever([bm25, new EmbeddingRetriever(chunks, new KeywordEmbedder())]);
  for (const c of F.hybrid) assertRanked(hybrid.rank(c.query, 5), c.ranked, c.query);
});

test("retrieval eval: same recall@3, MRR and misses", () => {
  assert.deepEqual(scoreToDict(score(bm25, parseQueries(QUERIES_JSONL))), F.score);
});

describe(`search_runbooks through the gate: ${F.gate.length} queries`, () => {
  for (const c of F.gate) {
    test(c.name, async () => {
      const { gate, audit } = makeGate({ retriever: bm25, ticketId: "T-PARITY" });
      const step = c.steps[0] as { tool: string; args: unknown };
      const outcome = await gate.execute(step.tool, step.args);
      const expected = c.outcomes[0];
      assert.ok(expected);
      assert.equal(outcome.decision, expected.decision);
      assert.equal(outcome.content, expected.content);
      assert.deepEqual(await resultFingerprint(outcome.content), [
        expected.result_sha256,
        expected.result_bytes,
      ]);
      assert.deepEqual(withoutTs(audit.records), c.audit);
    });
  }
});
