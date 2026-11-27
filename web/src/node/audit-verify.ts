/**
 * `npm run audit:verify -- <audit.jsonl>`: walk an audit trail's hash chain (identity
 * phase I4) and report the first broken record. Exit 0 when the chain holds, 1 when it
 * doesn't, 2 on a usage or read error. Tamper-evident, not immutable: a trail rewritten in
 * full can carry a rebuilt chain.
 */
import { readFile } from "node:fs/promises";
import { verifyChain } from "../audit.ts";

export async function verifyFile(path: string): Promise<string> {
  const text = await readFile(path, "utf8");
  const records = text
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const check = await verifyChain(records);
  return check.ok
    ? `ok: ${check.records} records, chain intact`
    : `broken at record ${check.brokenAt + 1}: ${check.why}`;
}

if (import.meta.main) {
  const path = process.argv[2];
  if (!path) {
    console.error("usage: npm run audit:verify -- <audit.jsonl>");
    process.exit(2);
  }
  try {
    const message = await verifyFile(path);
    console.log(message);
    process.exit(message.startsWith("ok") ? 0 : 1);
  } catch (exc) {
    console.error(`could not read ${path}: ${(exc as Error).message}`);
    process.exit(2);
  }
}
