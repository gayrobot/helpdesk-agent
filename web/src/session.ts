/**
 * One visitor's session: tickets run one at a time through the agent, and writes wait for
 * an Approve click. Port of `helpdesk_agent/webui.py`'s `WebState`, without HTTP (see
 * `api.ts`) and without a runtime (the Durable Object in `worker/` wraps it).
 *
 * Rules kept from Phase 6:
 *
 * - A write runs only after an Approve on that exact proposal. Each proposal gets a
 *   one-time random id; deny, a timeout, a wrong or reused id, or shutdown all deny.
 * - Approve counts only once the proposal has been on the page for `minReviewMs`, so a
 *   double-click can't approve a second write that appeared under the cursor.
 * - One ticket at a time. Every governance rule still runs in `Gate`.
 * - The page gets tool calls with their exact results (in memory) and their audit
 *   fingerprints; untrusted text is passed through `display`.
 *
 * Differences from Phase 6, by design:
 *
 * - The directory belongs to the session and keeps its changes from ticket to ticket
 *   (the visitor's own copy, per the plan). Python reloads it for every ticket.
 * - State is persisted through a `SessionStore`. If the process restarts mid-run, the run
 *   is marked interrupted and any pending write counts as denied: nothing resumes.
 */
import { Agent, MAX_TOOL_TURNS } from "./agent.ts";
import type { AuditSink } from "./audit.ts";
import { buildRecord, GENESIS, HashChain } from "./audit.ts";
import { mayApprove } from "./authz.ts";
import {
  type CallLog,
  type MessagesClient,
  ModelCaller,
  type ModelCallerOptions,
} from "./client.ts";
import type { RawDirectory } from "./data.ts";
import { Directory } from "./directory.ts";
import { ApprovedBy, EMAIL_PATTERN, Gate, type Outcome, type Proposal } from "./governance.ts";
import { DevIssuer, type SignIn } from "./identity.ts";
import { pyLen } from "./pycompat.ts";
import { display, type EscalationRecord, type Retriever } from "./tools.ts";

export const APPROVAL_TIMEOUT_MS = 300_000;
export const MIN_REVIEW_MS = 1_000;
export const MAX_TICKET_CHARS = 8_000;
const MAX_PANEL_CHARS = 300;
const MAX_RESULT_CHARS = 20_000;

export class BadRequest extends Error {
  override name = "BadRequest";
}
export class Busy extends Error {
  override name = "Busy";
}

/** Where a session keeps what must outlive one request. */
export interface SessionStore {
  appendAudit(record: Record<string, unknown>): Promise<void>;
  appendCall(entry: Record<string, unknown>): Promise<void>;
  saveEscalation(record: EscalationRecord): Promise<void>;
  saveDirectory(data: RawDirectory): Promise<void>;
  loadDirectory(): Promise<RawDirectory | null>;
  saveRuns(runs: StoredRun[]): Promise<void>;
  loadRuns(): Promise<StoredRun[]>;
  /** This session's audit records and call-log entries, oldest first. */
  readLog(): Promise<{ audit: Record<string, unknown>[]; calls: Record<string, unknown>[] }>;
}

export interface StoredRun {
  id: string;
  ticket_id: string;
  requester: string;
  status: string;
  final_text: string;
  tool_turns: number;
  events: Record<string, unknown>[];
  /** What this run's model calls cost in US dollars; null if any call's cost was unknown. */
  cost_usd?: number | null;
  /** Tier 2: the budget reservation this run holds until it is settled. */
  reservation_id?: string | null;
}

interface Pending {
  id: string;
  fields: Record<string, unknown>;
  /** Raw (not display) requester and target, for the approval rules at the click. */
  requester: string;
  target: string;
  decision: boolean | null;
  /** Tier 2: who clicked Approve, once an Approve passed the rules. */
  approver: string | null;
  /** Tier 2: Approve clicks refused at the click, with the rule that refused each. */
  refusals: { approver: string; rule: string }[];
  shownAt: number | null;
  resolve: () => void;
}

interface Run extends StoredRun {
  pending: Pending | null;
}

