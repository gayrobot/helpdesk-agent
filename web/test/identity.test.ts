// Identity phase I1: the dev issuer, the verifier and an unforgeable Principal. Every
// rejection here is an attack on the verifier; each must fail closed.
import assert from "node:assert/strict";
import {
  createPublicKey,
  generateKeyPairSync,
  sign as nodeSign,
  verify as nodeVerify,
} from "node:crypto";
import { test } from "node:test";

import {
  AGENT_AUDIENCE,
  b64urlDecode,
  b64urlEncode,
  DEV_ISSUER,
  DevIssuer,
  type KeyPair,
  Principal,
  SUBJECT_TOKEN_SECONDS,
  signJws,
  TokenError,
  TokenVerifier,
  verifyJwsSignature,
} from "../src/identity.ts";

const NOW = 1_795_000_000;
const now = () => NOW;
const JAMIE = "jamie@example.test";
const enc = new TextEncoder();

async function keyPair() {
  return (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as KeyPair;
}

function claims(overrides: Record<string, unknown> = {}) {
  return {
    iss: DEV_ISSUER,
    sub: JAMIE,
    aud: AGENT_AUDIENCE,
    iat: NOW,
    exp: NOW + 900,
    jti: "jti-1",
    ...overrides,
  };
}

async function setup() {
  const keys = await keyPair();
  const verifier = new TokenVerifier({
    issuer: DEV_ISSUER,
    audience: AGENT_AUDIENCE,
    algorithm: "ES256",
    key: keys.publicKey,
    now,
  });
  const make = (c: Record<string, unknown>, header: Record<string, unknown> = { typ: "JWT" }) =>
    signJws(header, c, keys.privateKey, "ES256");
  return { keys, verifier, make };
}

// ---------------------------------------------------------------- the happy path

test("a minted token verifies to a principal for that user", async () => {
  const issuer = new DevIssuer({ now });
  const token = await issuer.mint(JAMIE);
  const principal = await (await issuer.verifier()).verify(token);
  assert.ok(Principal.is(principal));
  assert.equal(principal.sub, JAMIE);
  assert.equal(principal.issuer, DEV_ISSUER);
  const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(token.split(".")[1] as string)));
  assert.equal(payload.exp - payload.iat, SUBJECT_TOKEN_SECONDS);
  assert.equal(payload.aud, AGENT_AUDIENCE);
});

test("each issuer has its own key: another issuer's token is refused", async () => {
  const a = new DevIssuer({ now });
  const b = new DevIssuer({ now });
  await assert.rejects((await b.verifier()).verify(await a.mint(JAMIE)), /bad signature/);
});

test("the dev issuer refuses to start alongside a real issuer", () => {
  assert.throws(
    () => new DevIssuer({ realIssuer: "https://larkspur.okta.test" }),
    /refuses to start/,
  );
});

test("the dev issuer mints only for directory-shaped emails", async () => {
  const issuer = new DevIssuer({ now });
  for (const bad of ["Jamie@example.test", "jamie@example.com", "", "jamie@example.test\n"]) {
    await assert.rejects(issuer.mint(bad), TokenError, JSON.stringify(bad));
  }
});

// ---------------------------------------------------------------- Principal can't be forged

test("a Principal can't be built, copied or faked", async () => {
  const real = await new DevIssuer({ now }).principalFor(JAMIE);
  const forgeries: unknown[] = [
    { sub: JAMIE, issuer: DEV_ISSUER, jti: "x" },
    { ...real },
    structuredClone({ sub: real.sub, issuer: real.issuer, jti: real.jti }),
    JSON.parse(JSON.stringify(real)),
    Object.create(Principal.prototype),
    Object.assign(Object.create(Principal.prototype), { sub: JAMIE }),
    JAMIE,
    null,
    undefined,
  ];
  for (const f of forgeries) assert.equal(Principal.is(f), false, JSON.stringify(f));
  assert.throws(() => new Principal(Symbol("principal-mint"), JAMIE, DEV_ISSUER, "x"), TypeError);
  assert.ok(Object.isFrozen(real));
  assert.throws(() => {
    (real as unknown as { sub: string }).sub = "sam.whitfield@example.test";
  }, TypeError);
});

