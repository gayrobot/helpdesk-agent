/**
 * Tier 2 of the public site (Phase 9): the guided split-screen demo's session API.
 *
 * One visitor drives two sides of one session, and each side signs in separately with
 * the dev issuer ("simulated sign-in" on the page):
 *
 * - **Left, the requester:** any directory user outside `it-support`. Files tickets and
 *   sees its own runs' replies, never a proposal, a tool result or the audit trail.
 * - **Right, the helpdesk:** Rosa Delgado or Theo Park (`it-support`), switchable. Sees
 *   every run with its tool calls, the approval queue and the audit trail, may file
 *   tickets of its own, and is the only side that can approve or deny.
 *
 * Each side holds its own dev-issuer token (sent in `X-Helpdesk-Identity`); the API
 * verifies it and reads the side from the token's id, recorded at sign-in. The side and
 * the persona come from that token, never from a request body. A token from another
 * session fails, because each session's issuer has its own in-memory key: after a
 * restart every token fails and the page signs in again.
 *
 * Approvals: the approver is whoever is signed in on the right *at the click*. An Approve
 * the rules refuse (the persona filed the request, or is the account being changed) is
 * refused with the rule's text and the proposal stays pending, so the other persona can
 * still approve it. The gate checks the rules again before the write runs.
 *
 * Limits, all before any model call and failing closed: the kill switch, a cap on tickets
 * per session, then a budget reservation for the ticket's worst case (per visitor per
 * day, across the site per day, and the daily dollar cap), settled at the real cost when
 * the run ends.
 */

import { MAX_TOOL_TURNS } from "./agent.ts";
import { hostOk, json, originOk, readJson, tokenOk } from "./api.ts";
import { HELPDESK_GROUP } from "./authz.ts";
import type { Reservation } from "./budget.ts";
import { AGENT_MODEL, type ModelCallerOptions, PRICES } from "./client.ts";
import type { Directory } from "./directory.ts";
import { EMAIL_PATTERN } from "./governance.ts";
import { type DevIssuer, SUBJECT_TOKEN_SECONDS } from "./identity.ts";
import { pyLen } from "./pycompat.ts";
import { BadRequest, Busy, type Session } from "./session.ts";

export const IDENTITY_HEADER = "X-Helpdesk-Identity";

/** The right side's two personas (the plan names them). Checked against the directory. */
export const DEMO_HELPDESK = ["rosa.delgado@example.test", "theo.park@example.test"] as const;

/** Tickets per session, both sides together. At most the 20 runs a session stores. */
export const DEMO_MAX_TICKETS = 8;

/**
 * The demo's model settings: the real agent model, with output capped so one ticket's
 * worst case fits well inside the site's daily budget, and no refusal fallback (which can
 * re-run a call on another model and double its cost).
 */
export const DEMO_MAX_TOKENS = 2_000;
export const DEMO_MAX_TOOL_TURNS = MAX_TOOL_TURNS;
export const DEMO_PROMPT_TOKEN_CEILING = 30_000;
export const DEMO_MODEL_OPTIONS: ModelCallerOptions = {
  model: AGENT_MODEL,
  maxTokens: DEMO_MAX_TOKENS,
  fallbacks: false,
};

/** The most one demo ticket can cost: every call at the prompt ceiling and full output. */
export function ticketWorstCaseUsd(): number {
  const price = PRICES[AGENT_MODEL];
  if (!price) throw new Error("no price for the agent model");
  const calls = DEMO_MAX_TOOL_TURNS + 1;
  return (
    (calls * (DEMO_PROMPT_TOKEN_CEILING * price.input + DEMO_MAX_TOKENS * price.output)) / 1_000_000
  );
}

export type Side = "requester" | "helpdesk";
const SIDES: ReadonlySet<string> = new Set(["requester", "helpdesk"]);

export interface Persona {
  email: string;
  name: string;
}

/** Who may sign in on each side, from the directory. */
export function personas(directory: Directory): { requester: Persona[]; helpdesk: Persona[] } {
  const helpdeskMember = (groups: string[]) =>
    groups.some((g) => g.trim().toLowerCase() === HELPDESK_GROUP);
  const users = [...directory.users.values()].filter((u) => EMAIL_PATTERN.test(u.email));
  const persona = (u: { email: string; name: string }) => ({
    email: u.email,
    name: [...String(u.name)].slice(0, 80).join(""),
  });
  return {
    requester: users
      .filter((u) => !helpdeskMember(u.groups))
      .map(persona)
      .sort((a, b) => (a.email < b.email ? -1 : a.email > b.email ? 1 : 0)),
    helpdesk: DEMO_HELPDESK.flatMap((email) => {
      const u = directory.findUser(email);
      return u && u.status === "active" && helpdeskMember(u.groups) ? [persona(u)] : [];
    }),
  };
}

