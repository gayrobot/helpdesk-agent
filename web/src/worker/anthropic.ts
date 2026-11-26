/**
 * The real Anthropic client inside the Worker. With nodejs_compat, the environment is filled
 * from the ANTHROPIC_API_KEY secret binding, so the SDK reads the key itself: nothing
 * here passes, reads or logs it.
 */
import Anthropic from "@anthropic-ai/sdk";

import { MAX_RETRIES, type MessagesClient, TIMEOUT_SECONDS } from "../client.ts";

export function makeRealClient(): MessagesClient {
  // The TypeScript SDK takes the timeout in milliseconds.
  return new Anthropic({ maxRetries: MAX_RETRIES, timeout: TIMEOUT_SECONDS * 1000 });
}
