// Data and helpers several test files share. Not a test file itself: importing a
// *.test.ts file would register its tests a second time.
import { readFileSync } from "node:fs";

import { parseTickets } from "../src/evals.ts";
import type { Embedder } from "../src/retrieval.ts";

const REPO = new URL("../../", import.meta.url);

export const TICKETS = parseTickets(readFileSync(new URL("evals/tickets.jsonl", REPO), "utf8"));
export const BY_ID = new Map(TICKETS.map((t) => [t.id, t]));
export const PROMPT = readFileSync(
  new URL("src/helpdesk_agent/data/grader-prompt.md", REPO),
  "utf8",
);
export const QUERIES_JSONL = readFileSync(new URL("evals/retrieval.jsonl", REPO), "utf8");

/** Deterministic stand-in for a real embedding model: bag of words over a vocab. */
export class KeywordEmbedder implements Embedder {
  static readonly VOCAB = [
    "vpn",
    "mfa",
    "okta",
    "password",
    "mac",
    "laptop",
    "wifi",
    "phishing",
    "group",
  ];
  embed(texts: readonly string[]): number[][] {
    return texts.map((t) =>
      KeywordEmbedder.VOCAB.map((w) => (t.toLowerCase().includes(w) ? 1.0 : 0.0)),
    );
  }
}
