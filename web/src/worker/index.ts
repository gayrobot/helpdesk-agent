/**
 * The Cloudflare Worker (Phase 7, slice 6). Local only for now: `npm run dev:worker`
 * starts it on 127.0.0.1 with no inspector port. No deploys before Phase 10.
 *
 * This first part only proves the core bundles and runs in workerd: `GET /api/health`
 * builds the BM25 index from the bundled runbooks and loads the directory. The session
 * Durable Object, the API and the page come next.
 */
import { bundledChunks } from "../bundled.ts";
import { Directory } from "../directory.ts";

export interface Env {
  ANTHROPIC_API_KEY?: string; // the SDK reads it from the environment (nodejs_compat); this code never does
}

const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...SECURITY_HEADERS },
  });
}

export default {
  async fetch(request: Request, _env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/api/health") {
      const chunks = bundledChunks();
      return json(200, {
        ok: true,
        runbooks: new Set(chunks.map((c) => c.runbook)).size,
        chunks: chunks.length,
        users: Directory.load().users.size,
      });
    }
    return json(404, { error: "Not found." });
  },
} satisfies ExportedHandler<Env>;
