// The core must run in a Cloudflare Worker as well as Node: only src/node/ may use Node
// APIs. tsc can't enforce this (Node's types are global), so this test reads the source.
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test } from "node:test";

import { FileEscalations } from "../src/node/files.ts";

const SRC = new URL("../src/", import.meta.url).pathname;

async function sourceFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await sourceFiles(path)));
    else if (entry.name.endsWith(".ts")) out.push(path);
  }
  return out;
}

test("ts_core_outside_src_node_uses_no_node_apis", async () => {
  const forbidden = [
    /from\s+["']node:/,
    /import\(\s*["']node:/,
    /\brequire\(/,
    /\bprocess\./,
    /\bBuffer\./,
    /\b__dirname\b/,
  ];
  const files = (await sourceFiles(SRC)).filter((f) => !relative(SRC, f).startsWith("node/"));
  assert.ok(files.length >= 6);
  for (const file of files) {
    const text = await readFile(file, "utf8");
    for (const pattern of forbidden) {
      assert.doesNotMatch(text, pattern, `${relative(SRC, file)} uses ${pattern}`);
    }
  }
});

test("ts_file_escalations_never_overwrite", async () => {
  const dir = await mkdtemp(join(tmpdir(), "helpdesk-esc-"));
  try {
    const store = new FileEscalations(dir);
    const record = { id: "ESC-1", created: "x", source_ticket: "T", summary: "first" };
    await store.save(record);
    await assert.rejects(store.save({ ...record, summary: "second" }), /EEXIST/);
    const saved = JSON.parse(await readFile(join(dir, "ESC-1.json"), "utf8"));
    assert.equal(saved.summary, "first");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
