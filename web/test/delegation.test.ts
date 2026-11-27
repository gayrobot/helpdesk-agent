// Identity phase I2: delegated tokens. Every attack in docs/identity-plan.md's token list
// fails closed; the gate audits the grant's id, never a token.
import assert from "node:assert/strict";
import { test } from "node:test";
import { GrantError, runWithGrant, TOOL_GRANTS, toolGrant } from "../src/delegation.ts";
import { Decision } from "../src/governance.ts";
import {
  AGENT_AUDIENCE,
  AGENT_CLIENT_ID,
  AgentIdentity,
  b64urlEncode,
  DEV_ISSUER,
  DevIssuer,
  GRANT_SECONDS,
  GrantVerifier,
  type KeyPair,
  RESOURCE_SCOPES,
  ReplayCache,
  Resources,
  signJws,
  TokenError,
} from "../src/identity.ts";
import { TOOLS, type ToolSpec } from "../src/tools.ts";
import { JAMIE, makeGate, RecordingApprover } from "./helpers.ts";

const DIR = "savory-air-directory";
const TICKET = "T-TEST";
const NOW = 1_800_000_000;
const JWT = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/;

const newKeys = () =>
  crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
    "sign",
    "verify",
  ]) as Promise<KeyPair>;

/** A resource-side verifier with a test key, so tests can sign any token they like. */
async function fixture() {
  const keys = await newKeys();
  const replay = new ReplayCache();
  const verifier = new GrantVerifier({
    issuer: DEV_ISSUER,
    audience: DIR,
    key: keys.publicKey,
    replay,
    now: () => NOW,
  });
  const claims = (over: Record<string, unknown> = {}) => ({
    iss: DEV_ISSUER,
    sub: JAMIE,
    act: { sub: AGENT_CLIENT_ID },
    aud: DIR,
    scope: "directory:read",
    ticket_id: TICKET,
    iat: NOW,
    exp: NOW + GRANT_SECONDS,
    jti: b64urlEncode(crypto.getRandomValues(new Uint8Array(16))),
    ...over,
  });
  const sign = (c: Record<string, unknown>, header: Record<string, unknown> = { typ: "at+jwt" }) =>
    signJws(header, c, keys.privateKey, "ES256");
  return { keys, verifier, replay, claims, sign };
}

test("ts_i2_a_well_formed_grant_verifies_once", async () => {
  const f = await fixture();
  const token = await f.sign(f.claims());
  const grant = await f.verifier.verify(token, "directory:read", TICKET);
  assert.equal(grant.sub, JAMIE);
  assert.equal(grant.act, AGENT_CLIENT_ID);
  await assert.rejects(f.verifier.verify(token, "directory:read", TICKET), /already used/);
});

const strip = (c: Record<string, unknown>, name: string) => {
  const { [name]: _gone, ...rest } = c;
  return rest;
};

const BAD_CLAIMS: [string, (c: Record<string, unknown>) => Record<string, unknown>, RegExp][] = [
  ["expired", (c) => ({ ...c, iat: NOW - 200, exp: NOW - 100 }), /expired/],
  ["not yet valid", (c) => ({ ...c, nbf: NOW + 120 }), /not yet valid/],
  ["issued in the future", (c) => ({ ...c, iat: NOW + 120, exp: NOW + 150 }), /future/],
  ["lives too long", (c) => ({ ...c, exp: NOW + 3600 }), /too long/],
  ["wrong issuer", (c) => ({ ...c, iss: "https://evil.example.test" }), /wrong issuer/],
  ["wrong audience", (c) => ({ ...c, aud: "savory-air-runbooks" }), /wrong audience/],
  ["audience as an array", (c) => ({ ...c, aud: [DIR] }), /wrong audience/],
  ["read scope used for a write", (c) => c, /wrong scope/], // verified for mfa.reset below
  ["two scopes", (c) => ({ ...c, scope: "directory:read directory:mfa.reset" }), /wrong scope/],
  ["no act", (c) => strip(c, "act"), /missing claim act/],
  ["act is not the agent", (c) => ({ ...c, act: { sub: "someone-else" } }), /not acting/],
  ["act is a string", (c) => ({ ...c, act: AGENT_CLIENT_ID }), /not acting/],
  ["another ticket", (c) => ({ ...c, ticket_id: "T-OTHER" }), /another ticket/],
  ["no jti", (c) => strip(c, "jti"), /missing claim jti/],
  ["subject not an email", (c) => ({ ...c, sub: "Jamie@Example.test" }), /directory email/],
];

