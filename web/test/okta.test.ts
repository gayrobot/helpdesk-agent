// Identity phase I5, key-free: Okta-shaped tokens against the Okta verifiers. Keys are
// generated here at run time; the JWKS endpoint is a fake fetch. Every rejection is an
// attack and must fail closed.
import assert from "node:assert/strict";
import { createHmac, sign as nodeSign } from "node:crypto";
import { test } from "node:test";
import { TOOL_GRANTS, toolGrant } from "../src/delegation.ts";
import {
  b64urlEncode,
  DevIssuer,
  type Key,
  type KeyPair,
  OktaSubjectVerifier,
  Principal,
  ReplayCache,
  signJws,
  TokenError,
  verifyJwsSignature,
} from "../src/identity.ts";
import {
  importKeySet,
  JwksKeySet,
  jwksUri,
  OktaGrantVerifier,
  OktaResources,
  oktaIssuer,
} from "../src/okta.ts";

const NOW = 1_795_000_000;
const ISSUER = "https://savory-air-test.okta.com/oauth2/aus000000000test";
const AUDIENCE = "api://savory-air-helpdesk";
const SIGN_IN_APP = "0oasignin0000test";
const AGENT_APP = "0oaagent00000test";
const JAMIE = "jamie@example.test";
const enc = new TextEncoder();
const json = (v: unknown) => b64urlEncode(enc.encode(JSON.stringify(v)));