/**
 * The two sides' sign-ins for one session. Tokens come from the session's dev issuer;
 * the side each was minted for is kept here, in memory, by token id.
 */
export class SideSignIns {
  private readonly issuer: DevIssuer;
  private readonly sides = new Map<string, { side: Side; exp: number }>();

  constructor(issuer: DevIssuer) {
    this.issuer = issuer;
  }

  async signIn(side: Side, email: string): Promise<{ token: string; expiresIn: number }> {
    const token = await this.issuer.mint(email);
    const principal = await (await this.issuer.verifier()).verify(token);
    const now = Math.floor(Date.now() / 1000);
    for (const [jti, entry] of this.sides) if (entry.exp <= now) this.sides.delete(jti);
    this.sides.set(principal.jti, { side, exp: now + SUBJECT_TOKEN_SECONDS });
    return { token, expiresIn: SUBJECT_TOKEN_SECONDS };
  }

  /** The verified side and persona for a token, or null for anything else. */
  async identify(token: string | null): Promise<{ side: Side; email: string } | null> {
    if (!token || token.length > 4096) return null;
    try {
      const principal = await (await this.issuer.verifier()).verify(token);
      const entry = this.sides.get(principal.jti);
      return entry ? { side: entry.side, email: principal.sub } : null;
    } catch {
      return null;
    }
  }
}

export interface DemoDeps {
  /** The kill switch: MODEL_CALLS is exactly "on". */
  modelCallsOn: boolean;
  /** The visitor key, set by the Worker (a salted hash of the IP, never the IP). */
  visitor: string;
  reserveTicket: (visitor: string, worstUsd: number) => Promise<Reservation>;
  settle: (id: string, actualUsd: number) => Promise<void>;
  /** Keep the runtime alive until this settles (the Durable Object's waitUntil). */
  waitUntil: (work: Promise<unknown>) => void;
  /** The public hostname, accepted in `Host` next to the loopback names. */
  extraHosts?: ReadonlySet<string>;
  maxTickets?: number;
}

const RUN_PATH = /^\/api\/runs\/([0-9a-f]{16})$/;
const DECISION_PATH = /^\/api\/runs\/([0-9a-f]{16})\/decision$/;
const error = (status: number, message: string) => json(status, { error: message });

/** What the left side may see of its own run: the reply and whether it's waiting. */
function requesterView(full: Record<string, unknown>): Record<string, unknown> {
  return {
    run_id: full.run_id,
    ticket_id: full.ticket_id,
    requester: full.requester,
    status: full.status,
    final_text: full.final_text,
    tool_turns: full.tool_turns,
  };
}