for (const [name, edit, error] of BAD_CLAIMS) {
  test(`ts_i2_grant_refused[${name}]`, async () => {
    const f = await fixture();
    const scope = name === "read scope used for a write" ? "directory:mfa.reset" : "directory:read";
    const token = await f.sign(edit(f.claims()));
    await assert.rejects(f.verifier.verify(token, scope, TICKET), error);
  });
}

test("ts_i2_grant_refused[missing]", async () => {
  const f = await fixture();
  for (const token of [undefined, null, "", 42]) {
    await assert.rejects(f.verifier.verify(token, "directory:read", TICKET), /no grant/);
  }
});

test("ts_i2_grant_refused[alg none and HS256]", async () => {
  const f = await fixture();
  const body = b64urlEncode(new TextEncoder().encode(JSON.stringify(f.claims())));
  for (const alg of ["none", "HS256", "RS256"]) {
    const head = b64urlEncode(new TextEncoder().encode(JSON.stringify({ alg, typ: "at+jwt" })));
    await assert.rejects(
      f.verifier.verify(`${head}.${body}.`, "directory:read", TICKET),
      /algorithm not allowed/,
    );
  }
});

test("ts_i2_grant_refused[edited payload]", async () => {
  const f = await fixture();
  const [h, , s] = (await f.sign(f.claims())).split(".");
  const edited = b64urlEncode(
    new TextEncoder().encode(JSON.stringify(f.claims({ sub: "morgan.hale@example.test" }))),
  );
  await assert.rejects(
    f.verifier.verify(`${h}.${edited}.${s}`, "directory:read", TICKET),
    /bad signature/,
  );
});

test("ts_i2_grant_refused[signed by another key]", async () => {
  const f = await fixture();
  const other = await newKeys();
  const token = await signJws({ typ: "at+jwt" }, f.claims(), other.privateKey, "ES256");
  await assert.rejects(f.verifier.verify(token, "directory:read", TICKET), /bad signature/);
});

test("ts_i2_grant_refused[subject token presented at a tool]", async () => {
  const f = await fixture();
  // A subject token is typed JWT, names the agent as its audience and has no act.
  const subject = await f.sign(
    { iss: DEV_ISSUER, sub: JAMIE, aud: AGENT_AUDIENCE, iat: NOW, exp: NOW + 900, jti: "s1" },
    { typ: "JWT" },
  );
  await assert.rejects(f.verifier.verify(subject, "directory:read", TICKET), /not a delegated/);
  // Even typed as a grant, it fails on its claims.
  const retyped = await f.sign({
    iss: DEV_ISSUER,
    sub: JAMIE,
    aud: AGENT_AUDIENCE,
    iat: NOW,
    exp: NOW + 900,
    jti: "s2",
  });
  await assert.rejects(f.verifier.verify(retyped, "directory:read", TICKET), /missing claim/);
});

test("ts_i2_replay_cache_forgets_expired_tokens_only", () => {
  const cache = new ReplayCache();
  cache.use("a", NOW + 60, NOW);
  assert.throws(() => cache.use("a", NOW + 60, NOW + 10), /already used/);
  cache.use("b", NOW + 200, NOW + 200); // "a" expired long ago and is dropped
  assert.equal(cache.size, 1);
});

// ---------------------------------------------------------------- the exchange

