/**
 * Server-side Turnstile check for the anonymous tier (Phase 9, tier 1), per Cloudflare's
 * "Validate the token" docs: every token goes to Siteverify, tokens are single-use and
 * expire after five minutes, and the client-side widget alone protects nothing.
 *
 * Fails closed: a missing token, a network error, a non-JSON reply, `success: false`, or
 * (when an expected hostname is set) a different hostname all mean "not verified".
 */
export const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const MAX_TOKEN_LENGTH = 2048;

export interface TurnstileOptions {
  secret: string;
  /** The visitor's IP, passed on to Siteverify. */
  remoteip?: string;
  /** The site's hostname; when set, the token must have been issued for it. */
  expectedHostname?: string;
  fetch?: typeof fetch;
}

export async function verifyTurnstile(token: unknown, options: TurnstileOptions): Promise<boolean> {
  if (typeof token !== "string" || !token || token.length > MAX_TOKEN_LENGTH) return false;
  if (!options.secret) return false;
  const body: Record<string, string> = { secret: options.secret, response: token };
  if (options.remoteip) body.remoteip = options.remoteip;
  let result: unknown;
  try {
    const res = await (options.fetch ?? fetch)(SITEVERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) return false;
    result = await res.json();
  } catch {
    return false;
  }
  if (!result || typeof result !== "object") return false;
  const r = result as { success?: unknown; hostname?: unknown };
  if (r.success !== true) return false;
  if (options.expectedHostname && r.hostname !== options.expectedHostname) return false;
  return true;
}