/** Handle one tier 2 request for a session whose session-token hash is `expectedHash`. */
export async function handleDemoApi(
  request: Request,
  session: Session,
  expectedHash: string,
  signIns: SideSignIns,
  directory: Directory,
  deps: DemoDeps,
): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (!path.startsWith("/api/")) return error(404, "Not found.");
  if (!hostOk(request, deps.extraHosts)) return error(403, "Bad Host header.");
  if (request.method === "POST" && !originOk(request)) {
    return error(403, "Request not from this page.");
  }
  if (!(await tokenOk(request, expectedHash))) return error(403, "Missing or wrong token.");

  if (request.method === "GET" && path === "/api/requesters") {
    return json(200, personas(directory));
  }

  let data: Record<string, unknown> = {};
  if (request.method === "POST") {
    try {
      data = await readJson(request);
    } catch (exc) {
      return error(400, exc instanceof BadRequest ? exc.message : "Bad request.");
    }
  } else if (request.method !== "GET") {
    return error(405, "Method not allowed.");
  }

  if (request.method === "POST" && path === "/api/sign-in") {
    const { side, email } = data;
    if (typeof side !== "string" || !SIDES.has(side)) {
      return error(400, "side is requester or helpdesk.");
    }
    const allowed = personas(directory)[side as Side];
    if (typeof email !== "string" || !allowed.some((p) => p.email === email)) {
      return error(
        400,
        side === "helpdesk"
          ? "Pick a helpdesk persona from the list."
          : "Pick a requester from the list (helpdesk staff sign in on the right).",
      );
    }
    const { token, expiresIn } = await signIns.signIn(side as Side, email);
    return json(200, { side, email, token, expires_in: expiresIn, simulated: true });
  }

  // Everything else needs a side's sign-in.
  const who = await signIns.identify(request.headers.get(IDENTITY_HEADER));
  if (!who) return error(401, "Sign in again (simulated sign-in).");

  if (request.method === "GET") {
    if (path === "/api/log") {
      if (who.side !== "helpdesk")
        return error(403, "Only the helpdesk side sees the audit trail.");
      return json(200, await session.log());
    }
    if (path === "/api/current") {
      const id = session.currentRunId();
      const visible = id && (who.side === "helpdesk" || session.runRequester(id) === who.email);
      return json(200, { run_id: visible ? id : null });
    }
    const run = RUN_PATH.exec(path);
    const id = run?.[1];
    if (!id) return error(404, "Not found.");
    if (who.side === "requester") {
      if (session.runRequester(id) !== who.email) return error(404, "Not found.");
      // A read that doesn't mark a pending proposal as shown: only the helpdesk sees it.
      const full = session.peek(id);
      return full ? json(200, requesterView(full)) : error(404, "Not found.");
    }
    const snap = session.snapshot(id);
    return snap ? json(200, snap) : error(404, "Not found.");
  }

  if (path === "/api/runs") {
    const ticket = data.ticket;
    if (typeof ticket !== "string" || !ticket.trim()) return error(400, "Ticket text is empty.");
    if (pyLen(ticket) > 8_000) return error(400, "Ticket text is longer than 8000 characters.");
    if (!deps.modelCallsOn) {
      return error(503, "The demo's model calls are switched off right now. Try again later.");
    }
    if (session.ticketCount >= (deps.maxTickets ?? DEMO_MAX_TICKETS)) {
      return error(
        429,
        `This demo session has used its ${deps.maxTickets ?? DEMO_MAX_TICKETS} tickets. Start a new session to try more.`,
      );
    }
    if (session.isBusy()) return error(409, "Another ticket is still running.");
    let reservation: Reservation;
    try {
      reservation = await deps.reserveTicket(deps.visitor, ticketWorstCaseUsd());
    } catch {
      return error(503, "The demo is unavailable right now. Please try again later.");
    }
    if (!reservation.ok) return error(429, reservation.reason);
    const reservationId = reservation.id;
    let runId: string;
    try {
      // The requester is the signed-in persona; a body field naming someone is ignored.
      runId = (await session.startRun(who.email, ticket)).id;
    } catch (exc) {
      await deps.settle(reservationId, 0).catch(() => {});
      if (exc instanceof BadRequest) return error(400, exc.message);
      if (exc instanceof Busy) return error(409, exc.message);
      return error(500, "The run could not start.");
    }
    // Settle at the real cost once the run ends (unknown cost settles as the reservation).
    const done = session.active.then(
      () => deps.settle(reservationId, session.runCost(runId) ?? Number.NaN),
      () => deps.settle(reservationId, Number.NaN),
    );
    deps.waitUntil(done.catch(() => {}));
    return json(202, { run_id: runId });
  }

  const decision = DECISION_PATH.exec(path);
  if (decision) {
    if (who.side !== "helpdesk") {
      return error(403, "The requester side can't approve or deny writes.");
    }
    const choice = data.decision;
    if (choice !== "approve" && choice !== "deny") {
      return error(400, "decision is approve or deny.");
    }
    const result = await session.decideAs(
      decision[1] as string,
      data.proposal_id,
      choice === "approve",
      who.email,
    );
    if (!result.ok) {
      if (result.refusal) return json(409, { error: "Refused by rule.", rule: result.refusal });
      return error(
        409,
        "No such pending proposal, or Approve was clicked before it had been on screen for a moment.",
      );
    }
    return json(200, { recorded: choice, by: who.email });
  }

  return error(404, "Not found.");
}

export interface NewSessionDeps {
  modelCallsOn: boolean;
  /** False when the visitor salt is missing: the per-visitor limits couldn't count. */
  saltSet: boolean;
  visitor: string;
  remoteip: string;
  verifyTurnstile: (token: unknown, remoteip: string) => Promise<boolean>;
  allowSession: (visitor: string) => Promise<boolean>;
  create: () => Promise<{ session: string; token: string } | null>;
}

/**
 * POST /api/sessions, after the Host, Origin and body checks. In order, failing closed:
 * the salt, the kill switch, Turnstile, then the per-visitor and site-wide session limits.
 */
export async function handleNewSession(
  data: Record<string, unknown>,
  deps: NewSessionDeps,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const off = {
    status: 503,
    body: { error: "The demo is switched off right now. Please try again later." },
  };
  if (!deps.saltSet || !deps.modelCallsOn) return off;
  let verified = false;
  try {
    verified = await deps.verifyTurnstile(data.turnstile, deps.remoteip);
  } catch {
    verified = false;
  }
  if (!verified) {
    return { status: 403, body: { error: "The human check didn't pass. Please try again." } };
  }
  let allowed = false;
  try {
    allowed = await deps.allowSession(deps.visitor);
  } catch {
    return off;
  }
  if (!allowed) {
    return {
      status: 429,
      body: { error: "You've started today's limit of demo sessions. Try again tomorrow." },
    };
  }
  const created = await deps.create();
  if (!created) return { status: 500, body: { error: "Could not create a session." } };
  return { status: 201, body: created };
}
