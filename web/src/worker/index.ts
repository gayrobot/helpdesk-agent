/**
 * The Cloudflare Worker (Phase 7, slice 6). Local only: `npm run dev:worker` starts it on
 * 127.0.0.1 with no inspector port. No deploys before Phase 10.
 *
 * GET /             the page (public/, served by the assets binding)
 * POST /api/sessions   a new session: { session, token }
 * /api/...          forwarded to that session's Durable Object (src/api.ts)
 */

import { makeRealClient } from "./anthropic.ts";
import { type Env, safeRoute } from "./routes.ts";
import { sessionObjectClass } from "./session-object.ts";

export const HelpdeskSession = sessionObjectClass(makeRealClient);

export default {
  fetch: (request, env) => safeRoute(request, env),
} satisfies ExportedHandler<Env>;
