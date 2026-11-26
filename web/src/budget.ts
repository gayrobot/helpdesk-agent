/**
 * The public site's own spending limit (Phase 9). The site reuses the development API key
 * (Skylar's decision, 2026-11-26) and that workspace has no Console spend limit set, so
 * this ledger is the cap that matters. Rules:
 *
 * - **Reserve the worst case before any model call.** A request reserves the most it could
 *   cost; it runs only if today's spent + reserved + that stays under the daily dollar cap.
 *   Afterwards it settles at the real cost (from the call log). An unsettled reservation
 *   (a crash) stays reserved until the day ends: it fails towards spending less.
 * - **Per-visitor and global counts** for questions and for new sessions, keyed by a
 *   salted hash of the visitor's IP (the raw IP is never stored).
 * - **Fail closed.** Callers make no model call unless a reservation succeeded; an error
 *   reaching the ledger means no call.
 *
 * Runtime-neutral: the Durable Object in `worker/budget-object.ts` supplies storage.
 */

export interface BudgetLimits {
  /** US dollars per UTC day across the whole site. */
  dailyUsd: number;
  /** Runbook questions per visitor per UTC day (tier 1). */
  askPerVisitor: number;
  /** Runbook questions per UTC day across the site. */
  askGlobal: number;
  /** New sessions per visitor per UTC day. */
  sessionsPerVisitor: number;
}

export const DEFAULT_LIMITS: BudgetLimits = {
  dailyUsd: 2,
  askPerVisitor: 20,
  askGlobal: 400,
  sessionsPerVisitor: 20,
};

export interface DayLedger {
  date: string; // YYYY-MM-DD, UTC
  spentUsd: number;
  reservedUsd: number;
  asks: number;
  askByVisitor: Record<string, number>;
  sessionsByVisitor: Record<string, number>;
  reservations: Record<string, number>;
}

export type Reservation = { ok: true; id: string } | { ok: false; reason: string };

export interface LedgerStore {
  load(): Promise<DayLedger | undefined>;
  save(day: DayLedger): Promise<void>;
}

const emptyDay = (date: string): DayLedger => ({
  date,
  spentUsd: 0,
  reservedUsd: 0,
  asks: 0,
  askByVisitor: {},
  sessionsByVisitor: {},
  reservations: {},
});

export class BudgetLedger {
  private readonly store: LedgerStore;
  private readonly limits: BudgetLimits;
  private readonly now: () => Date;

  constructor(store: LedgerStore, limits: BudgetLimits = DEFAULT_LIMITS, now = () => new Date()) {
    this.store = store;
    this.limits = limits;
    this.now = now;
  }

  private async today(): Promise<DayLedger> {
    const date = this.now().toISOString().slice(0, 10);
    const day = await this.store.load();
    return day && day.date === date ? day : emptyDay(date);
  }

  /** Reserve `worstUsd` for one runbook question from `visitor`. */
  async reserveAsk(visitor: string, worstUsd: number): Promise<Reservation> {
    if (!(worstUsd > 0)) return { ok: false, reason: "invalid reservation" };
    const day = await this.today();
    if (day.asks >= this.limits.askGlobal) {
      return {
        ok: false,
        reason: "The site has answered its daily limit of questions. Try again tomorrow.",
      };
    }
    if ((day.askByVisitor[visitor] ?? 0) >= this.limits.askPerVisitor) {
      return {
        ok: false,
        reason: "You've reached today's limit of questions. Try again tomorrow.",
      };
    }
    if (day.spentUsd + day.reservedUsd + worstUsd > this.limits.dailyUsd) {
      return {
        ok: false,
        reason: "The site has reached its daily spending limit. Try again tomorrow.",
      };
    }
    const id = crypto.randomUUID();
    day.asks += 1;
    day.askByVisitor[visitor] = (day.askByVisitor[visitor] ?? 0) + 1;
    day.reservedUsd += worstUsd;
    day.reservations[id] = worstUsd;
    await this.store.save(day);
    return { ok: true, id };
  }

  /** Release a reservation and record what was really spent. Unknown ids are ignored. */
  async settle(id: string, actualUsd: number): Promise<void> {
    const day = await this.today();
    const reserved = day.reservations[id];
    if (reserved === undefined) return; // a reservation from a past day, or settled already
    delete day.reservations[id];
    day.reservedUsd = Math.max(0, day.reservedUsd - reserved);
    // Never record less than zero, and treat an unknown cost as the full reservation.
    day.spentUsd += Number.isFinite(actualUsd) && actualUsd >= 0 ? actualUsd : reserved;
    await this.store.save(day);
  }

  /** May `visitor` create another session today? Counts it if so. */
  async allowSession(visitor: string): Promise<boolean> {
    const day = await this.today();
    if ((day.sessionsByVisitor[visitor] ?? 0) >= this.limits.sessionsPerVisitor) return false;
    day.sessionsByVisitor[visitor] = (day.sessionsByVisitor[visitor] ?? 0) + 1;
    await this.store.save(day);
    return true;
  }

  async snapshot(): Promise<Pick<DayLedger, "date" | "spentUsd" | "reservedUsd" | "asks">> {
    const { date, spentUsd, reservedUsd, asks } = await this.today();
    return { date, spentUsd, reservedUsd, asks };
  }
}

/** A salted SHA-256 of the visitor's IP: stable for one UTC day, never the IP itself. */
export async function visitorKey(ip: string, salt: string, now = new Date()): Promise<string> {
  const data = new TextEncoder().encode(`${salt}|${now.toISOString().slice(0, 10)}|${ip}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  return [...digest.slice(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
