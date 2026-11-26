/**
 * The Worker's router. Static files (public/) are served by the assets binding; only /api/*
 * reaches here.
 *
 * Public (tier 1): GET /api/config, GET /api/health, POST /api/ask.
 * Local only until tier 2 ships (it needs identity phases I2-I4): POST /api/sessions and
 * the session API forwarded to each session's Durable Object.
 */
import { hostOk, isLocal, json, originOk, readJson, SESSION_HEADER, tokenHash } from "../api.ts";
import { type AskResult, askRunbooks, handleAsk } from "../ask.ts";
import type { Reservation } from "../budget.ts";
import { visitorKey } from "../budget.ts";
import { bundledChunks, bundledRetriever } from "../bundled.ts";
import type { MessagesClient } from "../client.ts";
import { Directory } from "../directory.ts";
import { DevIssuer } from "../identity.ts";
import { BadRequest } from "../session.ts";
import { verifyTurnstile } from "../turnstile.ts";
import { BUDGET_NAME } from "./budget-object.ts";

interface BudgetRpc {
  reserveAsk(visitor: string, worstUsd: number): Promise<Reservation>;
  settle(id: string, actualUsd: number): Promise<void>;
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

/** `route`, with any unexpected error turned into a fixed 500 (never the error text). */
export async function safeRoute(
  request: Request,
  env: Env,
  makeClient: () => MessagesClient,
): Promise<Response> {
  try {
    return await route(request, env, makeClient);
  } catch {
    return json(500, { error: "Internal error." });
  }
}

let issuer: DevIssuer | null = null;

export async function route(
  request: Request,
  env: Env,
  makeClient: () => MessagesClient,
): Promise<Response> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
  if (!hostOk(request, siteHosts(env))) return json(403, { error: "Bad Host header." });
  const local = isLocal(request);

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
      tiers: { ask: true, demo: local, signIn: false },
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
      verifyTurnstile: (token, remoteip) => {
        const options: Parameters<typeof verifyTurnstile>[1] = {
          secret: env.TURNSTILE_SECRET ?? "",
          remoteip,
        };
        if (!local && env.SITE_HOSTNAME) options.expectedHostname = env.SITE_HOSTNAME;
        return verifyTurnstile(token, options);
      },
      reserve: (visitor, worst) => budget.reserveAsk(visitor, worst),
      settle: (id, actual) => budget.settle(id, actual),
      answer: (question): Promise<AskResult> =>
        askRunbooks(question, {
          client: makeClient(),
          retriever: bundledRetriever(),
          issuer: issuer as DevIssuer,
        }),
    });
    return json(reply.status, reply.body);
  }

  // Tier 2 (the split-screen demo) is local only until identity phases I2-I4 are done.
  if (!local) return json(404, { error: "Not found." });

  if (url.pathname === "/api/sessions") {
    if (request.method !== "POST") return json(405, { error: "Method not allowed." });
    if (!originOk(request)) return json(403, { error: "Request not from this page." });
    try {
      await readJson(request);
    } catch (exc) {
      return json(400, { error: exc instanceof BadRequest ? exc.message : "Bad request." });
    }
    const id = env.SESSIONS.newUniqueId();
    const token = randomHex(32);
    if (!(await env.SESSIONS.get(id).init(await tokenHash(token)))) {
      return json(500, { error: "Could not create a session." });
    }
    return json(201, { session: id.toString(), token });
  }

  const sessionId = request.headers.get(SESSION_HEADER) ?? "";
  if (!SESSION_ID.test(sessionId)) return json(403, { error: "Missing or unknown session." });
  let id: DurableObjectId;
  try {
    id = env.SESSIONS.idFromString(sessionId);
  } catch {
    return json(403, { error: "Missing or unknown session." });
  }
  return env.SESSIONS.get(id).fetch(request);
}