test("ts_i2_exchange_issues_one_scope_for_one_audience_and_ticket", async () => {
  const issuer = new DevIssuer();
  const signIn = await issuer.signIn(JAMIE);
  const token = await signIn.grant(DIR, "directory:read", TICKET);
  const grant = await signIn.resources.get(DIR).verify(token, "directory:read", TICKET);
  assert.deepEqual(
    { sub: grant.sub, aud: grant.aud, scope: grant.scope, act: grant.act },
    { sub: JAMIE, aud: DIR, scope: "directory:read", act: AGENT_CLIENT_ID },
  );
  // The same grant at another resource, for another scope or ticket: refused.
  const again = await signIn.grant(DIR, "directory:read", TICKET);
  await assert.rejects(
    signIn.resources.get("savory-air-tickets").verify(again, "tickets:escalate", TICKET),
    /wrong audience/,
  );
});

test("ts_i2_exchange_refuses_scopes_a_resource_does_not_offer", async () => {
  const signIn = await new DevIssuer().signIn(JAMIE);
  await assert.rejects(signIn.grant("savory-air-runbooks", "directory:read", TICKET), /scope not/);
  await assert.rejects(signIn.grant("savory-air-hr", "hr:read", TICKET), /unknown resource/);
  await assert.rejects(signIn.grant(DIR, "directory:*", TICKET), /scope not/);
  await assert.rejects(signIn.grant(DIR, "directory:read", "T 1\n"), /bad ticket id/);
  await assert.rejects(signIn.grant("__proto__", "x", TICKET), /unknown resource/);
});

test("ts_i2_exchange_needs_the_registered_agent_and_a_valid_subject_token", async () => {
  const issuer = new DevIssuer();
  const subject = await issuer.mint(JAMIE);
  const request = (actorToken: string, subjectToken = subject) => ({
    subjectToken,
    actorToken,
    audience: DIR,
    scope: "directory:read",
    ticketId: TICKET,
  });
  // An assertion from some other agent key.
  const impostor = new AgentIdentity();
  await assert.rejects(
    issuer.exchange(request(await impostor.assertion(DEV_ISSUER))),
    /bad signature/,
  );
  // The other issuer's subject token, with this issuer's agent: refused.
  const issuer2 = new DevIssuer();
  const agent = new AgentIdentity();
  const withAgent = new DevIssuer({ agent });
  await assert.rejects(
    withAgent.exchange(request(await agent.assertion(DEV_ISSUER), await issuer2.mint(JAMIE))),
    /bad signature/,
  );
  // An assertion for another issuer, and a replayed assertion.
  await assert.rejects(
    withAgent.exchange(request(await agent.assertion("https://other.example.test"))),
    /another issuer/,
  );
  const good = await withAgent.mint(JAMIE);
  const assertion = await agent.assertion(DEV_ISSUER);
  await withAgent.exchange(request(assertion, good));
  await assert.rejects(withAgent.exchange(request(assertion, good)), /already used/);
  // A grant presented as the subject token.
  const grant = await withAgent.exchange(request(await agent.assertion(DEV_ISSUER), good));
  await assert.rejects(
    withAgent.exchange(request(await agent.assertion(DEV_ISSUER), grant)),
    TokenError,
  );
});

test("ts_i2_every_tool_has_a_grant_its_resource_offers", () => {
  assert.deepEqual(Object.keys(TOOL_GRANTS).sort(), [...TOOLS.keys()].sort());
  for (const { audience, scope } of Object.values(TOOL_GRANTS)) {
    assert.ok(RESOURCE_SCOPES[audience]?.includes(scope), `${audience} ${scope}`);
  }
  assert.throws(() => toolGrant("rm_rf"), GrantError);
  assert.throws(() => toolGrant("__proto__"), GrantError);
});

// ---------------------------------------------------------------- the handler side

test("ts_i2_handler_refuses_without_a_valid_grant_and_runs_nothing", async () => {
  const { gate } = await makeGate();
  const spec = TOOLS.get("reset_mfa");
  assert.ok(spec);
  let ran = false;
  const spy: ToolSpec = {
    ...spec,
    run: async () => {
      ran = true;
      return [{}, "ran"];
    },
  };
  const resources = new DevIssuer().resources();
  for (const token of [undefined, "", "not.a.token"]) {
    await assert.rejects(
      runWithGrant(spy, gate.ctx, { email: JAMIE }, token, resources),
      GrantError,
    );
  }
  assert.equal(ran, false);
});

