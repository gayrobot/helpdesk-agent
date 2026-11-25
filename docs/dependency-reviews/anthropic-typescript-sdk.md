# Dependency review: @anthropic-ai/sdk (Phase 7, slice 3)

Status: **proposed in the Phase 7 slice 3 PR**. A runtime dependency: it makes the model calls in Node now and in the Cloudflare Worker later.

`docs/plan.md` names the official Anthropic TypeScript SDK as part of the Phase 7 stack, as `anthropic` is for the Python agent.

## What was added

| Package | Version | Published | Maintainer | Weekly downloads | Licence |
| --- | --- | --- | --- | --- | --- |
| `@anthropic-ai/sdk` | 1.10.0 | 2026-11-17 | Anthropic (15 npm maintainers, all `@anthropic.com`) | ~75 M | Apache-2.0 |

1.10.0 is the newest release outside the 7-day window on 2026-11-25. The latest release, 1.14.0, came out on 2026-11-24, so the cooldown is doing its job. Source: `github.com/anthropics/anthropic-sdk-typescript`.

## What it pulls in: 7 packages

Resolved with `min-release-age=7`. The tree is identical in a scratch install and in `web/package-lock.json`.

| Package | Version | Published | Licence | Pulled in by, and why |
| --- | --- | --- | --- | --- |
| `@opentelemetry/api` | 1.10.0 | 2026-10-20 | Apache-2.0 | SDK client: optional tracing hooks. Loaded at runtime; a no-op unless an OpenTelemetry SDK is registered, and this project registers none. |
| `json-schema-to-ts` | 3.1.1 | 2024-08-29 | MIT | SDK: types for schema-typed tool helpers. Not used here. |
| `@babel/runtime` | 7.29.14 | 2026-11-11 | MIT | `json-schema-to-ts` |
| `ts-algebra` | 2.0.0 | 2024-05-04 | MIT | `json-schema-to-ts` |
| `standardwebhooks` | 1.3.0 | 2026-11-17 | MIT | SDK webhooks helper (signature checks). Not imported by the code paths used here. |
| `@stablelib/base64` | 1.0.1 | 2021-05-21 | MIT | `standardwebhooks` |
| `fast-sha256` | 1.3.0 | 2020-01-16 | Unlicense | `standardwebhooks` |

`zod` is an optional peer dependency (for `betaZodTool`). It isn't installed or used: tool schemas here are plain JSON Schema, checked by the gate's own `validateArgs`.

## How it's contained

- **Types only in the core.** `src/client.ts` and `src/agent.ts` use `import type` from the SDK and take the client as a parameter. Only `src/node/anthropic.ts` constructs it. `test/client.test.ts` fails if the core imports SDK code at runtime or if any test builds a real client.
- **No key in code.** The client is built with `{ maxRetries: 2, timeout: 60_000 }` and no `apiKey`. The SDK reads `ANTHROPIC_API_KEY` from the environment, which only `op run` sets. A test fails if `apiKey` appears in that file, and another fails if the timeout isn't in milliseconds.
- **Same API version as Python.** Both SDKs send `anthropic-version: 2026-10-21` (Python `anthropic` 2.6.0, `_constants.ANTHROPIC_API_VERSION`; TypeScript 1.10.0, client headers), so the Phase 7 parity run compares the agents, not two API versions.
- **Same request.** The request body, key order included, is checked byte for byte against Python's (`test/agent-parity.test.ts`). All four request fields it sends (top-level `cache_control`, `output_config`, `betas` and `fallbacks: "default"`) exist in 1.10.0's beta types.
- **CI stays key-free.** Unit tests use a scripted fake client (`test/fakes.ts`) and run with `ANTHROPIC_API_KEY=""`.

## Risks

- **Size of trust.** It's a large, fast-moving package from the API vendor, the same trust the Python agent already places in `anthropic`. The cooldown and lockfile apply.
- **Unused transitive code** (webhooks, schema typing) is installed but never imported. Revisit if a smaller entry point becomes available, or when the Worker bundle is measured in slice 6.
