/**
 * Okta as the issuer (identity phase I5, docs/identity-plan.md): the key-free half.
 *
 * - `oktaIssuer`: checks a configured issuer URL is an Okta custom authorization server
 *   over https. The JWKS URL is derived from it (`<issuer>/v1/keys`), never read from a
 *   discovery document or a token.
 * - `JwksKeySet`: Okta's signing keys, fetched from that one URL, chosen by `kid`, RS256
 *   and at least 2048 bits only. An unknown `kid` triggers at most one refetch per minute
 *   (key rotation), so a stream of forged `kid`s can't turn the verifier into a fetch loop.
 * - `OktaGrantVerifier`: the resource side for tokens from Okta's On-Behalf-Of token
 *   exchange. Same checks as `GrantVerifier` where Okta's tokens allow them.
 *
 * Differences from the dev issuer's grants, written down rather than papered over:
 * - **No `ticket_id` claim.** Okta takes no custom claim from the request without a token
 *   inline hook. Ticket binding stays in the harness. A grant still can't be replayed into
 *   another ticket, because the session's replay cache takes each `jti` once.
 * - **Lifetime.** Okta's access policy sets it; its lower bound is unconfirmed, so the
 *   accepted maximum is configuration, not the dev issuer's 60 seconds.
 * - **Scopes** arrive as an `scp` array. Exactly one scope, the one this call needs.
 * - **The agent** is `act.sub` and `cid`: the agent app's Okta client id, from configuration.
 *
 * Nothing here signs anyone in or talks to Okta except the JWKS fetch. Tool handlers never
 * import this module.
 */
import { EMAIL_PATTERN } from "./governance.ts";
import {
  checkTimes,
  type Grant,
  type Key,
  type KeySet,
  MIN_RSA_BITS,
  parseClaims,
  type ReplayCache,
  requireClaims,
  TokenError,
  verifyJwsWithKeySet,
} from "./identity.ts";

/** An Okta custom authorization server's issuer: https, an okta host, `/oauth2/<id>`. */
const OKTA_ISSUER =
  /^https:\/\/[a-z0-9-]+\.(okta|oktapreview|okta-emea)\.com\/oauth2\/[A-Za-z0-9]+$/;

export function oktaIssuer(value: string): string {
  if (typeof value !== "string" || !OKTA_ISSUER.test(value)) {
    throw new Error("not an Okta custom authorization server issuer URL");
  }
  return value;
}

export function jwksUri(issuer: string): string {
  return `${oktaIssuer(issuer)}/v1/keys`;
}

// ---------------------------------------------------------------- JWKS

export interface JwksKeySetOptions {
  /** The authorization server's issuer; the key set URL is derived from it. */
  issuer: string;
  fetch: typeof fetch;
  now?: () => number;
  /** Keep a fetched set this long before refetching, in seconds. */
  cacheSeconds?: number;
  /** Never refetch more often than this, in seconds, whatever `kid` a token names. */
  minRefreshSeconds?: number;
}

const MAX_JWKS_BYTES = 64 * 1024;
const MAX_KEYS = 16;

export class JwksKeySet implements KeySet {
  readonly url: string;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly cacheSeconds: number;
  private readonly minRefreshSeconds: number;
  private keys = new Map<string, Key>();
  private fetchedAt = Number.NEGATIVE_INFINITY;
  private inFlight: Promise<void> | null = null;

  constructor(options: JwksKeySetOptions) {
    this.url = jwksUri(options.issuer);
    this.fetcher = options.fetch;
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
    this.cacheSeconds = options.cacheSeconds ?? 3600;
    this.minRefreshSeconds = options.minRefreshSeconds ?? 60;
  }

  async key(kid: string): Promise<Key> {
    const age = this.now() - this.fetchedAt;
    const known = this.keys.get(kid);
    if (known && age < this.cacheSeconds) return known;
    if (age >= this.minRefreshSeconds) await this.refresh();
    const key = this.keys.get(kid);
    if (!key) throw new TokenError("unknown key id");
    return key;
  }

