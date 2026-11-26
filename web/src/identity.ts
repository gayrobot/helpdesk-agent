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
 * Tokens never go to the model, the logs, the page or storage. A principal lives for one
 * run and is never stored; a restarted session rebuilds nothing from a stored email.
 */
import { EMAIL_PATTERN } from "./governance.ts";

export const DEV_ISSUER = "urn:larkspur:dev-issuer";
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

// ---------------------------------------------------------------- dev issuer

export interface DevIssuerOptions {
  /** A real issuer's URL, if one is configured. The dev issuer refuses to run alongside one. */
  realIssuer?: string | undefined;
  now?: () => number;
}

/**
 * Mints subject tokens for synthetic directory users. Its signing key is generated in
 * memory on first use and never leaves this object.
 */
export class DevIssuer {
  private readonly now: () => number;
  private keys: Promise<KeyPair> | null = null;

  constructor(options: DevIssuerOptions = {}) {
    if (options.realIssuer) {
      throw new Error("the dev issuer refuses to start while a real issuer is configured");
    }
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
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
    const jti = b64urlEncode(crypto.getRandomValues(new Uint8Array(16)));
    const claims = {
      iss: DEV_ISSUER,
      sub: email,
      aud: AGENT_AUDIENCE,
      iat,
      exp: iat + SUBJECT_TOKEN_SECONDS,
      jti,
    };
    return signJws({ typ: "JWT" }, claims, (await this.keyPair()).privateKey, "ES256");
  }

  /** The verifier for this issuer's tokens. */
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
}
