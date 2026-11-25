/**
 * The session API over the Fetch standard (Request in, Response out), so the same code
 * runs in the Durable Object and in Node tests. Port of the handler in `webui.py`.
 *
 * Every request must name this server in `Host` (127.0.0.1 or localhost: against DNS
 * rebinding) and carry the session token in a custom header. Every POST must also come
 * from this page's own origin with a JSON body of at most 16 KB. No CORS headers are sent.
 * Error responses never include exception text.
 */
import { BadRequest, Busy, type Session, timingSafeEqual } from "./session.ts";

export const SESSION_HEADER = "X-Helpdesk-Session";
export const TOKEN_HEADER = "X-Helpdesk-Token";
export const MAX_BODY_BYTES = 16_384;
export const LOCAL_HOSTNAMES: ReadonlySet<string> = new Set(["127.0.0.1", "localhost"]);

export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; " +
    "img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
};

const RUN_PATH = /^\/api\/runs\/([0-9a-f]{16})$/;
const DECISION_PATH = /^\/api\/runs\/([0-9a-f]{16})\/decision$/;

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...SECURITY_HEADERS },
  });
}

const error = (status: number, message: string) => json(status, { error: message });

/** `Host` must be this server, on a loopback name. */
export function hostOk(request: Request): boolean {
  const host = request.headers.get("Host") ?? "";
  const url = new URL(request.url);
  let hostname: string;
  try {
    hostname = new URL(`http://${host}`).hostname;
  } catch {
    return false;
  }
  return host === url.host && LOCAL_HOSTNAMES.has(hostname);
}

/** POSTs must come from this page's own origin. */
export const originOk = (request: Request): boolean =>
  request.headers.get("Origin") === new URL(request.url).origin;

/** Read a JSON object body, or throw BadRequest with a fixed message. */
export async function readJson(request: Request): Promise<Record<string, unknown>> {
  const ctype = (request.headers.get("Content-Type") ?? "").split(";")[0]?.trim().toLowerCase();
  if (ctype !== "application/json") throw new BadRequest("Content-Type must be application/json.");
  const declared = Number(request.headers.get("Content-Length") ?? "0");
  if (declared > MAX_BODY_BYTES) throw new BadRequest("Request body is too large.");
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.length > MAX_BODY_BYTES) throw new BadRequest("Request body is too large.");
  let data: unknown;
  try {
    data = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    throw new BadRequest("Request body is not valid JSON.");
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new BadRequest("Expected a JSON object.");
  }
  return data as Record<string, unknown>;
}

/** SHA-256 hex of a token: what a session stores instead of the token itself. */
export async function tokenHash(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function tokenOk(request: Request, expectedHash: string): Promise<boolean> {
  const sent = request.headers.get(TOKEN_HEADER) ?? "";
  return timingSafeEqual(await tokenHash(sent), expectedHash);
}

/** Handle one request for a session whose token hash is `expectedHash`. */
export async function handleSessionApi(
  request: Request,
  session: Session,
  expectedHash: string,
): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (!path.startsWith("/api/")) return error(404, "Not found.");
  if (!hostOk(request)) return error(403, "Bad Host header.");

  if (request.method === "GET") {
    if (!(await tokenOk(request, expectedHash))) return error(403, "Missing or wrong token.");
    if (path === "/api/requesters") return json(200, { requesters: session.requesters });
    if (path === "/api/current") return json(200, { run_id: session.currentRunId() });
    if (path === "/api/log") return json(200, await session.log());
    const run = RUN_PATH.exec(path);
    const snap = run ? session.snapshot(run[1] as string) : null;
    return snap ? json(200, snap) : error(404, "Not found.");
  }

  if (request.method === "POST") {
    if (!(originOk(request) && (await tokenOk(request, expectedHash)))) {
      return error(403, "Request not from this page.");
    }
    let data: Record<string, unknown>;
    try {
      data = await readJson(request);
    } catch (exc) {
      return error(400, exc instanceof BadRequest ? exc.message : "Bad request.");
    }
    if (path === "/api/runs") {
      try {
        const run = await session.startRun(data.requester, data.ticket);
        return json(202, { run_id: run.id });
      } catch (exc) {
        if (exc instanceof BadRequest) return error(400, exc.message);
        if (exc instanceof Busy) return error(409, exc.message);
        return error(500, "The run could not start.");
      }
    }
    const decision = DECISION_PATH.exec(path);
    if (decision) {
      const choice = data.decision;
      if (choice !== "approve" && choice !== "deny") {
        return error(400, "decision is approve or deny.");
      }
      if (!session.decide(decision[1] as string, data.proposal_id, choice === "approve")) {
        return error(
          409,
          "No such pending proposal, or Approve was clicked before it had been on screen for a moment.",
        );
      }
      return json(200, { recorded: choice });
    }
    return error(404, "Not found.");
  }

  return error(405, "Method not allowed.");
}
