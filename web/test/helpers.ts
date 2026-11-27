// Shared test setup: a gate over a fresh directory, with in-memory sinks.
import { MemoryAudit } from "../src/audit.ts";
import { Directory } from "../src/directory.ts";
import { type Approver, denyAll, Gate, type Proposal } from "../src/governance.ts";
import { DevIssuer } from "../src/identity.ts";
import { MemoryEscalations } from "../src/memory.ts";
import type { Retriever, RunbookHit } from "../src/tools.ts";

export { MemoryEscalations };

export const JAMIE = "jamie@example.test";
export const FIXED_NOW = new Date("2026-11-25T16:01:43.091Z");

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

/** One dev issuer for the test process: tests get verified principals, never strings. */
export const TEST_ISSUER = new DevIssuer();
export const principalFor = (email: string) => TEST_ISSUER.principalFor(email);

export async function makeGate(
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
  const signIn = await TEST_ISSUER.signIn(options.requester ?? JAMIE);
  const gate = new Gate({
    directory,
    approver: options.approver ?? denyAll,
    audit,
    escalations,
    retriever: options.retriever ?? new StubRetriever(),
    ticketId: options.ticketId ?? "T-TEST",
    signIn,
    clock: () => FIXED_NOW,
  });
  return { gate, directory, audit, escalations };
}

/**
 * Audit records without the timestamp, for comparing with Python's. The I2 `grant` field
 * (the delegated token's id and scope) has no Python counterpart and is dropped too.
 */
export function withoutTs(records: { ts: string }[]): Record<string, unknown>[] {
  return records.map(({ ts: _ts, grant: _grant, ...rest }: Record<string, unknown>) => rest);
}
