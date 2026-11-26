// A test build with the REAL client code (src/worker/anthropic.ts), pointed at a local
// stub API by ANTHROPIC_BASE_URL with a dummy key: test/worker-real.test.ts. It checks the
// SDK runs in workerd and finds both values in the environment. Never the real API.
import { makeRealClient } from "../../src/worker/anthropic.ts";
import { type Env, safeRoute } from "../../src/worker/routes.ts";
import { sessionObjectClass } from "../../src/worker/session-object.ts";

export { Budget } from "../../src/worker/budget-object.ts";

export const HelpdeskSession = sessionObjectClass(makeRealClient, {
  minReviewMs: 200,
  approvalTimeoutMs: 10_000,
});

export default {
  fetch: (request, env) => safeRoute(request, env, makeRealClient),
} satisfies ExportedHandler<Env>;