test("structuredClone of a Principal is not a Principal", async () => {
  const real = await new DevIssuer({ now }).principalFor(JAMIE);
  let copy: unknown;
  try {
    copy = structuredClone(real);
  } catch {
    copy = null; // some runtimes refuse to clone class instances with private fields
  }
  assert.equal(Principal.is(copy), false);
});

// ---------------------------------------------------------------- the verifier refuses

test("header and encoding attacks are refused", async () => {
  const { verifier, make, keys } = await setup();
  const good = await make(claims());
  const [h, p, s] = good.split(".") as [string, string, string];
  const json = (o: unknown) => b64urlEncode(enc.encode(JSON.stringify(o)));
  const cases: [string, string][] = [
    ["two segments", `${h}.${p}`],
    ["four segments", `${good}.x`],
    ["alg none", `${json({ alg: "none" })}.${p}.`],
    ["alg none, signature kept", `${json({ alg: "none" })}.${p}.${s}`],
    ["alg HS256", `${json({ alg: "HS256" })}.${p}.${s}`],
    ["alg ES384", `${json({ alg: "ES384" })}.${p}.${s}`],
    ["padded segment", `${h}=.${p}.${s}`],
    ["standard base64 chars", `${h.replace(/-/g, "+")}+.${p}.${s}`],
    ["empty signature", `${h}.${p}.`],
    ["edited payload", `${h}.${json(claims({ sub: "sam.whitfield@example.test" }))}.${s}`],
    ["not json header", `${b64urlEncode(enc.encode("not json"))}.${p}.${s}`],
    ["array header", `${json([1])}.${p}.${s}`],
  ];
  for (const field of ["jwk", "jku", "x5u", "x5c", "crit"]) {
    cases.push([
      `${field} header`,
      await make(claims(), { [field]: field === "crit" ? ["exp"] : "x" }),
    ]);
  }
  // HS256 with the public key as the HMAC secret: the classic algorithm-confusion forgery.
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", keys.publicKey));
  const hmac = await crypto.subtle.importKey(
    "raw",
    spki,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const hsInput = `${json({ alg: "HS256", typ: "JWT" })}.${p}`;
  const hsSig = new Uint8Array(await crypto.subtle.sign("HMAC", hmac, enc.encode(hsInput)));
  cases.push(["HS256 signed with the public key", `${hsInput}.${b64urlEncode(hsSig)}`]);
  // A genuine ES256 signature over a header that names another algorithm: only the
  // algorithm check can refuse this one.
  const otherAlg = `${json({ alg: "ES384", typ: "JWT" })}.${p}`;
  const otherSig = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      keys.privateKey,
      enc.encode(otherAlg),
    ),
  );
  cases.push(["validly signed, header says ES384", `${otherAlg}.${b64urlEncode(otherSig)}`]);
  for (const [name, token] of cases) {
    await assert.rejects(verifier.verify(token), TokenError, name);
  }
});

test("claim attacks are refused", async () => {
  const { verifier, make } = await setup();
  const cases: [string, Record<string, unknown>][] = [
    ["wrong issuer", claims({ iss: "https://evil.example" })],
    ["wrong audience", claims({ aud: "larkspur-directory" })],
    ["audience as an array", claims({ aud: [AGENT_AUDIENCE] })],
    ["expired", claims({ iat: NOW - 1000, exp: NOW - 100 })],
    ["issued in the future", claims({ iat: NOW + 600, exp: NOW + 1500 })],
    ["not yet valid", claims({ nbf: NOW + 600 })],
    ["exp not an integer", claims({ exp: NOW + 900.5 })],
    ["exp as a string", claims({ exp: String(NOW + 900) })],
    ["nbf as a string", claims({ nbf: String(NOW) })],
    ["subject not an email", claims({ sub: "Jamie" })],
    ["subject on another domain", claims({ sub: "jamie@example.com" })],
    ["subject with a newline", claims({ sub: `${JAMIE}\n` })],
    ["empty jti", claims({ jti: "" })],
  ];
  for (const name of ["iss", "sub", "aud", "exp", "iat", "jti"]) {
    const c: Record<string, unknown> = claims();
    delete c[name];
    cases.push([`missing ${name}`, c]);
  }
  for (const [name, c] of cases) {
    await assert.rejects(verifier.verify(await make(c)), TokenError, name);
  }
  // Clock skew: 30 seconds either side is tolerated, more is not.
  await verifier.verify(await make(claims({ iat: NOW + 20 })));
  await verifier.verify(await make(claims({ exp: NOW - 20 })));
});

