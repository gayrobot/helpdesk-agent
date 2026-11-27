/**
 * The site-wide budget (src/budget.ts) as one Durable Object, so every request on every
 * Worker instance spends against the same ledger. Called over RPC.
 */
import { DurableObject } from "cloudflare:workers";

import { BudgetLedger, type BudgetLimits, type DayLedger, DEFAULT_LIMITS } from "../budget.ts";

export interface BudgetEnv {
  /** Optional overrides, as strings in Worker vars. */
  BUDGET_DAILY_USD?: string;
  BUDGET_ASK_PER_VISITOR?: string;
  BUDGET_ASK_GLOBAL?: string;
  BUDGET_SESSIONS_PER_VISITOR?: string;
  BUDGET_SESSIONS_GLOBAL?: string;
  BUDGET_TICKETS_PER_VISITOR?: string;
  BUDGET_TICKETS_GLOBAL?: string;
}

function limitsFrom(env: BudgetEnv): BudgetLimits {
  const num = (v: string | undefined, d: number) => {
    const n = Number(v);
    return v !== undefined && Number.isFinite(n) && n >= 0 ? n : d;
  };
  return {
    dailyUsd: num(env.BUDGET_DAILY_USD, DEFAULT_LIMITS.dailyUsd),
    askPerVisitor: num(env.BUDGET_ASK_PER_VISITOR, DEFAULT_LIMITS.askPerVisitor),
    askGlobal: num(env.BUDGET_ASK_GLOBAL, DEFAULT_LIMITS.askGlobal),
    sessionsPerVisitor: num(env.BUDGET_SESSIONS_PER_VISITOR, DEFAULT_LIMITS.sessionsPerVisitor),
    sessionsGlobal: num(env.BUDGET_SESSIONS_GLOBAL, DEFAULT_LIMITS.sessionsGlobal),
    ticketsPerVisitor: num(env.BUDGET_TICKETS_PER_VISITOR, DEFAULT_LIMITS.ticketsPerVisitor),
    ticketsGlobal: num(env.BUDGET_TICKETS_GLOBAL, DEFAULT_LIMITS.ticketsGlobal),
  };
}

export class Budget extends DurableObject<BudgetEnv> {
  private ledger(): BudgetLedger {
    const storage = this.ctx.storage;
    return new BudgetLedger(
      {
        load: () => storage.get<DayLedger>("day"),
        save: (day) => storage.put("day", day),
      },
      limitsFrom(this.env),
    );
  }

  reserveAsk(visitor: string, worstUsd: number) {
    return this.ledger().reserveAsk(visitor, worstUsd);
  }

  reserveTicket(visitor: string, worstUsd: number) {
    return this.ledger().reserveTicket(visitor, worstUsd);
  }

  settle(id: string, actualUsd: number) {
    return this.ledger().settle(id, actualUsd);
  }

  allowSession(visitor: string) {
    return this.ledger().allowSession(visitor);
  }

  snapshot() {
    return this.ledger().snapshot();
  }
}

/** The one ledger for the whole site. */
export const BUDGET_NAME = "site-budget-v1";
