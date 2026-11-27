// A test build with a 1.5 s session lifetime, for the cleanup alarm
// (test/worker-cleanup.test.ts uses the same value). Never deployed.
import { type Env, safeRoute } from "../../src/worker/routes.ts";
import { sessionObjectClass } from "../../src/worker/session-object.ts";
import { loopingClient, testTurnstile } from "./client.ts";

export { Budget } from "../../src/worker/budget-object.ts";

export const HelpdeskSession = sessionObjectClass(loopingClient, {
  minReviewMs: 200,
  approvalTimeoutMs: 10_000,
  ttlMs: 1_500,
});

export default {
  fetch: (request, env) =>
    safeRoute(request, env, loopingClient, { verifyTurnstile: testTurnstile }),
} satisfies ExportedHandler<Env>;
