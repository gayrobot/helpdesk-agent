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
