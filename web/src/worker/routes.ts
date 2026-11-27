/**
 * The Worker's router. Static files (public/) are served by the assets binding; only /api/*
 * reaches here.
 *
 * Public (tier 1): GET /api/config, GET /api/health, POST /api/ask.
 * Tier 2 (the split-screen demo): POST /api/sessions, and the session API in
 * `TIER2_ROUTES` forwarded to each session's Durable Object. Public only while
 * `TIER2_PUBLIC` is true; any other /api/ path is 404 on the public hostname.
 */
import { hostOk, isLocal, json, originOk, readJson, SESSION_HEADER, tokenHash } from "../api.ts";
import { type AskResult, askRunbooks, handleAsk } from "../ask.ts";
import type { Reservation } from "../budget.ts";
import { visitorKey } from "../budget.ts";
import { bundledAclRetriever, bundledChunks } from "../bundled.ts";
import type { MessagesClient } from "../client.ts";
import { handleNewSession } from "../demo.ts";
import { Directory } from "../directory.ts";
import { DevIssuer } from "../identity.ts";
import { BadRequest } from "../session.ts";
import { verifyTurnstile } from "../turnstile.ts";
import { BUDGET_NAME } from "./budget-object.ts";

export interface BudgetRpc {
  reserveAsk(visitor: string, worstUsd: number): Promise<Reservation>;
  reserveTicket(visitor: string, worstUsd: number): Promise<Reservation>;
  settle(id: string, actualUsd: number): Promise<void>;
  allowSession(visitor: string): Promise<boolean>;
}

export interface Env {
  SESSIONS: DurableObjectNamespace<
    { init(hash: string): Promise<boolean> } & Rpc.DurableObjectBranded
  >;
  BUDGET: DurableObjectNamespace<BudgetRpc & Rpc.DurableObjectBranded>;
  ASSETS: Fetcher;
  /** The public hostname, e.g. hddemo.damiano.dev. */
  SITE_HOSTNAME?: string;
  TURNSTILE_SITEKEY?: string;
  /** Secrets. MODEL_CALLS must be exactly "on" for any model call (unset means off). */
  MODEL_CALLS?: string;
  TURNSTILE_SECRET?: string;
  VISITOR_SALT?: string;
}

/**
 * Whether tier 2 is open on the public hostname. Locally it always is. Opening it is its
 * own change, after the demo's limits and labels are in place.
 */
export const TIER2_PUBLIC = true;

/** The session API paths a public request may reach (anything else under /api/ is 404). */
const TIER2_ROUTES: readonly RegExp[] = [
  /^\/api\/sign-in$/,
  /^\/api\/requesters$/,
  /^\/api\/current$/,
  /^\/api\/log$/,
  /^\/api\/runs$/,
  /^\/api\/runs\/[0-9a-f]{16}$/,
  /^\/api\/runs\/[0-9a-f]{16}\/decision$/,
];
export const isTier2Route = (path: string) => TIER2_ROUTES.some((r) => r.test(path));

/** Set by this Worker on requests it forwards to a session; a visitor's own is dropped. */
export const VISITOR_HEADER = "X-Helpdesk-Visitor";

/** Cloudflare's always-pass test site key, used only on loopback hosts. */
export const TEST_SITEKEY = "1x00000000000000000000AA";
const SESSION_ID = /^[0-9a-f]{64}$/;