export interface SessionOptions {
  client: MessagesClient;
  store: SessionStore;
  retriever: Retriever;
  clock?: () => Date;
  /** Milliseconds, monotonic; for the review delay. */
  now?: () => number;
  approvalTimeoutMs?: number;
  minReviewMs?: number;
  /** Mints each run's requester token (identity phase I1). One per session if absent. */
  issuer?: DevIssuer;
  /**
   * Who answers this session's approvals (identity phase I4): a synthetic it-support
   * persona, signed in for each run. The gate refuses them before asking if they filed
   * the request or own the account being changed.
   */
  operator?: string;
  /**
   * Tier 2, instead of `operator`: the helpdesk personas who may answer. Each Approve
   * names who clicked it (`decideAs`), and the approval rules run at that click.
   */
  operators?: readonly string[];
  /** Model settings for this session's tickets (the public demo caps output tokens). */
  modelOptions?: ModelCallerOptions;
  maxToolTurns?: number;
}

export type DecideResult = { ok: true } | { ok: false; refusal: string | null };

/** The local page's approver until tier 2 lets the page switch helpdesk personas. */
export const DEFAULT_OPERATOR = "theo.park@example.test";

function randomHex(bytes: number): string {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

function safe(value: unknown, limit = MAX_PANEL_CHARS): string {
  const text = display(value);
  return pyLen(text) <= limit ? text : `${[...text].slice(0, limit).join("")}…`;
}

function safeArgs(args: unknown): Record<string, string> | string {
  if (args && typeof args === "object" && !Array.isArray(args)) {
    return Object.fromEntries(Object.entries(args).map(([k, v]) => [safe(k, 64), safe(v)]));
  }
  return safe(args);
}

const pad = (n: number) => String(n).padStart(2, "0");
const ticketId = (d: Date) =>
  `W-${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-` +
  `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;

/** `Gate` plus one step: after each call, publish the panel row with its exact result. */
class PanelGate extends Gate {
  run!: Run;
  /** Filled by the audit sink for the call in progress; published with its result. */
  staged!: Record<string, unknown>[];

  override async execute(name: string, args: unknown): Promise<Outcome> {
    const outcome = await super.execute(name, args);
    const entry = this.staged.pop() ?? { tool: safe(name, 64) };
    this.staged.length = 0;
    const shown = safe(outcome.content, MAX_RESULT_CHARS);
    entry.result = shown;
    // True when control characters were replaced or the text was cut, so the page copy
    // isn't byte-identical to what the model got (the fingerprint still is).
    entry.result_altered = shown !== outcome.content;
    this.run.events.push(entry);
    return outcome;
  }
}

export class Session {
  readonly requesters: { email: string; name: string }[];
  private readonly known: Set<string>;
  private readonly opts: Required<
    Omit<
      SessionOptions,
      | "client"
      | "store"
      | "retriever"
      | "issuer"
      | "operator"
      | "operators"
      | "modelOptions"
      | "maxToolTurns"
    >
  > &
    SessionOptions;
  private directory: Directory;
  private issuer: DevIssuer | null = null;
  private chain: Promise<HashChain> | null = null;
  private readonly runs = new Map<string, Run>();
  private current: Run | null = null;
  private closed = false;
  /** Resolves when the active run finishes (the Durable Object keeps it alive). */
  active: Promise<void> = Promise.resolve();

  private constructor(options: SessionOptions, directory: Directory) {
    this.opts = {
      clock: () => new Date(),
      now: () => performance.now(),
      approvalTimeoutMs: APPROVAL_TIMEOUT_MS,
      minReviewMs: MIN_REVIEW_MS,
      ...options,
    };
    this.directory = directory;
    // The picker shows names and emails only, never other directory fields.
    this.requesters = [...directory.users.values()]
      .filter((u) => EMAIL_PATTERN.test(u.email))
      .map((u) => ({ email: u.email, name: safe(u.name, 80) }))
      .sort((a, b) => (a.email < b.email ? -1 : a.email > b.email ? 1 : 0));
    this.known = new Set(this.requesters.map((u) => u.email));
  }

  /** Load a session, failing closed on anything a restart interrupted. */
  static async open(options: SessionOptions): Promise<Session> {
    const saved = await options.store.loadDirectory();
    const directory = saved ? new Directory(saved) : Directory.load();
    const session = new Session(options, directory);
    let interrupted = false;
    for (const stored of await options.store.loadRuns()) {
      const run: Run = { ...stored, pending: null };
      if (run.status === "running") {
        interrupted = true;
        run.status = "interrupted";
        run.final_text =
          "The server restarted while this ticket was running. Nothing more was attempted, " +
          "and any write waiting for approval was not made.";
      }
      session.runs.set(run.id, run);
      session.current = run;
    }
    if (interrupted) await session.persistRuns();
    return session;
  }

  // ------------------------------------------------------------ runs

  async startRun(requester: unknown, body: unknown, reservationId?: string): Promise<Run> {
    if (typeof requester !== "string" || !this.known.has(requester)) {
      throw new BadRequest("Pick a requester from the list.");
    }
    if (typeof body !== "string" || !body.trim()) throw new BadRequest("Ticket text is empty.");
    if (pyLen(body) > MAX_TICKET_CHARS) {
      throw new BadRequest(`Ticket text is longer than ${MAX_TICKET_CHARS} characters.`);
    }
    if (this.closed) throw new Busy("The session is shutting down.");
    if (this.current?.status === "running") throw new Busy("Another ticket is still running.");
    const run: Run = {
      id: randomHex(8),
      ticket_id: ticketId(this.opts.clock()),
      requester,
      status: "running",
      final_text: "",
      tool_turns: 0,
      events: [],
      pending: null,
      reservation_id: reservationId ?? null,
    };
    this.runs.set(run.id, run);
    this.current = run;
    await this.persistRuns();
    this.active = this.work(run, body);
    return run;
  }

  private async work(run: Run, body: string): Promise<void> {
    try {
      // Verified for this run only, and never stored: a restarted session rebuilds no
      // identity from a stored email.
      this.issuer ??= this.opts.issuer ?? new DevIssuer();
      const signIn = await this.issuer.signIn(run.requester);
      const pool = new Map<string, SignIn>();
      for (const email of this.opts.operators ?? []) {
        pool.set(email, await this.issuer.signIn(email));
      }
      const operator = this.opts.operators
        ? null
        : await this.issuer.signIn(this.opts.operator ?? DEFAULT_OPERATOR);
      const staged: Record<string, unknown>[] = [];
      const gate = new PanelGate({
        directory: this.directory,
        approver: (p) => this.approve(run, p, this.opts.operators ? pool : null),
        audit: this.auditFor(staged),
        escalations: { save: (r) => this.opts.store.saveEscalation(r) },
        retriever: this.opts.retriever,
        ticketId: run.ticket_id,
        signIn,
        ...(this.opts.operators ? { operators: [...pool.values()] } : { operator }),
        clock: this.opts.clock,
      });
      gate.run = run;
      gate.staged = staged;
      run.cost_usd = 0;
      const caller = new ModelCaller(this.opts.client, this.callLog(run), this.opts.modelOptions);
      const result = await new Agent(caller, gate, this.opts.maxToolTurns ?? MAX_TOOL_TURNS).run(
        body,
      );
      run.final_text = result.final_text;
      run.tool_turns = result.tool_turns;
      run.status = result.status;
    } catch (exc) {
      // The page gets a fixed message; the exception type goes to the call log.
      await this.opts.store
        .appendCall({
          event: "session_error",
          ticket_id: run.ticket_id,
          error: (exc as Error)?.name ?? typeof exc,
        })
        .catch(() => {});
      run.final_text = "The run failed inside the server. Nothing more was attempted.";
      run.status = "server_error";
    } finally {
      run.pending = null;
      await this.opts.store.saveDirectory(this.directoryData()).catch(() => {});
      await this.persistRuns().catch(() => {});
    }
  }

  private auditFor(staged: Record<string, unknown>[]): AuditSink {
    return {
      record: async (event, fields) => {
        // Stored first: if that fails the gate fails closed, as with the audit file.
        // Chained to the session's previous record (identity phase I4).
        this.chain ??= this.opts.store
          .readLog()
          .then(({ audit }) => new HashChain(String(audit.at(-1)?.hash ?? GENESIS)));
        const linked = await (await this.chain).link(buildRecord(event, fields, this.opts.clock()));
        await this.opts.store.appendAudit(linked);
        // An approved write has just changed the directory: store it now, so a restart
        // can't lose a write the operator approved. A failure here fails the run.
        if (event === "tool_call" && fields.decision === "approved") {
          await this.opts.store.saveDirectory(this.directoryData());
        }
        if (event !== "tool_call") return;
        staged.push({
          tool: safe(fields.tool, 64),
          kind: fields.kind,
          args: safeArgs(fields.args),
          decision: fields.decision,
          approval: fields.approval,
          reason: safe(fields.reason),
          is_error: Boolean(fields.is_error),
          result_sha256: fields.result_sha256,
          result_bytes: fields.result_bytes,
        });
      },
    };
  }

  private callLog(run: Run): CallLog {
    return {
      write: (entry) => {
        // Unknown cost (an unpriced model, a failed call) makes the run's cost unknown,
        // which the budget settles as the full reservation.
        const cost = entry.cost_usd;
        if (typeof cost === "number" && Number.isFinite(cost) && typeof run.cost_usd === "number") {
          run.cost_usd += cost;
        } else if (cost !== undefined && cost !== 0) {
          run.cost_usd = null;
        }
        return this.opts.store.appendCall(entry);
      },
    };
  }

  private approve(
    run: Run,
    proposal: Proposal,
    pool: ReadonlyMap<string, SignIn> | null,
  ): Promise<boolean | ApprovedBy> {
    if (this.closed) return Promise.resolve(false);
    return new Promise<boolean | ApprovedBy>((resolve) => {
      const pending: Pending = {
        id: randomHex(24),
        fields: {
          tool: safe(proposal.tool, 64),
          args: safeArgs(proposal.args),
          effect: safe(proposal.description),
          requester: safe(proposal.requester),
          target: safe(proposal.target),
          requester_is_target: proposal.requesterIsTarget,
        },
        requester: proposal.requester,
        target: proposal.target,
        decision: null,
        approver: null,
        refusals: [],
        shownAt: null,
        resolve: () => {},
      };
      const timer = setTimeout(() => pending.resolve(), this.opts.approvalTimeoutMs);
      pending.resolve = () => {
        clearTimeout(timer);
        run.pending = null;
        // Only an Approve recorded for this proposal's id counts. No decision (timeout,
        // shutdown) or a Deny both deny.
        if (pending.decision !== true) return resolve(false);
        if (!pool) return resolve(true);
        // Tier 2: name who approved; the gate checks the rules again before honouring it.
        const by = pending.approver === null ? undefined : pool.get(pending.approver);
        resolve(by ? new ApprovedBy(by) : false);
      };
      run.pending = pending;
    });
  }

  /** Record one decision for the pending proposal. False if there is none, the id doesn't
   * match, it was already decided, or (Approve only) it hasn't been shown long enough. */
  decide(runId: string, proposalId: unknown, approve: boolean): boolean {
    const pending = this.runs.get(runId)?.pending;
    if (!pending || pending.decision !== null || typeof proposalId !== "string") return false;
    if (!timingSafeEqual(pending.id, proposalId)) return false;
    if (approve) {
      const shown = pending.shownAt;
      if (shown === null || this.opts.now() - shown < this.opts.minReviewMs) return false;
    }
    pending.decision = approve;
    pending.resolve();
    return true;
  }

  /**
   * Tier 2: one decision from a named helpdesk persona. An Approve the approval rules
   * refuse (the persona filed the request, or is its target) is not recorded: the proposal
   * stays pending for someone who may approve it, and the refusal is audited and shown.
   */
  async decideAs(
    runId: string,
    proposalId: unknown,
    approve: boolean,
    approver: string,
  ): Promise<DecideResult> {
    const run = this.runs.get(runId);
    const pending = run?.pending;
    if (!run || !pending || pending.decision !== null || typeof proposalId !== "string") {
      return { ok: false, refusal: null };
    }
    if (!timingSafeEqual(pending.id, proposalId)) return { ok: false, refusal: null };
    if (!(this.opts.operators ?? []).includes(approver)) {
      return { ok: false, refusal: `${approver} is not one of this demo's helpdesk personas.` };
    }
    if (approve) {
      const rule = mayApprove(this.directory, approver, pending.requester, pending.target);
      if (rule) {
        // Recorded once per approver per proposal, however often they click.
        if (pending.refusals.some((r) => r.approver === safe(approver))) {
          return { ok: false, refusal: rule };
        }
        pending.refusals.push({ approver: safe(approver), rule: safe(rule) });
        await this.auditFor([]).record("approval_refused", {
          ticket_id: run.ticket_id,
          requester: pending.requester,
          approver,
          tool: pending.fields.tool,
          target: pending.target,
          reason: rule,
        });
        return { ok: false, refusal: rule };
      }
      const shown = pending.shownAt;
      if (shown === null || this.opts.now() - shown < this.opts.minReviewMs) {
        return { ok: false, refusal: null };
      }
      pending.approver = approver;
    }
    pending.decision = approve;
    pending.resolve();
    return { ok: true };
  }

  /**
   * Tier 2: finished runs whose budget reservation hasn't been settled (a restart
   * interrupted them), with their cost summed from the stored call log: null when a
   * call's cost is unknown, which settles as the whole reservation.
   */
  async unsettled(): Promise<{ runId: string; reservationId: string; costUsd: number | null }[]> {
    const open = [...this.runs.values()].filter((r) => r.reservation_id && r.status !== "running");
    if (open.length === 0) return [];
    const { calls } = await this.opts.store.readLog();
    return open.map((run) => {
      let cost: number | null = 0;
      for (const c of calls) {
        if (c.event !== "model_call" || c.ticket_id !== run.ticket_id) continue;
        if (c.cost_usd === undefined) continue; // a failed call: not billed
        cost = typeof c.cost_usd === "number" && cost !== null ? cost + c.cost_usd : null;
      }
      return { runId: run.id, reservationId: run.reservation_id as string, costUsd: cost };
    });
  }

  /** Tier 2: the run's reservation has been settled; forget it. */
  async markSettled(runId: string): Promise<void> {
    const run = this.runs.get(runId);
    if (!run?.reservation_id) return;
    run.reservation_id = null;
    await this.persistRuns();
  }

  /** Who filed a run, or null for an unknown run. */
  runRequester(runId: string): string | null {
    return this.runs.get(runId)?.requester ?? null;
  }

  /** The run's model cost so far (null if unknown), or undefined for an unknown run. */
  runCost(runId: string): number | null | undefined {
    const run = this.runs.get(runId);
    return run ? (run.cost_usd ?? null) : undefined;
  }

  /** How many tickets this session has started (the stored history holds up to 20). */
  get ticketCount(): number {
    return this.runs.size;
  }

  /** True while a ticket is running (or the session is shutting down). */
  isBusy(): boolean {
    return this.closed || this.current?.status === "running";
  }

  /** A run's state without its proposal, and without marking a proposal as shown. */
  peek(runId: string): Record<string, unknown> | null {
    const run = this.runs.get(runId);
    if (!run) return null;
    return {
      run_id: run.id,
      ticket_id: run.ticket_id,
      requester: run.requester,
      status: run.status,
      final_text: run.final_text,
      tool_turns: run.tool_turns,
    };
  }

  snapshot(runId: string): Record<string, unknown> | null {
    const run = this.runs.get(runId);
    if (!run) return null;
    let pending = null;
    if (run.pending && run.pending.decision === null) {
      run.pending.shownAt ??= this.opts.now();
      pending = {
        id: run.pending.id,
        ...run.pending.fields,
        refusals: run.pending.refusals.map((r) => ({ ...r })),
      };
    }
    return {
      run_id: run.id,
      ticket_id: run.ticket_id,
      requester: run.requester,
      status: run.status,
      final_text: run.final_text,
      tool_turns: run.tool_turns,
      events: [...run.events],
      pending,
    };
  }

  /** The session's own audit trail and call log (token-checked by the API). */
  log() {
    return this.opts.store.readLog();
  }

  hasRun(runId: string): boolean {
    return this.runs.has(runId);
  }

  currentRunId(): string | null {
    return this.current?.id ?? null;
  }

  /** Deny anything waiting for approval and refuse new runs. */
  shutdown(): void {
    this.closed = true;
    for (const run of this.runs.values()) {
      if (run.pending && run.pending.decision === null) {
        run.pending.decision = false;
        run.pending.resolve();
      }
    }
  }

  // ------------------------------------------------------------ persistence

  private directoryData(): RawDirectory {
    return {
      company: this.directory.company,
      users: [...this.directory.users.values()],
      groups: [...this.directory.groups.values()],
      devices: this.directory.devices,
      apps: this.directory.apps,
    };
  }

  private persistRuns(): Promise<void> {
    return this.opts.store.saveRuns(
      [...this.runs.values()].map(({ pending: _p, ...stored }) => stored),
    );
  }
}

/** Compare two strings without an early exit on the first difference. */
export function timingSafeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}
