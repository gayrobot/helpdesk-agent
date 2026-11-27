/**
 * Who is asking (identity phase I1, docs/identity-plan.md). Built on Web Crypto only: no
 * JOSE library (docs/dependency-reviews/web-crypto-jws.md).
 *
 * - `Principal`: a verified requester. The only way to get one is `TokenVerifier.verify`
 *   on a signed token; `Gate` refuses anything else. It cannot be built from a string, a
 *   look-alike object, a copy or a JSON round trip.
 * - `DevIssuer`: mints subject tokens for synthetic users, with an ES256 key that exists
 *   only in memory. It makes `jamie@example.test` an assertion exactly as before (anyone
 *   can ask it for a token); what I1 proves is the enforcement side: nothing downstream
 *   acts without a valid token. Okta replaces it for real sign-in (I5).
 * - `TokenVerifier`: one issuer, one audience, one algorithm, one key, all fixed by
 *   configuration and never taken from the token. Strict about the encoding and every
 *   claim.
 *
 * Identity phase I2 adds delegated tokens: the agent is its own identity (`AgentIdentity`,
 * a key in memory) and, for every tool call, exchanges the requester's subject token plus
 * its own signed client assertion for a 60-second token naming one audience and one scope
 * (the RFC 8693 shape). `GrantVerifier` is the resource side: it accepts only such tokens,
 * each `jti` once. The harness holds the tokens in a `SignIn`; the gate asks it for a grant
 * per call and the tool's handler refuses to run without one (`delegation.ts`).
 *
 * Tokens never go to the model, the logs, the page or storage. A principal lives for one
 * run and is never stored; a restarted session rebuilds nothing from a stored email.
 */
import { EMAIL_PATTERN } from "./governance.ts";

