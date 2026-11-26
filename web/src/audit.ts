/**
 * The audit trail for tool calls. Port of `helpdesk_agent/audit.py`.
 *
 * The core never touches a filesystem: it writes through an `AuditSink`, so the same gate
 * runs in Node (a JSON-lines file, `node/files.ts`) and in a Worker (Durable Object
 * storage, later). A sink must reject if the record can't be stored, so the gate can
 * fail closed.
 *
 * Identity phase I4: every record carries `prev` (the previous record's hash, or the
 * genesis value) and `hash` (SHA-256 over `prev` and the record's canonical JSON without
 * `hash`). `verifyChain` walks a trail and reports the first break. This is
 * tamper-evident, not immutable: someone who can rewrite the whole trail can rebuild the
 * chain. Anchoring the head hash elsewhere is out of scope.
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
  private readonly chain = new HashChain();

  constructor(clock: () => Date = () => new Date()) {
    this.clock = clock;
  }

  async record(event: string, fields: Record<string, unknown>): Promise<void> {
    this.records.push(await this.chain.link(buildRecord(event, fields, this.clock())));
  }
}

// ---------------------------------------------------------------- hash chain (I4)

export const GENESIS = "0".repeat(64);

/** JSON with keys sorted at every level, so a record hashes the same after a round trip. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}

async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
  );
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The hash a record should carry, given the record (with its `prev`, without `hash`). */
export function recordHash(record: Record<string, unknown>): Promise<string> {
  const { hash: _hash, ...rest } = record;
  return sha256Hex(canonical(rest));
}

/** Links records one after another. Start it from the last stored hash after a restart. */
export class HashChain {
  private head: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(head: string = GENESIS) {
    this.head = head;
  }

  /** Add `prev` and `hash` to a record, in call order even if calls overlap. */
  link(record: AuditRecord): Promise<AuditRecord> {
    const next = this.queue.then(async () => {
      const linked: AuditRecord = { ...record, prev: this.head };
      linked.hash = await recordHash(linked);
      this.head = linked.hash as string;
      return linked;
    });
    this.queue = next.catch(() => {});
    return next;
  }

  get last(): string {
    return this.head;
  }
}

export type ChainCheck =
  | { ok: true; records: number }
  | { ok: false; brokenAt: number; why: string };

/** Walk a trail from the start. Reports the first record whose link or hash is wrong. */
export async function verifyChain(
  records: readonly Record<string, unknown>[],
): Promise<ChainCheck> {
  let prev = GENESIS;
  for (const [i, r] of records.entries()) {
    if (r.prev !== prev)
      return { ok: false, brokenAt: i, why: "prev does not match the record before" };
    if (r.hash !== (await recordHash(r)))
      return { ok: false, brokenAt: i, why: "hash does not match the record" };
    prev = r.hash as string;
  }
  return { ok: true, records: records.length };
}
