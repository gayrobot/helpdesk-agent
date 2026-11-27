/**
 * One Durable Object per visitor session: it holds that visitor's copy of the directory,
 * the audit trail, the call log and the approval state. A thin shell around `Session`
 * (src/session.ts) and `handleSessionApi` (src/api.ts).
 */
import { DurableObject } from "cloudflare:workers";

import { handleSessionApi, json, tokenOk } from "../api.ts";
import { bundledAclRetriever } from "../bundled.ts";
import type { MessagesClient } from "../client.ts";
import type { RawDirectory } from "../data.ts";
import { Session, type SessionStore, type StoredRun } from "../session.ts";
import type { EscalationRecord } from "../tools.ts";

const MAX_STORED_RUNS = 20;

/** SessionStore over Durable Object storage. Logs are append-only, one key per record. */
export class DurableStore implements SessionStore {
  private readonly storage: DurableObjectStorage;

  constructor(storage: DurableObjectStorage) {
    this.storage = storage;
  }

  private async append(prefix: string, value: unknown): Promise<void> {
    const n = ((await this.storage.get<number>(`${prefix}_count`)) ?? 0) + 1;
    await this.storage.put({
      [`${prefix}_count`]: n,
      [`${prefix}:${String(n).padStart(8, "0")}`]: value,
    });
  }

  appendAudit(record: Record<string, unknown>) {
    return this.append("audit", record);
  }

  appendCall(entry: Record<string, unknown>) {
    return this.append("calls", { ts: new Date().toISOString(), ...entry });
  }

  async saveEscalation(record: EscalationRecord): Promise<void> {
    const key = `escalation:${record.id}`;
    if ((await this.storage.get(key)) !== undefined) {
      throw new Error(`escalation ${record.id} already exists`); // never overwrite
    }
    await this.storage.put(key, record);
  }

  async saveDirectory(data: RawDirectory): Promise<void> {
    await this.storage.put("directory", data);
  }

  async loadDirectory(): Promise<RawDirectory | null> {
    return (await this.storage.get<RawDirectory>("directory")) ?? null;
  }

  async saveRuns(runs: StoredRun[]): Promise<void> {
    // Results stay in memory only (and are fingerprinted in the audit log); the stored
    // copy keeps each run small enough for one storage value.
    const slim = runs.slice(-MAX_STORED_RUNS).map((run) => ({
      ...run,
      events: run.events.map(({ result: _r, ...event }) => event),
    }));
    await this.storage.put("runs", slim);
  }

  async loadRuns(): Promise<StoredRun[]> {
    return (await this.storage.get<StoredRun[]>("runs")) ?? [];
  }

  async readLog() {
    const list = async (prefix: string) => [
      ...(await this.storage.list<Record<string, unknown>>({ prefix: `${prefix}:` })).values(),
    ];
    return { audit: await list("audit"), calls: await list("calls") };
  }
}

export interface SessionTimings {
  approvalTimeoutMs?: number;
  minReviewMs?: number;
}

/** The Durable Object class, with the model client supplied by the entry point. */
export function sessionObjectClass(makeClient: () => MessagesClient, timings: SessionTimings = {}) {
  return class HelpdeskSession extends DurableObject {
    private session: Promise<Session> | null = null;

    /** Called once by the Worker when it creates the session. */
    async init(hash: string): Promise<boolean> {
      if ((await this.ctx.storage.get("token_hash")) !== undefined) return false;
      await this.ctx.storage.put("token_hash", hash);
      return true;
    }

    override async fetch(request: Request): Promise<Response> {
      try {
        return await this.handle(request);
      } catch {
        // A fixed message: never the exception text.
        return json(500, { error: "Internal error." });
      }
    }

    private async handle(request: Request): Promise<Response> {
      const hash = await this.ctx.storage.get<string>("token_hash");
      if (hash === undefined) return json(403, { error: "Unknown session." });
      if (!(await tokenOk(request, hash))) return json(403, { error: "Missing or wrong token." });
      this.session ??= Session.open({
        client: makeClient(),
        store: new DurableStore(this.ctx.storage),
        retriever: bundledAclRetriever(),
        ...timings,
      });
      const session = await this.session;
      const response = await handleSessionApi(request, session, hash);
      // Keep the object running until the ticket finishes, not just this request.
      this.ctx.waitUntil(session.active);
      return response;
    }
  };
}
