/**
 * The audit trail for tool calls. Port of `helpdesk_agent/audit.py`.
 *
 * The core never touches a filesystem: it writes through an `AuditSink`, so the same gate
 * runs in Node (a JSON-lines file, `node/files.ts`) and in a Worker (Durable Object
 * storage, later). A sink must reject if the record can't be stored, so the gate can
 * fail closed.
 */
import { pyLen } from "./pycompat.ts";

export const MAX_FIELD_CHARS = 300;

export interface AuditRecord {
  ts: string;
  event: string;
  [field: string]: unknown;
}

export interface AuditSink {
  record(event: string, fields: Record<string, unknown>): Promise<void>;
}

/** Long strings are cut to 300 code points, as in Python. */
export function clip(value: unknown): unknown {
  if (typeof value === "string" && pyLen(value) > MAX_FIELD_CHARS) {
    return `${[...value].slice(0, MAX_FIELD_CHARS).join("")}…[truncated]`;
  }
  if (Array.isArray(value)) return value.map(clip);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clip(v)]));
  }
  return value;
}

/** Python's `datetime.now(UTC).isoformat(timespec="milliseconds")`. */
export function auditTimestamp(now: Date): string {
  return now.toISOString().replace("Z", "+00:00");
}

export function buildRecord(
  event: string,
  fields: Record<string, unknown>,
  now: Date,
): AuditRecord {
  return { ts: auditTimestamp(now), event, ...(clip(fields) as Record<string, unknown>) };
}

/** Keeps records in memory. For tests and for showing a run's calls on a page. */
export class MemoryAudit implements AuditSink {
  readonly records: AuditRecord[] = [];
  private readonly clock: () => Date;

  constructor(clock: () => Date = () => new Date()) {
    this.clock = clock;
  }

  async record(event: string, fields: Record<string, unknown>): Promise<void> {
    this.records.push(buildRecord(event, fields, this.clock()));
  }
}
