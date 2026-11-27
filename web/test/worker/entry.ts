// A test build of the Worker: the same router and Durable Object, with a scripted model
// instead of the real client and a Turnstile check that needs no network. Used by
// test/worker-session.test.ts and for checking the page in a browser without a key.
// Never deployed: the real entry is src/worker/index.ts.
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
    safeRoute(request, env, loopingClient, { verifyTurnstile: testTurnstile }),
} satisfies ExportedHandler<Env>;
