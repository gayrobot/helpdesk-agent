# Dependency review: wrangler and @cloudflare/workers-types (Phase 7, slice 6)

Status: **proposed in the Phase 7 slice 6a PR**. Both are dev dependencies; neither ships in the Worker bundle.

`docs/plan.md` names wrangler as part of the Phase 7 stack. It builds the Worker and runs it locally in `workerd`, Cloudflare's open-source Workers runtime. The Workers types let the Worker code compile against the runtime's APIs.

## What was added

Resolved 2026-11-25 with `min-release-age=7`:

| Package | Version | Published | Maintainer | Weekly downloads | Licence |
| --- | --- | --- | --- | --- | --- |
| `wrangler` | 4.164.0 | 2026-11-17 | Cloudflare (`cloudflare/workers-sdk`) | ~49 M | MIT OR Apache-2.0 |
| `@cloudflare/workers-types` | 5.20261117.1 | 2026-11-17 | Cloudflare | (types only) | MIT OR Apache-2.0 |

4.164.0 is the newest wrangler outside the 7-day window; 4.168.0 is out.

## What it pulls in

**35 packages plus 57 platform-binary entries** in `web/package-lock.json`. Only the binaries for the current platform install, and every entry has an integrity hash. This is far more than anything else in `web/`, and it is the main cost of this review.

The ones that matter:

| Package | Version | Published | Why it's there |
| --- | --- | --- | --- |
| `workerd` | 1.20261117.1 | 2026-11-17 | The Workers runtime, a native binary. Runs the Worker locally. |
| `miniflare` | **5.20261117.0-beta** | 2026-11-17 | Wrangler's local simulator around workerd. A prerelease, pinned by wrangler itself. |
| `esbuild` | 0.28.2 | 2026-08-08 | Bundles the Worker. Native binary. |
| `sharp` | 0.35.5 | 2026-09-27 | Image handling inside miniflare. Native binary and libvips. Not used by this project. |
| `undici` | 7.30.1 | 2026-10-15 | HTTP client used by miniflare. |
| `ws` | 8.21.0 | 2026-05-22 | WebSockets for miniflare. |
| `unenv` | **2.0.0-rc.24** | 2025-10-29 | Node compatibility shims, a prerelease, pinned by wrangler. |
| `youch` | **4.1.0-beta.10** | 2025-07-04 | Error pages in local dev, a prerelease, pinned by wrangler. |

The rest are small utilities: source maps, colours, cookie parsing, `semver`, `path-to-regexp` and similar.

**Prereleases:** `miniflare`, `unenv` and `youch` are prereleases that wrangler depends on exactly. They are recorded here; there is no stable alternative short of pinning an older wrangler.

**`npm ls` says "extraneous"** for `@img/sharp-wasm32`, `@emnapi/runtime` and `tslib`. They are sharp's optional WebAssembly fallback: dev, optional, and locked with integrity hashes. A clean `npm ci` installs them the same way; npm mislabels them.

## How it's contained

- **No install scripts.** `workerd`, `esbuild` and `sharp` declare install scripts, but `ignore-scripts=true` skips them. Their platform binaries come from optional packages instead. Checked: the smoke test runs the Worker in `workerd` with scripts blocked, locally and in CI on Linux.
- **The key comes from the environment only.**
  - `wrangler.jsonc` lists `ANTHROPIC_API_KEY` under `secrets.required`, and wrangler then reads that one variable from the process environment, which only `op run` sets. Checked with a dummy value: wrangler logged "Using secrets defined in process.env", showed the value as hidden, and wrote no file.
  - With `nodejs_compat`, `process.env` inside the Worker is filled from that binding, so the Anthropic SDK reads the key itself and no code here handles it.
  - `.dev.vars*` stays gitignored and denied to Claude Code.
- **No debugger port, no explorer, no telemetry.**
  - `wrangler dev` always opens a devtools inspector on 127.0.0.1:9229, and the command line has no switch to turn it off. A debugger attached to a process holding the key could read it. So `npm run dev:worker` starts the Worker through wrangler's API with `inspector: false`. Checked with `lsof`: only the page's port and one internal loopback port were listening.
  - Wrangler's "local explorer" API (`/cdn-cgi/local/explorer/api`) is on by default and lists bindings. The launcher sets `X_LOCAL_EXPLORER=false`, and the smoke test checks the route returns 404.
  - `send_metrics: false` in `wrangler.jsonc` turns telemetry off.
- **Loopback only.** The launcher binds 127.0.0.1, and `wrangler.jsonc` sets `dev.ip` to the same.
- **No deploys.** `workers_dev` and `preview_urls` are off. `npm run build:worker` is `wrangler deploy --dry-run`: it bundles and stops, with no login. Deploys come in Phase 10, from GitHub Actions only.
- **Dev only.** Wrangler never runs in the deployed Worker. The bundle is the project's code plus the Anthropic SDK: 1.25 MB, 229 KB gzipped (slice 6b; 123 KB before the SDK was imported).

## Alternatives considered

- **Running `workerd` directly**, without wrangler: fewer packages, but this project would then own the bundling and the runtime config, and Phase 10's deploys use wrangler anyway.
- **`@cloudflare/vitest-pool-workers`** for tests: it adds Vitest and its tree on top of wrangler. The smoke test runs the real Worker through wrangler's API with Node's own test runner instead.
