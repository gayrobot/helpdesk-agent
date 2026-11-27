/**
 * The Cloudflare Worker: the public site at hddemo.damiano.dev (Phase 9, tiers 1 and 2),
 * and locally `npm run dev:worker` on 127.0.0.1 with no inspector port.
 *
 * GET /                the pages (public/, served by the assets binding)
 * POST /api/ask        tier 1: a runbook question (src/ask.ts)
 * POST /api/sessions   tier 2: a new demo session, behind Turnstile: { session, token }
 * /api/...             tier 2: the allowlisted session API, forwarded to that session's
 *                      Durable Object (src/demo.ts)
 */

import { makeRealClient } from "./anthropic.ts";
import { type Env, safeRoute } from "./routes.ts";
import { sessionObjectClass } from "./session-object.ts";

export { Budget } from "./budget-object.ts";

export const HelpdeskSession = sessionObjectClass(makeRealClient);

export default {
  fetch: (request, env) => safeRoute(request, env, makeRealClient),
} satisfies ExportedHandler<Env>;
