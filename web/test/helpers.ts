// Shared test setup: a gate over a fresh directory, with in-memory sinks.
import { MemoryAudit } from "../src/audit.ts";
import { Directory } from "../src/directory.ts";
import { type Approver, denyAll, Gate, type Proposal } from "../src/governance.ts";
import { DevIssuer } from "../src/identity.ts";
import { MemoryEscalations } from "../src/memory.ts";
import type { Retriever, RunbookHit } from "../src/tools.ts";

export { MemoryEscalations };

export const JAMIE = "jamie@example.test";
/** The default approver in tests: it-support, and never a requester or write target in the
 * parity fixtures that reach approval. */
export const OPERATOR = "theo.park@example.test";
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
    /** Who answers approvals; null for none. Defaults to OPERATOR. */
    operator?: string | null;
  } = {},
) {
  const directory = options.directory ?? Directory.load();
  const audit = options.audit ?? new MemoryAudit(() => FIXED_NOW);
  const escalations = options.escalations ?? new MemoryEscalations();
  const signIn = await TEST_ISSUER.signIn(options.requester ?? JAMIE);
  const operator =
    options.operator === null ? null : await TEST_ISSUER.signIn(options.operator ?? OPERATOR);
  const gate = new Gate({
    directory,
    approver: options.approver ?? denyAll,
    audit,
    escalations,
    retriever: options.retriever ?? new StubRetriever(),
    ticketId: options.ticketId ?? "T-TEST",
    signIn,
    operator,
    clock: () => FIXED_NOW,
  });
  return { gate, directory, audit, escalations };
}

/** Fields the identity phases added that have no Python counterpart. */
const IDENTITY_FIELDS = ["grant", "approver", "args_sha256", "receipt_jti", "prev", "hash"];

/**
 * Audit records without the timestamp, for comparing with Python's. The identity fields
 * (I2's grant, I4's receipt and hash chain) are dropped too.
 */
export function withoutTs(records: { ts: string }[]): Record<string, unknown>[] {
  return records.map(({ ts: _ts, ...rest }: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(rest).filter(([k]) => !IDENTITY_FIELDS.includes(k))),
  );
}
