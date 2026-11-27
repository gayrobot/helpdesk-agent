// Twins of the eval cases in tests/test_cli.py, for `npm run eval` and
// `npm run eval-retrieval`. Test names match the Python ones.
//
// Not ported, with reason: the ping, run, serve and score subcommands (the TypeScript
// agent has no CLI for them; the Worker replaces run and serve in slice 6), and
// test_eval_retrieval_embeddings_without_fastembed_says_so (no fastembed in TypeScript).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import { GRADER_MODEL } from "../src/client.ts";
import { main } from "../src/node/eval.ts";
import { FakeClient, message, text, thinking, toolUse } from "./fakes.ts";

const noClient = () => {
  throw new Error("a dry run must never build a client");
};

function capture() {
  let buffer = "";
  return { out: { write: (s: string) => (buffer += s) }, text: () => buffer };
}

function tempRoot() {
  const dir = mkdtempSync(join(tmpdir(), "helpdesk-eval-cli-"));
  return { dir, url: pathToFileURL(`${dir}/`), done: () => rmSync(dir, { recursive: true }) };
}

test("test_eval_retrieval_bm25", () => {
  const out = execFileSync(process.execPath, ["src/node/eval-retrieval.ts", "--json"], {
    cwd: new URL("../", import.meta.url),
    encoding: "utf8",
  });
  const scores = JSON.parse(out);
  assert.equal(scores[0].retriever, "bm25");
  assert.ok(scores[0]["recall@3"] >= 0.9);
});

test("test_eval_dry_run_needs_no_client", async () => {
  const { out, text: shown } = capture();
  const code = await main(["--dry-run", "--category", "howto"], { clientFactory: noClient, out });
  assert.equal(code, 0);
  const result = JSON.parse(shown());
  assert.deepEqual(result.by_category, { howto: result.tickets });
});

test("test_eval_live_path_writes_results", async () => {
  const root = tempRoot();
  try {
    const fake = new FakeClient([message([text("Escalating.")], "end_turn")]);
    const { out, text: shown } = capture();
    const code = await main(["--limit", "1"], {
      clientFactory: () => fake,
      out,
      root: root.url,
      now: () => new Date("2026-11-25T16:25:14.000Z"),
    });
    assert.equal(code, 0);
    const files = readdirSync(join(root.dir, "evals", "results"));
    assert.deepEqual(files, ["ts-2026-11-25T162514Z.json"]);
    const saved = JSON.parse(
      readFileSync(join(root.dir, "evals", "results", files[0] as string), "utf8"),
    );
    assert.equal(saved.summary.implementation, "typescript");
    assert.ok(shown().includes("E001"));
    // Logs go to logs/ts/, apart from Python's.
    assert.ok(readdirSync(join(root.dir, "logs", "ts")).includes("calls.jsonl"));
  } finally {
    root.done();
  }
});

test("test_eval_grade_flag_prints_grader_summary", async () => {
  const root = tempRoot();
  try {
    const verdict = JSON.stringify({
      answers_question: true,
      grounded: true,
      no_contradiction: true,
      reason: "ok",
    });
    const fake = new FakeClient([
      message([text("Install Savory Connect. Source: vpn-setup")], "end_turn"),
      message([thinking(), text(verdict)], "end_turn", { model: GRADER_MODEL }),
    ]);
    const { out, text: shown } = capture();
    const code = await main(["--category", "howto", "--limit", "1", "--grade"], {
      clientFactory: () => fake,
      out,
      root: root.url,
    });
    assert.equal(code, 0);
    assert.ok(shown().includes("grader (claude-haiku-5-5): 1/1 answers pass"), shown());
    const [file] = readdirSync(join(root.dir, "evals", "results"));
    const saved = JSON.parse(
      readFileSync(join(root.dir, "evals", "results", file as string), "utf8"),
    );
    assert.equal(saved.summary.grader.passed, 1);
  } finally {
    root.done();
  }
});

// TypeScript only: a tool call keeps the stub retriever out of live runs.
test("ts_live_runs_search_the_real_runbooks", async () => {
  const root = tempRoot();
  try {
    const fake = new FakeClient([
      message([toolUse("search_runbooks", { query: "set up VPN" })], "tool_use"),
      message([text("Source: vpn-setup")], "end_turn"),
    ]);
    await main(["--category", "howto", "--limit", "1"], {
      clientFactory: () => fake,
      out: capture().out,
      root: root.url,
    });
    const toolResult = JSON.stringify(fake.requests[1]?.messages.at(-1)?.content);
    assert.ok(toolResult.includes("vpn-setup"));
  } finally {
    root.done();
  }
});