export const DEV_ISSUER = "urn:savory-air:dev-issuer";
export const AGENT_AUDIENCE = "helpdesk-agent";
export const SUBJECT_TOKEN_SECONDS = 15 * 60;
const MAX_CLOCK_SKEW_SECONDS = 30;
const ALGORITHMS = { ES256: { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256", bytes: 64 } };
export type Algorithm = keyof typeof ALGORITHMS;

/** Web Crypto key types, named here so the code compiles under Node and Workers types. */
export type Key = Awaited<ReturnType<typeof crypto.subtle.importKey>>;
export interface KeyPair {
  privateKey: Key;
  publicKey: Key;
}

export class TokenError extends Error {
  override name = "TokenError";
}

// ---------------------------------------------------------------- base64url

const B64URL = /^[A-Za-z0-9_-]*$/;

export function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Strict: the base64url alphabet only, no padding, no impossible lengths. */
export function b64urlDecode(text: string): Uint8Array {
  if (!B64URL.test(text) || text.length % 4 === 1) throw new TokenError("bad base64url");
  const padded =
    text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  // Reject non-canonical encodings (stray bits in the last character).
  if (b64urlEncode(out) !== text) throw new TokenError("non-canonical base64url");
  return out;
}

const utf8 = new TextEncoder();
const fromUtf8 = (b: Uint8Array) =>
  new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(b);

function decodeJsonSegment(segment: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(fromUtf8(b64urlDecode(segment)));
  } catch (exc) {
    if (exc instanceof TokenError) throw exc;
    throw new TokenError("segment is not JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TokenError("segment is not a JSON object");
  }
  return value as Record<string, unknown>;
}

// ---------------------------------------------------------------- JWS (compact, ES256)

/** Verify a compact JWS signature only (no claim checks). The algorithm comes from the
 * caller, never the header; a header naming anything else is refused. */
export async function verifyJwsSignature(
  token: string,
  key: Key,
  algorithm: Algorithm,
): Promise<{ header: Record<string, unknown>; payload: Uint8Array }> {
  if (typeof token !== "string") throw new TokenError("token is not a string");
  const parts = token.split(".");
  if (parts.length !== 3) throw new TokenError("a JWS has three segments");
  const [h, p, s] = parts as [string, string, string];
  const header = decodeJsonSegment(h);
  if (header.alg !== algorithm) throw new TokenError("algorithm not allowed");
  for (const field of ["jwk", "jku", "x5u", "x5c", "crit"]) {
    if (field in header) throw new TokenError(`header field ${field} not allowed`);
  }
  const signature = b64urlDecode(s);
  const alg = ALGORITHMS[algorithm];
  if (signature.length !== alg.bytes) throw new TokenError("bad signature length");
  const ok = await crypto.subtle.verify(
    { name: alg.name, hash: alg.hash },
    key,
    signature,
    utf8.encode(`${h}.${p}`),
  );
  if (!ok) throw new TokenError("bad signature");
  return { header, payload: b64urlDecode(p) };
}

export async function signJws(
  header: Record<string, unknown>,
  claims: Record<string, unknown>,
  key: Key,
  algorithm: Algorithm,
): Promise<string> {
  const alg = ALGORITHMS[algorithm];
  const h = b64urlEncode(utf8.encode(JSON.stringify({ ...header, alg: algorithm })));
  const p = b64urlEncode(utf8.encode(JSON.stringify(claims)));
  const sig = new Uint8Array(
    await crypto.subtle.sign({ name: alg.name, hash: alg.hash }, key, utf8.encode(`${h}.${p}`)),
  );
  return `${h}.${p}.${b64urlEncode(sig)}`;
}

// ---------------------------------------------------------------- Principal

const MINT = Symbol("principal-mint");

/** A verified requester. Only `TokenVerifier.verify` can make one. */
export class Principal {
  readonly #brand = true;
  readonly sub: string;
  readonly issuer: string;
  /** The token's id, for audit records; never the token itself. */
  readonly jti: string;

  constructor(key: symbol, sub: string, issuer: string, jti: string) {
    if (key !== MINT) throw new TypeError("a Principal comes only from a verified token");
    this.sub = sub;
    this.issuer = issuer;
    this.jti = jti;
    Object.freeze(this);
  }

  /** True only for objects this module constructed. Copies and look-alikes fail. */
  static is(value: unknown): value is Principal {
    return typeof value === "object" && value !== null && #brand in value;
  }

  toJSON() {
    return { sub: this.sub, issuer: this.issuer };
  }
}

// ---------------------------------------------------------------- verifier

export interface VerifierConfig {
  issuer: string;
  audience: string;
  algorithm: Algorithm;
  key: Key;
  /** Seconds since the epoch. Injected so tests control time. */
  now?: () => number;
}

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);

export class TokenVerifier {
  private readonly config: Required<VerifierConfig>;

  constructor(config: VerifierConfig) {
    this.config = { now: () => Math.floor(Date.now() / 1000), ...config };
  }

  /** Verify a subject token and return the principal it names, or throw TokenError. */
  async verify(token: string): Promise<Principal> {
    const { issuer, audience, algorithm, key, now } = this.config;
    const { payload } = await verifyJwsSignature(token, key, algorithm);
    let claims: Record<string, unknown>;
    try {
      const parsed = JSON.parse(fromUtf8(payload));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
      claims = parsed;
    } catch {
      throw new TokenError("claims are not a JSON object");
    }
    for (const name of ["iss", "sub", "aud", "exp", "iat", "jti"]) {
      if (!(name in claims)) throw new TokenError(`missing claim ${name}`);
    }
    if (claims.iss !== issuer) throw new TokenError("wrong issuer");
    if (claims.aud !== audience) throw new TokenError("wrong audience"); // exactly, not an array
    if (typeof claims.sub !== "string" || !EMAIL_PATTERN.test(claims.sub)) {
      throw new TokenError("subject is not a directory email");
    }
    if (typeof claims.jti !== "string" || !claims.jti) throw new TokenError("bad jti");
    if (!isInt(claims.exp) || !isInt(claims.iat))
      throw new TokenError("exp and iat must be integers");
    const t = now();
    if (claims.exp <= t - MAX_CLOCK_SKEW_SECONDS) throw new TokenError("token expired");
    if (claims.iat > t + MAX_CLOCK_SKEW_SECONDS) throw new TokenError("token issued in the future");
    if ("nbf" in claims) {
      if (!isInt(claims.nbf)) throw new TokenError("nbf must be an integer");
      if (claims.nbf > t + MAX_CLOCK_SKEW_SECONDS) throw new TokenError("token not yet valid");
    }
    return new Principal(MINT, claims.sub, issuer, claims.jti);
  }
}

// ---------------------------------------------------------------- delegated tokens (I2)

/** The agent's client id: `act.sub` in every delegated token. */
export const AGENT_CLIENT_ID = "helpdesk-agent";
export const GRANT_SECONDS = 60;
const ASSERTION_SECONDS = 60;
const GRANT_TYPE = "at+jwt"; // RFC 9068, so a subject token can't pass as a grant
const ASSERTION_TYPE = "client-assertion+jwt";

/** Resource servers and the scopes each one accepts (docs/identity-plan.md, Tokens). */
export const RESOURCE_SCOPES: Readonly<Record<string, readonly string[]>> = {
  "savory-air-directory": [
    "directory:read",
    "devices:read",
    "directory:mfa.reset",
    "directory:group.add",
  ],
  "savory-air-runbooks": ["runbooks:read"],
  "savory-air-tickets": ["tickets:escalate"],
};

const randomJti = () => b64urlEncode(crypto.getRandomValues(new Uint8Array(16)));

function parseClaims(payload: Uint8Array): Record<string, unknown> {
  try {
    const parsed = JSON.parse(fromUtf8(payload));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch {
    throw new TokenError("claims are not a JSON object");
  }
}

function requireClaims(claims: Record<string, unknown>, names: string[]) {
  for (const name of names) {
    if (!(name in claims)) throw new TokenError(`missing claim ${name}`);
  }
}

/** exp, iat and nbf checks shared by assertions and grants. */
function checkTimes(claims: Record<string, unknown>, now: number, maxLifetime: number) {
  if (!isInt(claims.exp) || !isInt(claims.iat))
    throw new TokenError("exp and iat must be integers");
  if (claims.exp <= now - MAX_CLOCK_SKEW_SECONDS) throw new TokenError("token expired");
  if (claims.iat > now + MAX_CLOCK_SKEW_SECONDS) throw new TokenError("token issued in the future");
  if (claims.exp - claims.iat > maxLifetime) throw new TokenError("token lives too long");
  if ("nbf" in claims) {
    if (!isInt(claims.nbf)) throw new TokenError("nbf must be an integer");
    if (claims.nbf > now + MAX_CLOCK_SKEW_SECONDS) throw new TokenError("token not yet valid");
  }
}

/** Remembers each `jti` until its token has expired; a second use is refused. */
export class ReplayCache {
  private readonly seen = new Map<string, number>();

  use(jti: string, exp: number, now: number) {
    for (const [id, until] of this.seen) {
      if (until + MAX_CLOCK_SKEW_SECONDS < now) this.seen.delete(id);
    }
    if (this.seen.has(jti)) throw new TokenError("token already used");
    this.seen.set(jti, exp);
  }

  get size() {
    return this.seen.size;
  }
}

/**
 * The agent as its own identity: a client with an ES256 key generated in memory, which
 * signs short client assertions for the token exchange. It never holds a token that can
 * act on its own.
 */
export class AgentIdentity {
  readonly clientId = AGENT_CLIENT_ID;
  private keys: Promise<KeyPair> | null = null;
  private readonly now: () => number;

  constructor(now: () => number = () => Math.floor(Date.now() / 1000)) {
    this.now = now;
  }

  private keyPair(): Promise<KeyPair> {
    this.keys ??= crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
      "sign",
      "verify",
    ]) as Promise<KeyPair>;
    return this.keys;
  }

  /** The public half, which the issuer registers for this client. */
  async publicKey(): Promise<Key> {
    return (await this.keyPair()).publicKey;
  }

  /** A single-use client assertion for `audience` (the issuer's token endpoint). */
  async assertion(audience: string): Promise<string> {
    const iat = this.now();
    return signJws(
      { typ: ASSERTION_TYPE },
      {
        iss: this.clientId,
        sub: this.clientId,
        aud: audience,
        iat,
        exp: iat + ASSERTION_SECONDS,
        jti: randomJti(),
      },
      (await this.keyPair()).privateKey,
      "ES256",
    );
  }
}

