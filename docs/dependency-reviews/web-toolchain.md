# Dependency review: web/ toolchain (Phase 7, slice 1)

Status: **proposed in the Phase 7 toolchain PR**. Dev dependencies only; nothing here ships in the Worker.

The TypeScript rewrite needs a type checker and a linter/formatter. Everything else in this slice uses what Node 24 already has:

- **Tests:** Node's built-in runner (`node --test`) and `node:assert`. No test framework.
- **Running TypeScript:** Node 24 strips types natively, so `.ts` files run with no build step. `tsconfig.json` sets `erasableSyntaxOnly`, so code that needs real compilation (enums, namespaces, parameter properties) fails the type check.

The Anthropic TypeScript SDK and `wrangler` are needed later (model calls in slice 3, the Worker in slice 6). Each gets its own review in the PR that adds it.

## Rules applied (`web/.npmrc`)

| Setting | Effect |
| --- | --- |
| `min-release-age=7` | npm builds the whole tree, transitive packages included, from versions published more than 7 days ago, and errors if none qualify. Same rule as uv's `exclude-newer = "7 days"`. Checked against npm 11.12.1's own docs. |
| `save-exact=true` | `npm install x` writes `"x": "1.2.3"`, never `^1.2.3`. |
| `ignore-scripts=true` | No package's `preinstall` / `install` / `postinstall` script ever runs. None of the packages below needs one. |
| `engine-strict=true` | Refuses to install on a Node outside `engines` (`>=24.11.0 <25`). |

Like uv's cooldown, `min-release-age` applies when the lockfile is resolved. CI runs `npm ci`, which installs exactly `package-lock.json` and fails if it doesn't match `package.json`. `web/test/toolchain.test.ts` fails if `.npmrc` loses any of these settings, if a version isn't exact, or if a locked package has no integrity hash.

## What was added

Resolved 2026-11-25 with the cooldown on. Downloads are npm's last-week counts that day.

| Package | Version | Published | Maintainer | Weekly downloads | Licence | Why |
| --- | --- | --- | --- | --- | --- | --- |
| `typescript` | 7.0.2 | 2026-07-08 | Microsoft | ~448 M | Apache-2.0 | Type check (`tsc --noEmit`). |
| `@biomejs/biome` | 2.6.8 | 2026-11-15 | Biome core team | ~30 M | MIT OR Apache-2.0 | Lint and format in one tool. |
| `@types/node` | 24.19.2 | 2026-10-09 | DefinitelyTyped (Microsoft) | ~671 M | MIT | Types for `node:test`, `node:assert`, `node:fs`. |

**Transitive packages: 2, plus platform binaries.**

- **`undici-types` 7.24.6**, published 2026-03-25 (Node.js maintainers), pulled in by `@types/node`. Type declarations only.
- **Platform binaries:**
  - **What they are:** TypeScript 7 is the native (Go) compiler, so `typescript` and `@biomejs/biome` each ship one prebuilt binary per platform as an optional dependency, e.g. `@typescript/typescript-darwin-arm64` and `@biomejs/cli-linux-x64`.
  - **Which install:** npm installs only the one for the current machine, so 1 per tool locally and on CI's Linux runner. The lockfile lists all of them with integrity hashes.
  - **Who publishes them:** the same publishers as the parent package, with the same version and release date.

## Risks and how they're handled

- **Native binaries:** both tools run compiled code from npm, not readable JavaScript. They come from the same publishers as the parent packages and are integrity-checked by the lockfile, and no install script runs to fetch anything else. This is the same trust as Ruff (a Rust binary from PyPI) on the Python side.
- **TypeScript 7 is new.** It's the native port, and a few older options (e.g. `baseUrl`, `moduleResolution: node10`) are gone; `tsconfig.json` uses none of them. If it misbehaves, pinning `typescript` back to 5.9.x is a one-line change.
- **Dev only.** None of these runs in the deployed Worker or sees the API key. CI runs them with `ANTHROPIC_API_KEY=""`.

## Alternatives considered

- **ESLint and Prettier** instead of Biome: about 100 transitive packages between them, against Biome's single binary.
- **Vitest** instead of `node --test`: it pulls in Vite and esbuild (dozens of packages) for features this project doesn't need. Revisit only if Worker-runtime tests need `@cloudflare/vitest-pool-workers` in slice 6, with its own review.
- **pnpm or Bun** instead of npm: an extra tool to install and trust. npm 11 now covers the cooldown, exact pins and script blocking itself.

## GitHub Action added

- **`actions/setup-node`** v7.1.0 (published 2026-10-08), pinned to commit `949feb2413d6458794dcd2491c4babbbce0c15c1`. The SHA was looked up with `gh api repos/actions/setup-node/git/ref/tags/v7.1.0`. It sets `node-version: "24"` and uses no cache, so no cache key or restore step can affect what's installed.