async function rsaKeys(bits = 2048): Promise<KeyPair> {
  return (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: bits,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as KeyPair;
}

async function jwk(key: Key, kid: string) {
  const { kty, n, e } = (await crypto.subtle.exportKey("jwk", key)) as Record<string, string>;
  return { kty, n, e, kid, alg: "RS256", use: "sig" };
}

function fakeFetch(sets: () => unknown) {
  const calls: string[] = [];
  const f = (async (url: string) => {
    calls.push(String(url));
    return new Response(JSON.stringify(sets()), { status: 200 });
  }) as unknown as typeof fetch;
  return { f, calls };
}

async function setup() {
  const keys = await rsaKeys();
  let set: unknown = { keys: [await jwk(keys.publicKey, "k1")] };
  const clock = { t: NOW };
  const fetcher = fakeFetch(() => set);
  const keySet = new JwksKeySet({ issuer: ISSUER, fetch: fetcher.f, now: () => clock.t });
  const subject = new OktaSubjectVerifier({
    issuer: ISSUER,
    audience: AUDIENCE,
    clientId: SIGN_IN_APP,
    keys: keySet,
    maxLifetimeSeconds: 3600,
    now: () => clock.t,
  });
  const replay = new ReplayCache();
  const grants = new OktaGrantVerifier({
    issuer: ISSUER,
    audience: AUDIENCE,
    agentClientId: AGENT_APP,
    keys: keySet,
    replay,
    maxLifetimeSeconds: 300,
    now: () => clock.t,
  });
  const sign = (c: Record<string, unknown>, header: Record<string, unknown> = { kid: "k1" }) =>
    signJws(header, c, keys.privateKey, "RS256");
  return {
    keys,
    clock,
    fetcher,
    subject,
    grants,
    sign,
    setKeys: (s: unknown) => {
      set = s;
    },
  };
}

const subjectClaims = (o: Record<string, unknown> = {}) => ({
  ver: 1,
  iss: ISSUER,
  aud: AUDIENCE,
  sub: JAMIE,
  uid: "00ujamie000test",
  cid: SIGN_IN_APP,
  scp: ["openid"],
  iat: NOW,
  exp: NOW + 3600,
  jti: "AT.subject-1",
  ...o,
});

const grantClaims = (o: Record<string, unknown> = {}) => ({
  ver: 1,
  iss: ISSUER,
  aud: AUDIENCE,
  sub: JAMIE,
  uid: "00ujamie000test",
  cid: AGENT_APP,
  act: { sub: AGENT_APP, sub_profile: "service" },
  scp: ["directory:read"],
  iat: NOW,
  exp: NOW + 300,
  jti: "AT.grant-1",
  ...o,
});

async function rejects(p: Promise<unknown>, label: string) {
  await assert.rejects(p, TokenError, label);
}

// ---------------------------------------------------------------- configuration

test("issuer must be an Okta custom authorization server over https", () => {
  assert.equal(oktaIssuer(ISSUER), ISSUER);
  assert.equal(jwksUri(ISSUER), `${ISSUER}/v1/keys`);
  for (const bad of [
    "http://savory-air-test.okta.com/oauth2/aus1",
    "https://savory-air-test.okta.com",
    "https://evil.test/oauth2/aus1",
    "https://savory-air-test.okta.com.evil.test/oauth2/aus1",
    "https://savory-air-test.okta.com/oauth2/aus1/",
    "urn:savory-air:dev-issuer",
  ]) {
    assert.throws(() => oktaIssuer(bad), Error, bad);
  }
});

// ---------------------------------------------------------------- RS256

test("RS256 cross-checks with node:crypto", async () => {
  const keys = await rsaKeys();
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", keys.privateKey));
  const input = `${json({ alg: "RS256", kid: "k1" })}.${json({ a: 1 })}`;
  const sig = nodeSign("sha256", enc.encode(input), {
    key: Buffer.from(pkcs8),
    format: "der",
    type: "pkcs8",
  });
  const ok = await verifyJwsSignature(`${input}.${b64urlEncode(sig)}`, keys.publicKey, "RS256");
  assert.deepEqual(JSON.parse(new TextDecoder().decode(ok.payload)), { a: 1 });
});

test("an ES256-configured verifier refuses an RSA key and vice versa", async () => {
  const rsa = await rsaKeys();
  const token = await signJws({}, { a: 1 }, rsa.privateKey, "RS256");
  await rejects(verifyJwsSignature(token, rsa.publicKey, "ES256"), "RSA key as ES256");
  const ec = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as KeyPair;
  const ecToken = await signJws({}, { a: 1 }, ec.privateKey, "ES256");
  await rejects(verifyJwsSignature(ecToken, ec.publicKey, "RS256"), "EC key as RS256");
});

// ---------------------------------------------------------------- subject tokens

test("a valid Okta sign-in token gives a principal", async () => {
  const { subject, sign } = await setup();
  const p = await subject.verify(await sign(subjectClaims()));
  assert.ok(Principal.is(p));
  assert.equal(p.sub, JAMIE);
  assert.equal(p.issuer, ISSUER);
  assert.equal(p.jti, "AT.subject-1");
});

test("subject token attacks fail closed", async () => {
  const { subject, sign, keys } = await setup();
  const good = await sign(subjectClaims());
  const [h, p] = good.split(".") as [string, string];
  const other = await rsaKeys();
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", keys.publicKey));
  const hsInput = `${json({ alg: "HS256", kid: "k1" })}.${p}`;
  const hs = createHmac("sha256", Buffer.from(spki)).update(hsInput).digest();
  const cases: [string, Promise<string> | string][] = [
    ["wrong issuer", sign(subjectClaims({ iss: "https://other.okta.com/oauth2/aus1" }))],
    ["wrong audience", sign(subjectClaims({ aud: "api://other" }))],
    ["audience as an array", sign(subjectClaims({ aud: [AUDIENCE] }))],
    ["another app's token", sign(subjectClaims({ cid: "0oaother" }))],
    ["no cid", sign({ ...subjectClaims(), cid: undefined })],
    ["a delegated token as sign-in", sign(grantClaims({ cid: SIGN_IN_APP }))],
    ["sub is an Okta user id", sign(subjectClaims({ sub: "00ujamie000test" }))],
    [
      "sub is an admin login outside the directory",
      sign(subjectClaims({ sub: "admin@okta.test" })),
    ],
    ["expired", sign(subjectClaims({ iat: NOW - 7200, exp: NOW - 3600 }))],
    ["issued in the future", sign(subjectClaims({ iat: NOW + 600, exp: NOW + 4200 }))],
    ["not yet valid", sign(subjectClaims({ nbf: NOW + 600 }))],
    ["lives too long", sign(subjectClaims({ exp: NOW + 86_400 }))],
    ["no kid", sign(subjectClaims(), {})],
    ["unknown kid", sign(subjectClaims(), { kid: "k9" })],
    ["key-pointing header", sign(subjectClaims(), { kid: "k1", jku: "https://evil.test/keys" })],
    ["signed by another key", signJws({ kid: "k1" }, subjectClaims(), other.privateKey, "RS256")],
    ["alg none", `${json({ alg: "none", kid: "k1" })}.${p}.`],
    ["HS256 signed with the public key", `${hsInput}.${b64urlEncode(hs)}`],
    [
      "edited payload",
      `${h}.${json(subjectClaims({ sub: "morgan.hale@example.test" }))}.${good.split(".")[2]}`,
    ],
  ];
  for (const [label, token] of cases) {
    await rejects(subject.verify(await token), label);
  }
});

// ---------------------------------------------------------------- grants

test("a valid Okta-exchanged grant verifies once", async () => {
  const { grants, sign } = await setup();
  const token = await sign(grantClaims());
  const g = await grants.verify(token, "directory:read", "T-1");
  assert.deepEqual(g, {
    sub: JAMIE,
    act: AGENT_APP,
    aud: AUDIENCE,
    scope: "directory:read",
    ticketId: "T-1",
    jti: "AT.grant-1",
  });
  await rejects(grants.verify(token, "directory:read", "T-1"), "replay");
  await rejects(grants.verify(token, "directory:read", "T-2"), "replay into another ticket");
});

test("grant attacks fail closed", async () => {
  const { grants, sign } = await setup();
  let n = 0;
  const g = (o: Record<string, unknown>) => sign(grantClaims({ jti: `AT.g${n++}`, ...o }));
  const cases: [string, Promise<string> | string | undefined, string?][] = [
    ["missing", undefined],
    ["empty", ""],
    ["read scope used for a write", g({}), "directory:mfa.reset"],
    ["two scopes", g({ scp: ["directory:read", "directory:mfa.reset"] }), "directory:mfa.reset"],
    ["scope as a string", g({ scp: "directory:read" })],
    ["no act", sign({ ...grantClaims({ jti: "AT.noact" }), act: undefined })],
    ["act is another client", g({ act: { sub: "0oaother" } })],
    ["act is a string", g({ act: AGENT_APP })],
    ["a chain of actors", g({ act: { sub: AGENT_APP, act: { sub: "0oaother" } } })],
    ["cid is another client", g({ cid: "0oaother" })],
    ["subject token at a tool", sign(subjectClaims({ jti: "AT.s2" }))],
    ["wrong audience", g({ aud: "api://savory-air-tickets" })],
    ["wrong issuer", g({ iss: "https://other.okta.com/oauth2/aus1" })],
    ["sub not a directory email", g({ sub: "00ujamie000test" })],
    ["expired", g({ iat: NOW - 900, exp: NOW - 600 })],
    ["lives too long", g({ exp: NOW + 3600 })],
    ["unknown kid", sign(grantClaims({ jti: "AT.kid" }), { kid: "nope" })],
  ];
  for (const [label, token, scope] of cases) {
    await rejects(
      grants.verify(
        token === undefined ? undefined : await token,
        scope ?? "directory:read",
        "T-1",
      ),
      label,
    );
  }
});

// ---------------------------------------------------------------- JWKS

test("unknown kids refetch at most once per minute; rotation is picked up", async () => {
  const { subject, sign, fetcher, clock, setKeys } = await setup();
  await subject.verify(await sign(subjectClaims()));
  assert.equal(fetcher.calls.length, 1);
  assert.equal(fetcher.calls[0], `${ISSUER}/v1/keys`);

  // Okta rotates: a new key k2 appears.
  const k2 = await rsaKeys();
  setKeys({ keys: [await jwk(k2.publicKey, "k2")] });
  const rotated = await signJws(
    { kid: "k2" },
    subjectClaims({ jti: "AT.r" }),
    k2.privateKey,
    "RS256",
  );
  for (let i = 0; i < 5; i++) await rejects(subject.verify(rotated), "inside the refresh window");
  assert.equal(fetcher.calls.length, 1, "forged kids don't cause fetches");

  clock.t += 61;
  const p = await subject.verify(
    await signJws(
      { kid: "k2" },
      subjectClaims({ iat: clock.t, exp: clock.t + 600 }),
      k2.privateKey,
      "RS256",
    ),
  );
  assert.equal(p.sub, JAMIE);
  assert.equal(fetcher.calls.length, 2);
});

test("key sets: weak, wrong-type and malformed keys", async () => {
  const strong = await rsaKeys();
  const weak = await rsaKeys(1024);
  const ok = await importKeySet({
    keys: [
      await jwk(strong.publicKey, "good"),
      await jwk(weak.publicKey, "weak"),
      { ...(await jwk(strong.publicKey, "enc")), use: "enc" },
      { ...(await jwk(strong.publicKey, "ps")), alg: "PS256" },
      { kty: "EC", kid: "ec", crv: "P-256", x: "AA", y: "AA" },
    ],
  });
  assert.deepEqual([...ok.keys()], ["good"]);
  for (const bad of [
    null,
    {},
    { keys: "x" },
    { keys: [null] },
    { keys: [{ kty: "RSA", kid: "a", n: 1, e: "AQAB" }] },
    { keys: [await jwk(strong.publicKey, "d"), await jwk(strong.publicKey, "d")] },
  ]) {
    await rejects(importKeySet(bad), JSON.stringify(bad)?.slice(0, 40) ?? "null");
  }
});

test("an unreachable key set fails closed", async () => {
  const f = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
  const keys = new JwksKeySet({ issuer: ISSUER, fetch: f, now: () => NOW });
  await rejects(keys.key("k1"), "500");
  const thrower = (async () => {
    throw new Error("network");
  }) as unknown as typeof fetch;
  await rejects(new JwksKeySet({ issuer: ISSUER, fetch: thrower }).key("k1"), "network");
});

// ---------------------------------------------------------------- one audience, every tool

test("one Okta audience serves every tool; scopes alone keep the resources apart", async () => {
  const { grants, sign } = await setup();
  const resources = new OktaResources(grants);
  const tools = Object.keys(TOOL_GRANTS);
  assert.deepEqual(
    [...new Set(tools.map((t) => toolGrant(t).scope))].sort(),
    OktaResources.scopes().sort(),
    "the authorization server offers exactly the tools' scopes",
  );
  let n = 0;
  for (const tool of tools) {
    for (const other of tools) {
      const token = await sign(grantClaims({ scp: [toolGrant(other).scope], jti: `AT.${n++}` }));
      const needed = toolGrant(tool);
      const check = resources.get(needed.audience).verify(token, needed.scope, "T-1");
      if (toolGrant(other).scope === needed.scope) {
        assert.equal((await check).scope, needed.scope, tool);
      } else {
        await rejects(check, `${other}'s grant at ${tool}`);
      }
    }
  }
  assert.throws(() => resources.get("api://savory-air-helpdesk"), TokenError, "not a resource");
  assert.throws(() => resources.get("__proto__"), TokenError);
});

// ---------------------------------------------------------------- one issuer per session

test("a dev-issuer session never accepts an Okta sign-in, nor Okta a dev one", async () => {
  const { subject, sign, clock } = await setup();
  const dev = new DevIssuer({ now: () => clock.t });
  const okta = await sign(subjectClaims());
  await rejects((await dev.verifier()).verify(okta), "Okta token at the dev issuer");
  await rejects(subject.verify(await dev.mint(JAMIE)), "dev token at the Okta verifier");
});
