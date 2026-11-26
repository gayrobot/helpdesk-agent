/** In-memory escalation store, for evals (escalations are discarded) and tests. */
import type { EscalationRecord, EscalationStore } from "./tools.ts";

export class MemoryEscalations implements EscalationStore {
  readonly saved: EscalationRecord[] = [];

  async save(record: EscalationRecord): Promise<void> {
    if (this.saved.some((r) => r.id === record.id)) {
      throw new Error(`escalation ${record.id} already exists`); // never overwrite
    }
    this.saved.push(record);
  }
}

/** SessionStore in memory: for tests (the Worker uses Durable Object storage). */
export class MemoryStore {
  readonly audit: Record<string, unknown>[] = [];
  readonly calls: Record<string, unknown>[] = [];
  readonly escalations = new MemoryEscalations();
  directory: import("./data.ts").RawDirectory | null = null;
  runs: import("./session.ts").StoredRun[] = [];
  failAudit = false;

  async appendAudit(record: Record<string, unknown>): Promise<void> {
    if (this.failAudit) throw new Error("audit store down");
    this.audit.push(record);
  }
  async appendCall(entry: Record<string, unknown>): Promise<void> {
    this.calls.push(entry);
  }
  saveEscalation(record: EscalationRecord): Promise<void> {
    return this.escalations.save(record);
  }
  async saveDirectory(data: import("./data.ts").RawDirectory): Promise<void> {
    this.directory = structuredClone(data);
  }
  async loadDirectory() {
    return this.directory ? structuredClone(this.directory) : null;
  }
  async saveRuns(runs: import("./session.ts").StoredRun[]): Promise<void> {
    this.runs = structuredClone(runs);
  }
  async loadRuns() {
    return structuredClone(this.runs);
  }
  async readLog() {
    return { audit: structuredClone(this.audit), calls: structuredClone(this.calls) };
  }
}
