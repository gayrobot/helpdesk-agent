/**
 * One Durable Object per visitor session: it holds that visitor's copy of the directory,
 * the audit trail, the call log and the approval state. A thin shell around `Session`
 * (src/session.ts) and the tier 2 API (`handleDemoApi`, src/demo.ts).
 *
 * Cleanup: an alarm deletes all of the session's storage about `SESSION_TTL_MS` after its
 * last use. Every request pushes the alarm back (at most once a minute, since the page
 * polls), and the alarm handler checks the last use again before deleting.
 */
import { DurableObject } from "cloudflare:workers";

import { json, tokenOk } from "../api.ts";
import { bundledAclRetriever } from "../bundled.ts";
import type { MessagesClient } from "../client.ts";
import type { RawDirectory } from "../data.ts";
import {
  DEMO_HELPDESK,
  DEMO_MAX_TOOL_TURNS,
  DEMO_MODEL_OPTIONS,
  handleDemoApi,
  SideSignIns,
} from "../demo.ts";
import { Directory } from "../directory.ts";
import { DevIssuer } from "../identity.ts";
import { Session, type SessionStore, type StoredRun } from "../session.ts";
import type { EscalationRecord } from "../tools.ts";
import { BUDGET_NAME } from "./budget-object.ts";
import type { BudgetRpc } from "./routes.ts";
import { VISITOR_HEADER } from "./routes.ts";

/** About 24 hours after a session's last use, its storage is deleted. */
export const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const ALARM_REFRESH_MS = 60_000;

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
  /** How long after its last use a session's storage is deleted. */
  ttlMs?: number;
}

export interface SessionEnv {
  BUDGET: DurableObjectNamespace<BudgetRpc & Rpc.DurableObjectBranded>;
  MODEL_CALLS?: string;
  SITE_HOSTNAME?: string;
}

/** The Durable Object class, with the model client supplied by the entry point. */
export function sessionObjectClass(makeClient: () => MessagesClient, timings: SessionTimings = {}) {
  const { ttlMs = SESSION_TTL_MS, ...sessionTimings } = timings;
  return class HelpdeskSession extends DurableObject<SessionEnv> {
    private session: Promise<Session> | null = null;
    private signIns: SideSignIns | null = null;
    private directory: Directory | null = null;
    private alarmSetAt = 0;

    /** Called once by the Worker when it creates the session. */
    async init(hash: string): Promise<boolean> {
      if ((await this.ctx.storage.get("token_hash")) !== undefined) return false;
      await this.ctx.storage.put("token_hash", hash);
      await this.touch(true);
      return true;
    }

    /** Record a use and push the cleanup alarm back (throttled: the page polls). */
    private async touch(force = false): Promise<void> {
      const now = Date.now();
      if (!force && now - this.alarmSetAt < Math.min(ALARM_REFRESH_MS, ttlMs / 2)) return;
      this.alarmSetAt = now;
      await this.ctx.storage.put("last_used", now);
      await this.ctx.storage.setAlarm(now + ttlMs);
    }

    /** Delete everything once the session has gone unused for the TTL. */
    override async alarm(): Promise<void> {
      const last = (await this.ctx.storage.get<number>("last_used")) ?? 0;
      const due = last + ttlMs;
      if (Date.now() < due) {
        await this.ctx.storage.setAlarm(due); // used since the alarm was set
        return;
      }
      if (this.session) (await this.session).shutdown();
      this.session = null;
      this.signIns = null;
      this.directory = null;
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();
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
      await this.touch();
      if (!this.session) {
        // One issuer per session, its key in memory only: both sides' sign-ins and every
        // run's tokens come from it, and none survive a restart.
        const issuer = new DevIssuer();
        this.signIns = new SideSignIns(issuer);
        this.session = Session.open({
          client: makeClient(),
          store: new DurableStore(this.ctx.storage),
          retriever: bundledAclRetriever(),
          issuer,
          operators: DEMO_HELPDESK,
          modelOptions: DEMO_MODEL_OPTIONS,
          maxToolTurns: DEMO_MAX_TOOL_TURNS,
          ...sessionTimings,
        });
        this.session.catch(() => {
          this.session = null;
        });
      }
      const session = await this.session;
      // The pickers read the stock directory; the gate reads the session's own copy.
      this.directory ??= Directory.load();
      const budget = this.env.BUDGET.get(this.env.BUDGET.idFromName(BUDGET_NAME));
      const response = await handleDemoApi(
        request,
        session,
        hash,
        this.signIns as SideSignIns,
        this.directory,
        {
          modelCallsOn: this.env.MODEL_CALLS === "on",
          visitor: request.headers.get(VISITOR_HEADER) ?? "",
          reserveTicket: (visitor, worst) =>
            visitor
              ? budget.reserveTicket(visitor, worst)
              : Promise.reject(new Error("no visitor")),
          settle: (id, actual) => budget.settle(id, actual),
          waitUntil: (work) => this.ctx.waitUntil(work),
          extraHosts: new Set(this.env.SITE_HOSTNAME ? [this.env.SITE_HOSTNAME] : []),
        },
      );
      // Keep the object running until the ticket finishes, not just this request.
      this.ctx.waitUntil(session.active);
      return response;
    }
  };
}
