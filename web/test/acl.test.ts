// Identity phase I3: permission-filtered retrieval. Leak count zero for every retriever,
// a missing ACL entry fails the load, and hidden matches look exactly like no matches.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AclCorpus,
  AclError,
  allChunks,
  EVERYONE,
  RESTRICTED_RUNBOOKS,
  RUNBOOK_ACL,
  readerGroups,
} from "../src/acl.ts";
import { bundledAclRetriever, bundledRunbookSources } from "../src/bundled.ts";
import { loadDirectoryData } from "../src/data.ts";
import { Directory } from "../src/directory.ts";
import {
  BM25Retriever,
  type Chunk,
  chunksFrom,
  EmbeddingRetriever,
  HybridRetriever,
  type RankingRetriever,
} from "../src/retrieval.ts";
import { parseQueries, score } from "../src/retrieval-eval.ts";
import { JAMIE, makeGate } from "./helpers.ts";
import { KeywordEmbedder, QUERIES_JSONL } from "./shared.ts";

const SHARED = bundledRunbookSources();
const ALL = allChunks(SHARED);
const RESTRICTED = new Set(Object.keys(RESTRICTED_RUNBOOKS));
const GROUPS = new Set(loadDirectoryData().groups.map((g) => g.name));
const THEO = "theo.park@example.test"; // it-support
const NORA = "nora.quinn@example.test"; // people-ops
const CANARY = /CANARY-RB-ACL-\d/;

const BUILDERS: Record<string, (c: readonly Chunk[]) => RankingRetriever> = {
  bm25: (c) => new BM25Retriever(c),
  embeddings: (c) => new EmbeddingRetriever(c, new KeywordEmbedder()),
  hybrid: (c) =>
    new HybridRetriever([new BM25Retriever(c), new EmbeddingRetriever(c, new KeywordEmbedder())]),
};

const corpus = (name: string) =>
  new AclCorpus(ALL, BUILDERS[name] as (c: readonly Chunk[]) => RankingRetriever, {
    name,
    knownGroups: GROUPS,
  });

// Queries aimed at the restricted runbooks, plus every how-to question in the eval set.
const PROBES = [
  "break-glass accounts vault envelope passphrase",
  "Okta is down, how do we get admin access?",
  "privileged access review quarterly export group owners",
  "compensation letters salary change",
  "CANARY-RB-ACL-1",
  "reference code",
  ...parseQueries(QUERIES_JSONL).map((q) => q.query),
];

test("ts_i3_every_runbook_has_an_acl_entry_naming_real_groups", () => {
  const ids = new Set(ALL.map((c) => c.runbook));
  assert.deepEqual([...ids].sort(), Object.keys(RUNBOOK_ACL).sort());
  for (const [, shared] of SHARED.map(([id]) => [id, RUNBOOK_ACL[id]] as const)) {
    assert.deepEqual(shared, [EVERYONE]); // the 14 shared runbooks stay readable to all
  }
  assert.doesNotThrow(() => bundledAclRetriever());
});

test("ts_i3_a_missing_or_bad_acl_entry_fails_the_load", () => {
  const extra = chunksFrom([...SHARED, ["secret-plans", "# Secret\n\n## A\n\ntext"]]);
  assert.throws(() => new AclCorpus(extra, BUILDERS.bm25 as never, { name: "x" }), AclError);
  assert.throws(
    () =>
      new AclCorpus(ALL, BUILDERS.bm25 as never, {
        name: "x",
        acl: { ...RUNBOOK_ACL, "break-glass-accounts": ["it-suport"] },
        knownGroups: GROUPS,
      }),
    /unknown group/,
  );
  assert.throws(
    () =>
      new AclCorpus(ALL, BUILDERS.bm25 as never, {
        name: "x",
        acl: { ...RUNBOOK_ACL, "break-glass-accounts": [] },
      }),
    /no ACL entry/,
  );
});

for (const name of Object.keys(BUILDERS)) {
  test(`ts_i3_leak_count_is_zero[${name}]`, () => {
    const c = corpus(name);
    const directory = Directory.load();
    let leaks = 0;
    for (const reader of [JAMIE, "guest@example.test", NORA, "riley.okafor@example.test"]) {
      const view = c.forReader(readerGroups(directory, reader));
      const forbidden =
        reader === NORA ? ["break-glass-accounts", "privileged-access-review"] : [...RESTRICTED];
      for (const q of PROBES) {
        for (const hit of view.search(q, 10)) {
          if (forbidden.includes(hit.runbook) || (CANARY.test(hit.text) && reader !== NORA)) {
            leaks++;
          }
        }
      }
    }
    assert.equal(leaks, 0);
  });
}

