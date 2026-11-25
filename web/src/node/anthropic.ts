/**
 * The real Anthropic client, for Node only. The SDK reads ANTHROPIC_API_KEY from the
 * environment, which only `op run --env-file=.env.tpl` sets: no key is passed here, and
 * nothing here reads or logs the environment. Unit tests never call this.
 */
import Anthropic from "@anthropic-ai/sdk";

import { MAX_RETRIES, type MessagesClient, TIMEOUT_SECONDS } from "../client.ts";

export function makeClient(): MessagesClient {
  // The TypeScript SDK takes the timeout in milliseconds (Python's takes seconds).
  return new Anthropic({ maxRetries: MAX_RETRIES, timeout: TIMEOUT_SECONDS * 1000 });
}