/** What a verified delegated token says. No token text is kept. */
export interface Grant {
  readonly sub: string;
  readonly act: string;
  readonly aud: string;
  readonly scope: string;
  readonly ticketId: string;
  readonly jti: string;
}

export interface GrantVerifierConfig {
  issuer: string;
  audience: string;
  key: Key | Promise<Key>;
  replay: ReplayCache;
  now?: () => number;
}

/**
 * A resource server's check of a delegated token: one issuer, one audience, ES256, typed
 * `at+jwt`, acting for the agent, exactly the scope this call needs, for this ticket, at
 * most 60 seconds long, and each `jti` once.
 */
export class GrantVerifier {
  readonly audience: string;
  private readonly config: Required<GrantVerifierConfig>;

  constructor(config: GrantVerifierConfig) {
    this.audience = config.audience;
    this.config = { now: () => Math.floor(Date.now() / 1000), ...config };
  }

  async verify(token: unknown, scope: string, ticketId: string): Promise<Grant> {
    const { issuer, audience, key, replay, now } = this.config;
    if (typeof token !== "string" || !token) throw new TokenError("no grant");
    const { header, payload } = await verifyJwsSignature(token, await key, "ES256");
    if (header.typ !== GRANT_TYPE) throw new TokenError("not a delegated token");
    const claims = parseClaims(payload);
    requireClaims(claims, ["iss", "sub", "aud", "exp", "iat", "jti", "act", "scope", "ticket_id"]);
    if (claims.iss !== issuer) throw new TokenError("wrong issuer");
    if (claims.aud !== audience) throw new TokenError("wrong audience");
    if (typeof claims.sub !== "string" || !EMAIL_PATTERN.test(claims.sub)) {
      throw new TokenError("subject is not a directory email");
    }
    const act = claims.act as Record<string, unknown> | null;
    if (!act || typeof act !== "object" || Array.isArray(act) || act.sub !== AGENT_CLIENT_ID) {
      throw new TokenError("not acting for the agent");
    }
    if (claims.scope !== scope) throw new TokenError("wrong scope");
    if (claims.ticket_id !== ticketId) throw new TokenError("token is for another ticket");
    if (typeof claims.jti !== "string" || !claims.jti) throw new TokenError("bad jti");
    const t = now();
    checkTimes(claims, t, GRANT_SECONDS);
    replay.use(claims.jti, claims.exp as number, t);
    return {
      sub: claims.sub,
      act: AGENT_CLIENT_ID,
      aud: audience,
      scope,
      ticketId,
      jti: claims.jti,
    };
  }
}

