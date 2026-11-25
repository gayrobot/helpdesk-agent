// A test build of the Worker: the same router and Durable Object, with a scripted model
// instead of the real client. Used by test/worker-session.test.ts and for checking the
// page in a browser without a key. Never deployed: the real entry is src/worker/index.ts.
import type { BetaMessage } from "@anthropic-ai/sdk/resources/beta/messages/messages";

import type { MessagesClient } from "../../src/client.ts";
import { type Env, route } from "../../src/worker/routes.ts";
import { sessionObjectClass } from "../../src/worker/session-object.ts";
import { message, text, toolUse } from "../fakes.ts";

/** Every run: look the requester up, propose an MFA reset for Jamie, then reply. */
function loopingClient(): MessagesClient {
  let i = 0;
  const turns = (): BetaMessage[] => [
    message([toolUse("lookup_user", { email: "jamie@example.test" }, "t1")], "tool_use"),
    message([toolUse("reset_mfa", { email: "jamie@example.test" }, "t2")], "tool_use"),
    message([text("I've handled your MFA request.\nSource: okta-verify-reenrollment")], "end_turn"),
  ];
  return {
    beta: {
      messages: {
        create: async () => turns()[i++ % 3] as BetaMessage,
      },
    },
  };
}

export const HelpdeskSession = sessionObjectClass(loopingClient, {
  minReviewMs: 200,
  approvalTimeoutMs: 10_000,
});

export default {
  fetch: (request, env) => route(request, env),
} satisfies ExportedHandler<Env>;
