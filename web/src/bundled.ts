/**
 * The runbooks as bundled data, for the Worker (which can't read files at run time).
 * `generated/runbooks.json` is written from src/helpdesk_agent/data/runbooks/ by
 * scripts/parity_fixtures.py, and the drift check keeps the two equal.
 */
import runbooks from "./generated/runbooks.json" with { type: "json" };
import { BM25Retriever, type Chunk, chunksFrom } from "./retrieval.ts";

export function bundledRunbookSources(): [string, string][] {
  return Object.entries(runbooks as Record<string, string>);
}

export function bundledChunks(): Chunk[] {
  return chunksFrom(bundledRunbookSources());
}

/** BM25 over the bundled runbooks: the retriever the Python baseline runs used. */
export function bundledRetriever(): BM25Retriever {
  return new BM25Retriever(bundledChunks());
}
