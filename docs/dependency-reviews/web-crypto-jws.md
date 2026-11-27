# Dependency review: signing and verifying tokens (identity phase I1)

Status: **no dependency added.** `web/src/identity.ts` uses Web Crypto (`crypto.subtle`), which Node 24 and Cloudflare Workers both provide.

The identity plan needs asymmetric signatures (subject tokens now; delegated tokens and approval receipts in I2 and I4) and asks for a review comparing Web Crypto used directly with a JOSE library such as `jose`, preferring "the smaller option that still pins algorithms strictly".

## The options

| | Web Crypto directly | `jose` |
| --- | --- | --- |
| What it is | Built into Node and Workers: ECDSA P-256 / SHA-256 sign and verify | A JOSE/JWT library by one maintainer (`panva`), widely used, no dependencies, works in Workers |
| New packages | 0 | 1 |
| Code we own | About 150 lines: base64url, compact JWS sign/verify, claim checks | Less: the library does JWS and the standard claim checks |
| Algorithm pinning | Our verifier takes exactly one algorithm from configuration and refuses any header that names another | Supports an `algorithms` allowlist; safe when the caller always passes it |
| What it can do | Only what this project needs: compact JWS, ES256 | Much more: JWE, JWK sets, remote key sets, many algorithms |

## Why Web Crypto

- **Smallest attack surface.** No package to trust or update. Everything the verifier accepts is in one short file, readable in a sitting.
- **Strict by construction.** One issuer, one audience, one algorithm and one key come from configuration, never from the token. Header fields that point at keys (`jwk`, `jku`, `x5u`, `x5c`) and `crit` are refused outright. The code has no path that fetches a key.
- **Same code in Node and the Worker,** which the identity plan needs for Durable Object sessions.

The cost is owning a small amount of security-sensitive code. That is handled with tests that don't trust our own code:

- **An independent oracle:** the published ES256 example from RFC 7515 appendix A.3 verifies, and fails with one character changed.
- **A cross-check with `node:crypto`** in both directions: Node signs and we verify, we sign and Node verifies.
- **Attack tests, each failing closed:**
  - `alg: none`, HS256, and HS256 signed with the public key as the HMAC secret (algorithm confusion)
  - a validly signed token whose header names another algorithm
  - padded, non-canonical and wrong-alphabet base64url, and the wrong number of segments
  - key-pointing headers
  - wrong issuer, wrong audience, and an audience given as an array
  - every required claim missing in turn
  - expired, issued in the future, and not yet valid
  - non-integer times, and a subject that isn't a directory email
- **Mutation-checked:** removing the audience check or the algorithm check makes a test fail.

## When to revisit

If Okta (I5) needs anything beyond a fixed ES256 or RS256 key, such as fetching and rotating keys from its JWKS endpoint, reconsider `jose` then, with its own review. RS256 would add one entry to the algorithm table (RSASSA-PKCS1-v1_5 with SHA-256 is in Web Crypto). Check what Okta signs with before choosing.

**Revisited 2026-11-27 (I5): still no dependency.** Okta signs with RS256 and publishes its keys as a JWKS. RS256 is one more row in the algorithm table. The key set (`web/src/okta.ts`) is about 100 lines: one URL derived from the configured issuer, RSA keys of at least 2048 bits, selection by `kid`, and at most one refetch a minute. The algorithm still comes from configuration, never the token, and key-pointing headers are still refused. `jose` would replace that with a remote key set we'd configure the same way, so the trade is the same as before. Tests: a cross-check with `node:crypto` for RS256, plus key-type confusion both ways (an RSA key under ES256 and the reverse).
