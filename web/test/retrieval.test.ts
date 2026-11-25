// Twin of tests/test_retrieval.py. Test names match the Python ones.
//
// Not ported, with reason: the five tests of Python's pinned local embedding model
// (test_verify_model_dir_*, test_every_model_file_is_pinned_to_a_full_hash,
// test_default_retriever_falls_back_to_bm25_without_the_extra). fastembed runs an ONNX
// model locally and can't run in a Worker, so the TypeScript agent uses BM25, as the
// Python baseline runs did. Any embedding model added later gets its own pinning tests.
import assert from "node:assert/strict";
import { test } from "node:test";

import { loadRunbooks } from "../src/node/runbooks.ts";
import {
  BM25Retriever,
  type Chunk,
  chunkMarkdown,
  EmbeddingRetriever,
  HybridRetriever,
  RankingRetriever,
  type Scored,
  tokenize,
} from "../src/retrieval.ts";
import { parseQueries, score } from "../src/retrieval-eval.ts";
import { JAMIE, makeGate } from "./helpers.ts";
import { KeywordEmbedder, QUERIES_JSONL } from "./shared.ts";

const chunks = loadRunbooks();

test("test_runbook_set", () => {
  const runbooks = new Set(chunks.map((c) => c.runbook));
  assert.ok(runbooks.size >= 10 && runbooks.size <= 15);
  assert.equal(new Set(chunks.map((c) => c.id)).size, chunks.length); // chunk ids are unique
});

test("test_runbooks_are_synthetic", () => {
  for (const c of chunks) {
    const domain = c.text.match(/[\w.-]+\.(?:com|org|net|io)\b/);
    assert.equal(domain, null, `real-looking domain in ${c.id}`);
  }
});

test("test_planted_injection_exists", () => {
  const planted = chunks.filter((c) => c.text.includes("CANARY-RB-5e1d"));
  assert.equal(planted.length, 1);
  assert.ok(planted[0]?.text.includes("domain-admins"));
});

test("test_chunking_by_heading", () => {
  const md = "# Title\n\nIntro line.\n\n## First\n\nA.\n\n## Second\n\nB.\n";
  assert.deepEqual(
    chunkMarkdown("doc", md).map((c) => [c.id, c.title, c.text]),
    [
      ["doc#overview", "Title", "Intro line."],
      ["doc#first", "Title", "A."],
      ["doc#second", "Title", "B."],
    ],
  );
});

test("test_tokenize_drops_stopwords_and_folds_plurals", () => {
  assert.deepEqual(tokenize("How do I join the groups?"), ["join", "group"]);
  assert.deepEqual(tokenize("access"), ["access"]);
});

test("test_bm25_finds_obvious_match", () => {
  const top = new BM25Retriever(chunks).rank("guest wifi password", 3);
  assert.equal(top[0]?.[0].runbook, "office-wifi-and-printing");
});

test("test_bm25_unrelated_query_returns_nothing", () => {
  assert.deepEqual(new BM25Retriever(chunks).rank("zzzz qqqq", 3), []);
});

test("test_bm25_meets_baseline_on_the_eval_set", () => {
  const result = score(new BM25Retriever(chunks), parseQueries(QUERIES_JSONL));
  assert.ok(result.queries >= 30);
  assert.ok(result.recallAt3 >= 0.9);
  assert.ok(result.mrr >= 0.8);
});

test("test_embedding_and_hybrid_retrievers_run", () => {
  const dense = new EmbeddingRetriever(chunks, new KeywordEmbedder());
  const hybrid = new HybridRetriever([new BM25Retriever(chunks), dense]);
  assert.equal(dense.rank("vpn", 3).length, 3);
  assert.equal(hybrid.rank("guest wifi password", 3)[0]?.[0].runbook, "office-wifi-and-printing");
});

test("test_rrf_rewards_agreement", () => {
  class Fixed extends RankingRetriever {
    readonly name: string;
    readonly order: number[];
    constructor(name: string, order: number[]) {
      super();
      this.name = name;
      this.order = order;
    }
    rank(_query: string, k = 3): Scored[] {
      return this.order.slice(0, k).map((i): Scored => [chunks[i] as Chunk, 1.0]);
    }
  }
  const hybrid = new HybridRetriever([new Fixed("a", [0, 1, 2]), new Fixed("b", [1, 0, 2])]);
  const ids = hybrid.rank("x", 3).map(([c]) => c.id);
  const first = [chunks[0]?.id, chunks[1]?.id].sort();
  assert.deepEqual(ids.slice(0, 2), first);
  assert.equal(ids[2], chunks[2]?.id);
});

test("test_eval_file_names_real_runbooks", () => {
  const runbooks = new Set(chunks.map((c) => c.runbook));
  for (const q of parseQueries(QUERIES_JSONL)) assert.ok(runbooks.has(q.expected_runbook), q.id);
});

test("test_search_runbooks_tool_through_the_gate", async () => {
  const { gate, audit } = makeGate({ retriever: new BM25Retriever(chunks) });
  const outcome = await gate.execute("search_runbooks", { query: "reset okta verify new phone" });
  assert.ok(!outcome.isError);
  const body = JSON.parse(outcome.content);
  assert.equal(body.results.length, 3);
  assert.equal(body.results[0].runbook, "okta-verify-reenrollment");
  assert.equal(audit.records.at(-1)?.tool, "search_runbooks");
  assert.equal(audit.records.at(-1)?.requester, JAMIE);
});
