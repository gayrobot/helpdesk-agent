// The test builds' scripted model (no key). Kept out of the entry modules, whose every
// export workerd treats as a handler.
import type { BetaMessage } from "@anthropic-ai/sdk/resources/beta/messages/messages";

import type { MessagesClient } from "../../src/client.ts";
import { message, text, toolUse } from "../fakes.ts";

/** Every run: look the requester up, propose an MFA reset for Jamie, then reply. */
export function loopingClient(): MessagesClient {
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

/**
 * The test builds' Turnstile, with no call to Siteverify: the tests' own token, or the
 * dummy token Cloudflare's always-pass test site key gives a browser (for checking the page).
 */
export const testTurnstile = async (token: unknown) =>
  token === "test-human" || token === "XXXX.DUMMY.TOKEN.XXXX";