/** The resource servers' verifiers, sharing one replay cache. */
export class Resources {
  private readonly verifiers: ReadonlyMap<string, GrantVerifier>;

  constructor(verifiers: GrantVerifier[]) {
    this.verifiers = new Map(verifiers.map((v) => [v.audience, v]));
  }

  get(audience: string): GrantVerifier {
    const v = this.verifiers.get(audience);
    if (!v) throw new TokenError("unknown resource");
    return v;
  }
}

export interface ExchangeRequest {
  subjectToken: string;
  actorToken: string;
  audience: string;
  scope: string;
  ticketId: string;
}

const SIGN_IN = Symbol("sign-in");

/**
 * A signed-in requester as the harness holds it: the verified principal, and privately
 * the subject token, which only ever goes to the issuer's token exchange. The model, the
 * logs and the page see none of it.
 */
export class SignIn {
  readonly #token: string;
  readonly #issuer: DevIssuer;
  readonly #agent: AgentIdentity;
  readonly principal: Principal;

  constructor(
    key: symbol,
    token: string,
    principal: Principal,
    issuer: DevIssuer,
    agent: AgentIdentity,
  ) {
    if (key !== SIGN_IN) throw new TypeError("a SignIn comes only from an issuer");
    this.#token = token;
    this.principal = principal;
    this.#issuer = issuer;
    this.#agent = agent;
    Object.freeze(this);
  }

  static is(value: unknown): value is SignIn {
    return typeof value === "object" && value !== null && #token in value;
  }

  /** The resource servers that accept this issuer's grants. */
  get resources(): Resources {
    return this.#issuer.resources();
  }

  /** A fresh delegated token for one call: one audience, one scope, this ticket. */
  async grant(audience: string, scope: string, ticketId: string): Promise<string> {
    return this.#issuer.exchange({
      subjectToken: this.#token,
      actorToken: await this.#agent.assertion(DEV_ISSUER),
      audience,
      scope,
      ticketId,
    });
  }

  toJSON() {
    return SignIn.is(this) ? this.principal.toJSON() : {};
  }
}

// ---------------------------------------------------------------- dev issuer

export interface DevIssuerOptions {
  /** A real issuer's URL, if one is configured. The dev issuer refuses to run alongside one. */
  realIssuer?: string | undefined;
  now?: () => number;
  /** The one client allowed to exchange tokens. A new in-memory agent by default. */
  agent?: AgentIdentity;
}

const TICKET_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Mints subject tokens for synthetic directory users and runs the token exchange. Its
 * signing key is generated in memory on first use and never leaves this object.
 */
export class DevIssuer {
  private readonly now: () => number;
  private readonly agent: AgentIdentity;
  private keys: Promise<KeyPair> | null = null;
  private resourceSet: Resources | null = null;
  private readonly assertionReplay = new ReplayCache();
  private readonly grantReplay = new ReplayCache();

  constructor(options: DevIssuerOptions = {}) {
    if (options.realIssuer) {
      throw new Error("the dev issuer refuses to start while a real issuer is configured");
    }
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
    this.agent = options.agent ?? new AgentIdentity(this.now);
  }