function randomHex(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const siteHosts = (env: Env): ReadonlySet<string> =>
  new Set(env.SITE_HOSTNAME ? [env.SITE_HOSTNAME] : []);

/** Test builds only: replaces the call to Siteverify (the real entry passes nothing). */
export interface RouteOptions {
  verifyTurnstile?: (token: unknown, remoteip: string) => Promise<boolean>;
  /** Test builds only: open tier 2 on the public hostname regardless of TIER2_PUBLIC. */
  tier2Public?: boolean;
}

/** `route`, with any unexpected error turned into a fixed 500 (never the error text). */
export async function safeRoute(
  request: Request,
  env: Env,
  makeClient: () => MessagesClient,
  options: RouteOptions = {},
): Promise<Response> {
  try {
    return await route(request, env, makeClient, options);
  } catch {
    return json(500, { error: "Internal error." });
  }
}

let issuer: DevIssuer | null = null;

export async function route(
  request: Request,
  env: Env,
  makeClient: () => MessagesClient,
  options: RouteOptions = {},
): Promise<Response> {
  const checkTurnstile = (token: unknown, remoteip: string) =>
    options.verifyTurnstile
      ? options.verifyTurnstile(token, remoteip)
      : turnstile(env, isLocal(request), token, remoteip);
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
  if (!hostOk(request, siteHosts(env))) return json(403, { error: "Bad Host header." });
  const local = isLocal(request);
  const tier2Open = local || (options.tier2Public ?? TIER2_PUBLIC);

  if (url.pathname === "/api/health" && request.method === "GET") {
    const chunks = bundledChunks();
    return json(200, {
      ok: true,
      runbooks: new Set(chunks.map((c) => c.runbook)).size,
      chunks: chunks.length,
      users: Directory.load().users.size,
    });
  }

  if (url.pathname === "/api/config" && request.method === "GET") {
    return json(200, {
      turnstileSiteKey: local ? TEST_SITEKEY : (env.TURNSTILE_SITEKEY ?? null),
      answersOn: env.MODEL_CALLS === "on",
      tiers: { ask: true, demo: tier2Open, signIn: false },
    });
  }

  if (url.pathname === "/api/ask") {
    if (request.method !== "POST") return json(405, { error: "Method not allowed." });
    if (!originOk(request)) return json(403, { error: "Request not from this page." });
    let data: Record<string, unknown>;
    try {
      data = await readJson(request);
    } catch (exc) {
      return json(400, { error: exc instanceof BadRequest ? exc.message : "Bad request." });
    }
    // CF-Connecting-IP is set by Cloudflare; X-Forwarded-For can be forged, so it's never used.
    const ip = request.headers.get("CF-Connecting-IP") ?? (local ? "127.0.0.1" : "");
    if (!ip) return json(403, { error: "Request not from this page." });
    // Without a salt the per-visitor limits can't count: refuse rather than run unlimited.
    if (!env.VISITOR_SALT && !local) {
      return json(503, { error: "Answers are switched off right now. Please try again later." });
    }
    const budget = env.BUDGET.get(env.BUDGET.idFromName(BUDGET_NAME));
    issuer ??= new DevIssuer();
    const reply = await handleAsk(data, {
      modelCallsOn: env.MODEL_CALLS === "on",
      visitor: await visitorKey(ip, env.VISITOR_SALT ?? "local"),
      remoteip: ip,
      verifyTurnstile: checkTurnstile,
      reserve: (visitor, worst) => budget.reserveAsk(visitor, worst),
      settle: (id, actual) => budget.settle(id, actual),
      answer: (question): Promise<AskResult> =>
        askRunbooks(question, {
          client: makeClient(),
          retriever: bundledAclRetriever(),
          issuer: issuer as DevIssuer,
        }),
    });
    return json(reply.status, reply.body);
  }

  // Tier 2 (the split-screen demo).
  if (!tier2Open) return json(404, { error: "Not found." });
  // CF-Connecting-IP is set by Cloudflare; X-Forwarded-For can be forged, so it's never used.
  const ip = request.headers.get("CF-Connecting-IP") ?? (local ? "127.0.0.1" : "");

  if (url.pathname === "/api/sessions") {
    if (request.method !== "POST") return json(405, { error: "Method not allowed." });
    if (!originOk(request)) return json(403, { error: "Request not from this page." });
    let data: Record<string, unknown>;
    try {
      data = await readJson(request);
    } catch (exc) {
      return json(400, { error: exc instanceof BadRequest ? exc.message : "Bad request." });
    }
    if (!ip) return json(403, { error: "Request not from this page." });
    const budget = env.BUDGET.get(env.BUDGET.idFromName(BUDGET_NAME));
    const reply = await handleNewSession(data, {
      modelCallsOn: env.MODEL_CALLS === "on",
      saltSet: Boolean(env.VISITOR_SALT) || local,
      visitor: await visitorKey(ip, env.VISITOR_SALT ?? "local"),
      remoteip: ip,
      verifyTurnstile: checkTurnstile,
      allowSession: (visitor) => budget.allowSession(visitor),
      create: async () => {
        const id = env.SESSIONS.newUniqueId();
        const token = randomHex(32);
        if (!(await env.SESSIONS.get(id).init(await tokenHash(token)))) return null;
        return { session: id.toString(), token };
      },
    });
    return json(reply.status, reply.body);
  }

  if (!isTier2Route(url.pathname)) return json(404, { error: "Not found." });
  const sessionId = request.headers.get(SESSION_HEADER) ?? "";
  if (!SESSION_ID.test(sessionId)) return json(403, { error: "Missing or unknown session." });
  let id: DurableObjectId;
  try {
    id = env.SESSIONS.idFromString(sessionId);
  } catch {
    return json(403, { error: "Missing or unknown session." });
  }
  if (!ip || (!env.VISITOR_SALT && !local)) {
    return json(503, { error: "The demo is switched off right now. Please try again later." });
  }
  // The session's limits count by visitor: pass the key, never the IP.
  const forwarded = new Request(request);
  forwarded.headers.delete(VISITOR_HEADER);
  forwarded.headers.set(VISITOR_HEADER, await visitorKey(ip, env.VISITOR_SALT ?? "local"));
  return env.SESSIONS.get(id).fetch(forwarded);
}

function turnstile(env: Env, local: boolean, token: unknown, remoteip: string): Promise<boolean> {
  const options: Parameters<typeof verifyTurnstile>[1] = {
    secret: env.TURNSTILE_SECRET ?? "",
    remoteip,
  };
  if (!local && env.SITE_HOSTNAME) options.expectedHostname = env.SITE_HOSTNAME;
  return verifyTurnstile(token, options);
}