  private refresh(): Promise<void> {
    this.inFlight ??= this.load().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async load(): Promise<void> {
    // Counted as a fetch even if it fails, so failures are rate limited too.
    this.fetchedAt = this.now();
    let body: unknown;
    try {
      const res = await this.fetcher(this.url, {
        redirect: "error",
        headers: { accept: "application/json" },
      });
      if (!res.ok) throw new Error();
      const text = await res.text();
      if (text.length > MAX_JWKS_BYTES) throw new Error();
      body = JSON.parse(text);
    } catch {
      throw new TokenError("key set unavailable");
    }
    this.keys = await importKeySet(body);
  }
}

/** Import an Okta JWKS: RSA signing keys for RS256 only; a malformed set is refused whole. */
export async function importKeySet(body: unknown): Promise<Map<string, Key>> {
  const list = (body as { keys?: unknown } | null)?.keys;
  if (!Array.isArray(list) || list.length > MAX_KEYS) throw new TokenError("bad key set");
  const keys = new Map<string, Key>();
  for (const jwk of list as unknown[]) {
    if (!jwk || typeof jwk !== "object" || Array.isArray(jwk)) throw new TokenError("bad key set");
    const { kty, kid, use, alg, n, e } = jwk as Record<string, unknown>;
    if (kty !== "RSA") continue;
    if (use !== undefined && use !== "sig") continue;
    if (alg !== undefined && alg !== "RS256") continue;
    if (typeof kid !== "string" || typeof n !== "string" || typeof e !== "string") {
      throw new TokenError("bad key set");
    }
    if (keys.has(kid)) throw new TokenError("duplicate key id");
    let key: Key;
    try {
      key = await crypto.subtle.importKey(
        "jwk",
        { kty: "RSA", n, e, alg: "RS256", ext: true },
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"],
      );
    } catch {
      throw new TokenError("bad key set");
    }
    const bits = (key.algorithm as { modulusLength?: number }).modulusLength ?? 0;
    if (bits < MIN_RSA_BITS) continue;
    keys.set(kid, key);
  }
  return keys;
}

// ---------------------------------------------------------------- grants

export interface OktaGrantVerifierConfig {
  /** The resource's authorization server. */
  issuer: string;
  /** Its audience: the resource server this verifier stands for. */
  audience: string;
  /** The agent app's Okta client id, expected as `act.sub` and `cid`. */
  agentClientId: string;
  keys: KeySet;
  replay: ReplayCache;
  /** The longest grant lifetime accepted, in seconds (set to the access policy's value). */
  maxLifetimeSeconds: number;
  now?: () => number;
}

/**
 * A resource server's check of an Okta-exchanged token: its issuer and audience, RS256 by
 * `kid`, the requester as `sub` (a directory email), the agent as the only actor (`act.sub`
 * and `cid`, no further `act` chain), exactly the one scope this call needs, short-lived,
 * and each `jti` once.
 */
export class OktaGrantVerifier {
  readonly audience: string;
  private readonly config: Required<OktaGrantVerifierConfig>;

  constructor(config: OktaGrantVerifierConfig) {
    this.audience = config.audience;
    this.config = { now: () => Math.floor(Date.now() / 1000), ...config };
  }

  /** `ticketId` is bound by the harness, not the token (see the module comment). */
  async verify(token: unknown, scope: string, ticketId: string): Promise<Grant> {
    const { issuer, audience, agentClientId, keys, replay, maxLifetimeSeconds, now } = this.config;
    if (typeof token !== "string" || !token) throw new TokenError("no grant");
    const { payload } = await verifyJwsWithKeySet(token, keys, "RS256");
    const claims = parseClaims(payload);
    requireClaims(claims, ["iss", "sub", "aud", "exp", "iat", "jti", "act", "cid", "scp"]);
    if (claims.iss !== issuer) throw new TokenError("wrong issuer");
    if (claims.aud !== audience) throw new TokenError("wrong audience");
    if (typeof claims.sub !== "string" || !EMAIL_PATTERN.test(claims.sub)) {
      throw new TokenError("subject is not a directory email");
    }
    const act = claims.act as Record<string, unknown> | null;
    if (!act || typeof act !== "object" || Array.isArray(act) || act.sub !== agentClientId) {
      throw new TokenError("not acting for the agent");
    }
    if ("act" in act) throw new TokenError("more than one actor");
    if (claims.cid !== agentClientId) throw new TokenError("not issued to the agent");
    const scp = claims.scp;
    if (!Array.isArray(scp) || scp.length !== 1 || scp[0] !== scope) {
      throw new TokenError("wrong scope");
    }
    if (typeof claims.jti !== "string" || !claims.jti) throw new TokenError("bad jti");
    const t = now();
    checkTimes(claims, t, maxLifetimeSeconds);
    replay.use(claims.jti, claims.exp as number, t);
    return { sub: claims.sub, act: agentClientId, aud: audience, scope, ticketId, jti: claims.jti };
  }
}
