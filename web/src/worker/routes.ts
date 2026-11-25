/**
 * The Worker's router: session creation and forwarding to the session's Durable Object.
 * Static files (public/) are served by the assets binding; only /api/* reaches here.
 */
import { hostOk, json, originOk, readJson, SESSION_HEADER, tokenHash } from "../api.ts";
import { bundledChunks } from "../bundled.ts";
import { Directory } from "../directory.ts";
import { BadRequest } from "../session.ts";

export interface Env {
  SESSIONS: DurableObjectNamespace<
    { init(hash: string): Promise<boolean> } & Rpc.DurableObjectBranded
  >;
  ASSETS: Fetcher;
}

const SESSION_ID = /^[0-9a-f]{64}$/;

function randomHex(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
  if (!hostOk(request)) return json(403, { error: "Bad Host header." });

  if (url.pathname === "/api/health" && request.method === "GET") {
    const chunks = bundledChunks();
    return json(200, {
      ok: true,
      runbooks: new Set(chunks.map((c) => c.runbook)).size,
      chunks: chunks.length,
      users: Directory.load().users.size,
    });
  }

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