test("a non-string token is refused", async () => {
  const { verifier } = await setup();
  for (const t of [null, undefined, 42, {}, ["a.b.c"]]) {
    await assert.rejects(verifier.verify(t as unknown as string), TokenError);
  }
});

// ---------------------------------------------------------------- independent oracles

test("RFC 7515 appendix A.3: the published ES256 example verifies", async () => {
  // Public key and token from RFC 7515 A.3.1. Only x and y are used; if any value were
  // wrong, verification would fail rather than pass by accident.
  const key = await crypto.subtle.importKey(
    "jwk",
    {
      kty: "EC",
      crv: "P-256",
      x: "f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU",
      y: "x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0",
    },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  const token =
    "eyJhbGciOiJFUzI1NiJ9." +
    "eyJpc3MiOiJqb2UiLA0KICJleHAiOjEzMDA4MTkzODAsDQogImh0dHA6Ly9leGFtcGxlLmNvbS9pc19yb290Ijp0cnVlfQ." +
    "DtEhU3ljbEg8L38VWAfUAqOyKAM6-Xx-F4GawxaepmXFCgfTjDxw5djxLa8ISlSApmWQxfKTUJqPP3-Kg6NU1Q";
  const { payload } = await verifyJwsSignature(token, key, "ES256");
  assert.ok(new TextDecoder().decode(payload).includes('"iss":"joe"'));
  // One flipped character in the signature and it fails.
  const tampered = `${token.slice(0, -2)}${token.endsWith("Q") ? "R" : "Q"}${token.slice(-1)}`;
  await assert.rejects(verifyJwsSignature(tampered, key, "ES256"), TokenError);
});

test("cross-checked with node:crypto in both directions", async () => {
  // node:crypto signs, our verifier checks; our signer signs, node:crypto checks.
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const webKey = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  const h = b64urlEncode(enc.encode(JSON.stringify({ alg: "ES256", typ: "JWT" })));
  const p = b64urlEncode(enc.encode(JSON.stringify(claims())));
  const sig = nodeSign("sha256", enc.encode(`${h}.${p}`), {
    key: privateKey,
    dsaEncoding: "ieee-p1363",
  });
  const verifier = new TokenVerifier({
    issuer: DEV_ISSUER,
    audience: AGENT_AUDIENCE,
    algorithm: "ES256",
    key: webKey,
    now,
  });
  assert.equal((await verifier.verify(`${h}.${p}.${b64urlEncode(sig)}`)).sub, JAMIE);

  const ours = await keyPair();
  const token = await signJws({ typ: "JWT" }, claims(), ours.privateKey, "ES256");
  const [th, tp, ts] = token.split(".") as [string, string, string];
  const exported = await crypto.subtle.exportKey("jwk", ours.publicKey);
  const nodeKey = createPublicKey({ key: exported as never, format: "jwk" });
  assert.ok(
    nodeVerify(
      "sha256",
      enc.encode(`${th}.${tp}`),
      { key: nodeKey, dsaEncoding: "ieee-p1363" },
      b64urlDecode(ts),
    ),
  );
});

test("base64url: canonical round trip, strict decoding", () => {
  for (let n = 0; n < 40; n++) {
    const bytes = crypto.getRandomValues(new Uint8Array(n));
    assert.deepEqual(b64urlDecode(b64urlEncode(bytes)), bytes);
  }
  for (const bad of ["a", "ab=", "a+b", "a/b", "ab c", "abc==", "AB"]) {
    // "AB" decodes to one byte with stray low bits set: non-canonical.
    assert.throws(() => b64urlDecode(bad), TokenError, bad);
  }
});