test("ts_i3_allowed_readers_find_their_restricted_runbooks", () => {
  const c = corpus("bm25");
  const d = Directory.load();
  const theo = c.forReader(readerGroups(d, THEO)).search(PROBES[0] as string, 3);
  assert.equal(theo[0]?.runbook, "break-glass-accounts");
  const nora = c.forReader(readerGroups(d, NORA)).search(PROBES[3] as string, 3);
  assert.equal(nora[0]?.runbook, "compensation-letters");
  // IT support doesn't read People Ops runbooks.
  const theoComp = c.forReader(readerGroups(d, THEO)).search(PROBES[3] as string, 10);
  assert.ok(!theoComp.some((h) => h.runbook === "compensation-letters"));
});

test("ts_i3_bm25_statistics_come_from_the_visible_subset_only", () => {
  // Staff see exactly what BM25 over the shared runbooks alone would rank.
  const staff = corpus("bm25").rankingFor(readerGroups(Directory.load(), JAMIE));
  assert.ok(staff);
  const sharedOnly = new BM25Retriever(chunksFrom(SHARED));
  for (const q of PROBES) assert.deepEqual(staff.rank(q, 10), sharedOnly.rank(q, 10), q);
});

test("ts_i3_retrieval_scores_per_audience", () => {
  const queries = parseQueries(QUERIES_JSONL);
  const c = corpus("bm25");
  const d = Directory.load();
  const base = score(new BM25Retriever(chunksFrom(SHARED)), queries);
  for (const reader of [JAMIE, THEO, NORA]) {
    const ranking = c.rankingFor(readerGroups(d, reader));
    assert.ok(ranking);
    const s = score(ranking, queries);
    // Staff numbers are unchanged; extra restricted runbooks may only cost a little.
    if (reader === JAMIE) assert.deepEqual(s, base);
    else assert.ok(s.recallAt3 >= base.recallAt3 - 0.05, `${reader} ${s.recallAt3}`);
  }
});

test("ts_i3_one_view_per_audience", () => {
  const c = corpus("bm25");
  const d = Directory.load();
  const jamie = c.forReader(readerGroups(d, JAMIE));
  assert.equal(c.forReader(readerGroups(d, "guest@example.test")), jamie, "same audience");
  assert.notEqual(c.forReader(readerGroups(d, THEO)), jamie);
  assert.notEqual(c.forReader(readerGroups(d, NORA)), c.forReader(readerGroups(d, THEO)));
  assert.deepEqual(c.search("break glass", 3), [], "no reader, no results");
});

test("ts_i3_disabled_and_unknown_readers_read_as_everyone_only", () => {
  const d = Directory.load();
  assert.deepEqual([...readerGroups(d, "riley.okafor@example.test")], [EVERYONE]);
  assert.deepEqual([...readerGroups(d, "guest@example.test")], [EVERYONE]);
  assert.ok(readerGroups(d, THEO).has("it-support"));
});

// ---------------------------------------------------------------- through the gate

const QUERY = "break-glass vault envelope passphrase";

test("ts_i3_hidden_matches_are_byte_identical_to_no_matches", async () => {
  const withRestricted = await makeGate({ retriever: corpus("bm25") });
  const sharedOnly = await makeGate({
    retriever: new AclCorpus(chunksFrom(SHARED), BUILDERS.bm25 as never, { name: "bm25" }),
  });
  const a = await withRestricted.gate.execute("search_runbooks", { query: QUERY });
  const b = await sharedOnly.gate.execute("search_runbooks", { query: QUERY });
  assert.equal(a.content, b.content);
  assert.ok(!CANARY.test(a.content));
  const strip = ({ grant: _g, prev: _p, hash: _h, ...r }: Record<string, unknown>) => r;
  assert.deepEqual(
    strip(withRestricted.audit.records.at(-1) as Record<string, unknown>),
    strip(sharedOnly.audit.records.at(-1) as Record<string, unknown>),
  );
});

test("ts_i3_group_changes_take_effect_on_the_next_search", async () => {
  const { gate, directory } = await makeGate({ requester: THEO, retriever: corpus("bm25") });
  const first = await gate.execute("search_runbooks", { query: QUERY });
  assert.match(first.content, /break-glass-accounts/);
  const theo = directory.findUser(THEO);
  assert.ok(theo);
  theo.groups = theo.groups.filter((g) => g !== "it-support");
  const second = await gate.execute("search_runbooks", { query: QUERY });
  assert.doesNotMatch(second.content, /break-glass-accounts|CANARY-RB-ACL/);
});