test("ts_i2_handler_refuses_a_grant_for_another_requester_or_a_disabled_account", async () => {
  const issuer = new DevIssuer();
  const spec = TOOLS.get("lookup_user");
  assert.ok(spec);
  // Morgan's grant, used in Jamie's gate.
  const { gate } = await makeGate();
  const morgan = await issuer.signIn("morgan.hale@example.test");
  const token = await morgan.grant(DIR, "directory:read", "T-TEST");
  await assert.rejects(
    runWithGrant(spec, gate.ctx, { email: JAMIE }, token, issuer.resources()),
    /someone else/,
  );
  // A disabled requester: the directory is read at call time, not when the token was made.
  const riley = "riley.okafor@example.test";
  const { gate: rileyGate } = await makeGate({ requester: riley });
  const rileyIn = await issuer.signIn(riley);
  const rileyToken = await rileyIn.grant(DIR, "directory:read", "T-TEST");
  await assert.rejects(
    runWithGrant(spec, rileyGate.ctx, { email: riley }, rileyToken, issuer.resources()),
    /not active/,
  );
});

// ---------------------------------------------------------------- the gate

test("ts_i2_gate_audits_the_grant_by_id_and_never_a_token", async () => {
  const approver = new RecordingApprover(true);
  const { gate, audit } = await makeGate({ approver: approver.approve });
  assert.equal((await gate.execute("lookup_user", { email: JAMIE })).decision, Decision.ALLOWED);
  assert.equal((await gate.execute("reset_mfa", { email: JAMIE })).decision, Decision.APPROVED);
  const calls = audit.records.filter((r) => r.event === "tool_call");
  assert.deepEqual(
    calls.map((r) => (r.grant as { scope: string }).scope),
    ["directory:read", "directory:mfa.reset"],
  );
  const [a, b] = calls.map((r) => (r.grant as { jti: string }).jti);
  assert.ok(a && b && a !== b, "a fresh grant per call");
  assert.ok(!JWT.test(JSON.stringify(audit.records)), "no token in the audit log");
});

test("ts_i2_refused_calls_get_no_grant", async () => {
  const { gate, audit } = await makeGate();
  await gate.execute("reset_mfa", { email: JAMIE }); // denied by the human
  await gate.execute("nope", {});
  await gate.execute("add_to_group", { email: JAMIE, group: "ecommerce-prod-admins" }); // policy
  for (const r of audit.records.filter((x) => x.event === "tool_call")) {
    assert.equal(r.grant, undefined, String(r.decision));
  }
});

test("ts_i2_a_refused_grant_fails_closed_and_is_audited", async () => {
  const approver = new RecordingApprover(true);
  const { gate, audit, directory } = await makeGate({ approver: approver.approve });
  const before = JSON.stringify(directory.findUser(JAMIE));
  // Swap in resources from another issuer: every grant from the real issuer fails there.
  Object.defineProperty(gate, "signIn", {
    value: new Proxy((gate as unknown as { signIn: object }).signIn, {
      get: (target, prop) => {
        if (prop === "resources") return new DevIssuer().resources();
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
  });
  const outcome = await gate.execute("reset_mfa", { email: JAMIE });
  assert.equal(outcome.decision, Decision.INTERNAL_ERROR);
  assert.equal(JSON.stringify(directory.findUser(JAMIE)), before, "nothing changed");
  const last = audit.records.at(-1);
  assert.ok(last);
  assert.equal(last.summary, "GrantError");
  assert.match(String(last.reason), /grant refused: bad signature/);
});

test("ts_i2_resources_reject_unknown_audiences", () => {
  assert.throws(() => new Resources([]).get(DIR), /unknown resource/);
});
