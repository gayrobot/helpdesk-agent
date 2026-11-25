/**
 * Retrieval over the synthetic runbooks. Port of `helpdesk_agent/retrieval.py`.
 *
 * Runbooks are Markdown files chunked by `##` heading. Retrievers share one interface so
 * the retrieval eval can compare them:
 *
 * - `BM25Retriever`: keyword baseline, no dependencies. The Python baseline runs used it.
 * - `EmbeddingRetriever`: cosine similarity over vectors from any `Embedder`.
 * - `HybridRetriever`: reciprocal rank fusion of any retrievers.
 *
 * Python's local ONNX embedder (fastembed) isn't ported: it can't run in a Worker. Any
 * embedding model added later is new work and must beat TypeScript BM25 on
 * `evals/retrieval.jsonl` to be kept (docs/plan.md, Phase 7).
 *
 * Runbook text is untrusted data. One runbook carries a planted injection on purpose.
 * The core takes runbook sources as strings; `node/runbooks.ts` reads the files.
 */
import { compareCodePoints, pyStrip } from "./pycompat.ts";
import type { RunbookHit, Retriever as ToolRetriever } from "./tools.ts";

export const TOP_K = 3;

export const STOPWORDS: ReadonlySet<string> = new Set(
  // biome-ignore format: one word per line would be 60 lines
  ["a", "an", "and", "are", "as", "at", "be", "but", "by", "can", "can't", "do", "does", "don't", "for", "from", "has", "have", "how", "i", "i'm", "i've", "if", "in", "is", "it", "its", "me", "my", "no", "not", "of", "on", "or", "our", "so", "that", "the", "their", "them", "then", "there", "they", "this", "to", "too", "up", "us", "was", "we", "what", "when", "where", "which", "who", "why", "will", "with", "you", "your"],
);

export interface Chunk extends RunbookHit {
  id: string; // "<runbook>#<section-slug>"
}

export const searchText = (c: Chunk): string => `${c.title}\n${c.section}\n${c.text}`;

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Escapes only: a raw U+2028/U+2029 character inside a regex literal is a line break.
// biome-ignore lint/suspicious/noControlCharactersInRegex: these are Python's line breaks.
const PY_LINE_BREAKS = /\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/;

