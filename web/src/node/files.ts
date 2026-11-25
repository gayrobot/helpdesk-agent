/**
 * File-backed audit log and escalation store, for the Node eval runner and local runs.
 * The Worker uses Durable Object storage instead; nothing in `src/` outside `node/`
 * imports `node:` modules.
 */
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { type AuditSink, buildRecord } from "../audit.ts";
import type { EscalationRecord, EscalationStore } from "../tools.ts";

/** JSON with keys sorted at every level, like Python's `json.dumps(sort_keys=True)`. */
export function sortedJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}

/** Appends one JSON line per record. Rejects if the write fails, so the gate fails closed. */
export class FileAudit implements AuditSink {
  readonly path: string;
  private readonly clock: () => Date;

  constructor(path: string, clock: () => Date = () => new Date()) {
    this.path = path;
    this.clock = clock;
  }

  async record(event: string, fields: Record<string, unknown>): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(
      this.path,
      `${sortedJson(buildRecord(event, fields, this.clock()))}\n`,
      "utf8",
    );
  }
}

/** One JSON file per escalation, as in Python's `logs/escalations/`. */
export class FileEscalations implements EscalationStore {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  async save(record: EscalationRecord): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    // "wx": never overwrite an existing escalation; fail instead.
    await writeFile(join(this.dir, `${record.id}.json`), `${JSON.stringify(record, null, 2)}\n`, {
      flag: "wx",
    });
  }
}
