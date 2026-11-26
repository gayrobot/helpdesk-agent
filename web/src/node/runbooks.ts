/**
 * Reads the runbooks from the Python package (one copy of the data) for Node runs and
 * tests. The Worker will bundle the same files (slice 6).
 */
import { readdirSync, readFileSync } from "node:fs";

import { AclCorpus, allChunks } from "../acl.ts";
import { loadDirectoryData } from "../data.ts";
import { BM25Retriever, type Chunk, chunksFrom } from "../retrieval.ts";

export const RUNBOOK_DIR = new URL("../../../src/helpdesk_agent/data/runbooks/", import.meta.url);

export function runbookSources(dir: URL = RUNBOOK_DIR): [string, string][] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".md"))
    .map((name): [string, string] => [name.slice(0, -3), readFileSync(new URL(name, dir), "utf8")]);
}

export function loadRunbooks(dir?: URL): Chunk[] {
  return chunksFrom(runbookSources(dir));
}

/** The retriever behind `search_runbooks` in Node: BM25, as in the Python baseline runs. */
export function defaultRetriever(): BM25Retriever {
  return new BM25Retriever(loadRunbooks());
}

/** BM25 over the shared and restricted runbooks, filtered per reader (identity phase I3). */
export function defaultAclRetriever(): AclCorpus {
  return new AclCorpus(allChunks(runbookSources()), (c) => new BM25Retriever(c), {
    name: "bm25",
    knownGroups: new Set(loadDirectoryData().groups.map((g) => g.name)),
  });
}
