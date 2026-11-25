// Shared test setup: a gate over a fresh directory, with in-memory sinks.
import { MemoryAudit } from "../src/audit.ts";
import { Directory } from "../src/directory.ts";
import { type Approver, denyAll, Gate, type Proposal } from "../src/governance.ts";
import type { EscalationRecord, EscalationStore, Retriever, RunbookHit } from "../src/tools.ts";

export const JAMIE = "jamie@example.test";
export const FIXED_NOW = new Date("2026-11-25T16:01:43.091Z");

export class MemoryEscalations implements EscalationStore {
  readonly saved: EscalationRecord[] = [];
  async save(record: EscalationRecord): Promise<void> {
    this.saved.push(record);
  }
}

/** Stand-in until BM25 is ported (slice 4). */
export class StubRetriever implements Retriever {
  readonly name = "stub";
  readonly hits: RunbookHit[];
  constructor(hits: RunbookHit[] = []) {
    this.hits = hits;
  }
  search(_query: string, k: number): RunbookHit[] {
    return this.hits.slice(0, k);
  }
}

/** Test approver: returns a fixed answer and remembers every proposal it saw. */
export class RecordingApprover {
  readonly proposals: Proposal[] = [];
  readonly answer: unknown;
  constructor(answer: unknown) {
    this.answer = answer;
  }
  readonly approve: Approver = async (proposal) => {
    this.proposals.push(proposal);
    return this.answer;
  };
}

export function makeGate(
  options: {
    approver?: Approver;
    requester?: string;
    directory?: Directory;
    audit?: MemoryAudit;
    escalations?: MemoryEscalations;
    ticketId?: string;
    retriever?: Retriever;
  } = {},
) {
  const directory = options.directory ?? Directory.load();
  const audit = options.audit ?? new MemoryAudit(() => FIXED_NOW);
  const escalations = options.escalations ?? new MemoryEscalations();
  const gate = new Gate({
    directory,
    approver: options.approver ?? denyAll,
    audit,
    escalations,
    retriever: options.retriever ?? new StubRetriever(),
    ticketId: options.ticketId ?? "T-TEST",
    requester: options.requester ?? JAMIE,
    clock: () => FIXED_NOW,
  });
  return { gate, directory, audit, escalations };
}

/** Audit records without the timestamp, for comparing with Python's. */
export function withoutTs(records: { ts: string }[]): Record<string, unknown>[] {
  return records.map(({ ts: _ts, ...rest }) => rest);
}