  private keyPair(): Promise<KeyPair> {
    // Generated lazily, not in a constructor, so it works inside a Durable Object.
    this.keys ??= crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
      "sign",
      "verify",
    ]) as Promise<KeyPair>;
    return this.keys;
  }

  /** A token for `email`, which the caller has checked is a directory user. */
  async mint(email: string): Promise<string> {
    if (!EMAIL_PATTERN.test(email)) throw new TokenError("not a directory email");
    const iat = this.now();
    const claims = {
      iss: DEV_ISSUER,
      sub: email,
      aud: AGENT_AUDIENCE,
      iat,
      exp: iat + SUBJECT_TOKEN_SECONDS,
      jti: randomJti(),
    };
    return signJws({ typ: "JWT" }, claims, (await this.keyPair()).privateKey, "ES256");
  }

  /** The verifier for this issuer's subject tokens. */
  async verifier(now?: () => number): Promise<TokenVerifier> {
    return new TokenVerifier({
      issuer: DEV_ISSUER,
      audience: AGENT_AUDIENCE,
      algorithm: "ES256",
      key: (await this.keyPair()).publicKey,
      now: now ?? this.now,
    });
  }

  /** Mint and verify in one step: the usual way a harness gets a principal. */
  async principalFor(email: string): Promise<Principal> {
    return (await this.verifier()).verify(await this.mint(email));
  }

  /** Sign `email` in: the principal plus the subject token, held for the exchange. */
  async signIn(email: string): Promise<SignIn> {
    const token = await this.mint(email);
    const principal = await (await this.verifier()).verify(token);
    return new SignIn(SIGN_IN, token, principal, this, this.agent);
  }

  /**
   * Token exchange (RFC 8693 shape): a valid subject token plus the registered agent's
   * client assertion buys one delegated token for one audience and one scope, for one
   * ticket, for 60 seconds. Anything else throws TokenError.
   */
  async exchange(request: ExchangeRequest): Promise<string> {
    const { subjectToken, actorToken, audience, scope, ticketId } = request;
    const t = this.now();
    // The agent authenticates itself with its own key.
    const { header, payload } = await verifyJwsSignature(
      actorToken,
      await this.agent.publicKey(),
      "ES256",
    );
    if (header.typ !== ASSERTION_TYPE) throw new TokenError("not a client assertion");
    const assertion = parseClaims(payload);
    requireClaims(assertion, ["iss", "sub", "aud", "exp", "iat", "jti"]);
    if (assertion.iss !== AGENT_CLIENT_ID || assertion.sub !== AGENT_CLIENT_ID) {
      throw new TokenError("unknown client");
    }
    if (assertion.aud !== DEV_ISSUER) throw new TokenError("assertion for another issuer");
    if (typeof assertion.jti !== "string" || !assertion.jti) throw new TokenError("bad jti");
    checkTimes(assertion, t, ASSERTION_SECONDS);
    // The requester's subject token: same checks as at sign-in.
    const principal = await (await this.verifier()).verify(subjectToken);
    const scopes = Object.hasOwn(RESOURCE_SCOPES, audience) ? RESOURCE_SCOPES[audience] : undefined;
    if (!scopes) throw new TokenError("unknown resource");
    if (typeof scope !== "string" || !scopes.includes(scope)) {
      throw new TokenError("scope not offered by that resource");
    }
    if (typeof ticketId !== "string" || !TICKET_ID.test(ticketId)) {
      throw new TokenError("bad ticket id");
    }
    this.assertionReplay.use(assertion.jti, assertion.exp as number, t);
    return signJws(
      { typ: GRANT_TYPE },
      {
        iss: DEV_ISSUER,
        sub: principal.sub,
        act: { sub: AGENT_CLIENT_ID },
        aud: audience,
        scope,
        ticket_id: ticketId,
        iat: t,
        exp: t + GRANT_SECONDS,
        jti: randomJti(),
      },
      (await this.keyPair()).privateKey,
      "ES256",
    );
  }

  /** The resource servers' verifiers for this issuer's grants (one shared replay cache). */
  resources(): Resources {
    this.resourceSet ??= new Resources(
      Object.keys(RESOURCE_SCOPES).map(
        (audience) =>
          new GrantVerifier({
            issuer: DEV_ISSUER,
            audience,
            key: this.keyPair().then((k) => k.publicKey),
            replay: this.grantReplay,
            now: this.now,
          }),
      ),
    );
    return this.resourceSet;
  }
}