/** Python `str.splitlines()`: every line boundary Python recognises, no trailing empty. */
export function pySplitlines(text: string): string[] {
  const lines = text.split(PY_LINE_BREAKS);
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export function chunkMarkdown(runbook: string, markdown: string): Chunk[] {
  let title = runbook;
  let section = "Overview";
  let body: string[] = [];
  const chunks: Chunk[] = [];

  const flush = () => {
    const text = pyStrip(body.join("\n"));
    if (text) chunks.push({ id: `${runbook}#${slug(section)}`, runbook, title, section, text });
  };

  for (const line of pySplitlines(markdown)) {
    if (line.startsWith("# ") && chunks.length === 0 && !pyStrip(body.join(""))) {
      title = pyStrip(line.slice(2));
    } else if (line.startsWith("## ")) {
      flush();
      section = pyStrip(line.slice(3));
      body = [];
    } else {
      body.push(line);
    }
  }
  flush();
  return chunks;
}

/** All chunks, in a stable order: sources sorted by name, then position in the file. */
export function chunksFrom(sources: readonly (readonly [string, string])[]): Chunk[] {
  return [...sources]
    .sort(([a], [b]) => compareCodePoints(a, b))
    .flatMap(([runbook, text]) => chunkMarkdown(runbook, text));
}

export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  for (let tok of text.toLowerCase().match(/[a-z0-9]+(?:'[a-z]+)?/g) ?? []) {
    if (STOPWORDS.has(tok)) continue;
    // Light plural folding: "groups" -> "group"; "access" is left alone.
    if (tok.length > 3 && tok.endsWith("s") && !tok.endsWith("ss")) tok = tok.slice(0, -1);
    tokens.push(tok);
  }
  return tokens;
}

export type Scored = [Chunk, number];

/** A ranked search, plus the plain hits the `search_runbooks` tool needs. */
export abstract class RankingRetriever implements ToolRetriever {
  abstract readonly name: string;
  abstract rank(query: string, k?: number): Scored[];

  search(query: string, k: number = TOP_K): RunbookHit[] {
    return this.rank(query, k).map(([c]) => c);
  }
}

/** Python's sort key `(-score, chunk.id)`. */
const byScoreThenId = (a: Scored, b: Scored): number =>
  b[1] - a[1] || compareCodePoints(a[0].id, b[0].id);

export class BM25Retriever extends RankingRetriever {
  readonly name = "bm25";
  readonly chunks: Chunk[];
  readonly k1: number;
  readonly b: number;
  private readonly docs: Map<string, number>[];
  private readonly lengths: number[];
  private readonly avgLen: number;
  private readonly idf: Map<string, number>;

  constructor(chunks: readonly Chunk[], k1 = 1.5, b = 0.75) {
    super();
    this.chunks = [...chunks];
    this.k1 = k1;
    this.b = b;
    this.docs = this.chunks.map((c) => {
      const counts = new Map<string, number>();
      for (const t of tokenize(searchText(c))) counts.set(t, (counts.get(t) ?? 0) + 1);
      return counts;
    });
    this.lengths = this.docs.map((d) => [...d.values()].reduce((s, n) => s + n, 0));
    this.avgLen = this.lengths.reduce((s, n) => s + n, 0) / Math.max(this.lengths.length, 1);
    const df = new Map<string, number>();
    for (const doc of this.docs) for (const t of doc.keys()) df.set(t, (df.get(t) ?? 0) + 1);
    const n = this.docs.length;
    this.idf = new Map([...df].map(([t, f]) => [t, Math.log(1 + (n - f + 0.5) / (f + 0.5))]));
  }

  rank(query: string, k: number = TOP_K): Scored[] {
    const terms = tokenize(query);
    const scored: Scored[] = [];
    this.chunks.forEach((chunk, i) => {
      const doc = this.docs[i] as Map<string, number>;
      const length = this.lengths[i] as number;
      let score = 0.0;
      for (const term of terms) {
        const tf = doc.get(term) ?? 0;
        if (!tf) continue;
        const norm =
          (tf * (this.k1 + 1)) / (tf + this.k1 * (1 - this.b + (this.b * length) / this.avgLen));
        score += (this.idf.get(term) as number) * norm;
      }
      if (score > 0) scored.push([chunk, score]);
    });
    return scored.sort(byScoreThenId).slice(0, k);
  }
}

export interface Embedder {
  embed(texts: readonly string[]): number[][];
}

function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) throw new Error("vectors differ in length");
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) dot += (a[i] as number) * (b[i] as number);
  for (const x of a) na += x * x;
  for (const y of b) nb += y * y;
  na = Math.sqrt(na);
  nb = Math.sqrt(nb);
  return na && nb ? dot / (na * nb) : 0.0;
}

export class EmbeddingRetriever extends RankingRetriever {
  readonly name = "embeddings";
  readonly chunks: Chunk[];
  private readonly embedder: Embedder;
  private readonly vectors: number[][];

  constructor(chunks: readonly Chunk[], embedder: Embedder) {
    super();
    this.chunks = [...chunks];
    this.embedder = embedder;
    this.vectors = embedder.embed(this.chunks.map(searchText));
  }

  rank(query: string, k: number = TOP_K): Scored[] {
    const q = this.embedder.embed([query])[0] as number[];
    const scored = this.chunks.map((c, i): Scored => [c, cosine(q, this.vectors[i] as number[])]);
    return scored.sort(byScoreThenId).slice(0, k);
  }
}

/** Reciprocal rank fusion: score = sum over retrievers of 1 / (rrfK + rank). */
export class HybridRetriever extends RankingRetriever {
  readonly name = "hybrid";
  readonly retrievers: RankingRetriever[];
  readonly rrfK: number;
  readonly depth: number;

  constructor(retrievers: readonly RankingRetriever[], rrfK = 60, depth = 20) {
    super();
    this.retrievers = [...retrievers];
    this.rrfK = rrfK;
    this.depth = depth;
  }

  rank(query: string, k: number = TOP_K): Scored[] {
    const scores = new Map<string, number>();
    const byId = new Map<string, Chunk>();
    for (const retriever of this.retrievers) {
      retriever.rank(query, this.depth).forEach(([chunk], i) => {
        scores.set(chunk.id, (scores.get(chunk.id) ?? 0) + 1 / (this.rrfK + i + 1));
        byId.set(chunk.id, chunk);
      });
    }
    return [...scores]
      .sort(([a, x], [b, y]) => y - x || compareCodePoints(a, b))
      .slice(0, k)
      .map(([id, score]): Scored => [byId.get(id) as Chunk, score]);
  }
}
