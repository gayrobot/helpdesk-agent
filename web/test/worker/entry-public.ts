// A test build with tier 2 open on the public hostname (demo.example.test), so the
// deployed path is tested before it is opened: the session's host check, the visitor's
// IP from CF-Connecting-IP, and the limits. test/worker-public.test.ts. Never deployed.
import { type Env, safeRoute } from "../../src/worker/routes.ts";
import { sessionObjectClass } from "../../src/worker/session-object.ts";
import { loopingClient, testTurnstile } from "./client.ts";

export { Budget } from "../../src/worker/budget-object.ts";

export const HelpdeskSession = sessionObjectClass(loopingClient, {
  minReviewMs: 200,
  approvalTimeoutMs: 10_000,
});

export default {
  fetch: (request, env) =>
    safeRoute(request, env, loopingClient, { verifyTurnstile: testTurnstile, tier2Public: true }),
} satisfies ExportedHandler<Env>;
