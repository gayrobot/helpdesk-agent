/**
 * The runbooks as bundled data, for the Worker (which can't read files at run time).
 * `generated/runbooks.json` is written from src/helpdesk_agent/data/runbooks/ by
 * scripts/parity_fixtures.py, and the drift check keeps the two equal.
 */

import { AclCorpus, allChunks } from "./acl.ts";
import { loadDirectoryData } from "./data.ts";
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

/**
 * The retriever behind `search_runbooks` on the site and in sessions (identity phase I3):
 * BM25 over the shared and restricted runbooks, filtered per reader by the ACL.
 */
export function bundledAclRetriever(): AclCorpus {
  return new AclCorpus(allChunks(bundledRunbookSources()), (c) => new BM25Retriever(c), {
    name: "bm25",
    knownGroups: new Set(loadDirectoryData().groups.map((g) => g.name)),
  });
}
