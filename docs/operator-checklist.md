# Operator checklist

Steps that only Skylar can do by hand, in order. Claude Code and CI never do these. They need a human login, a 1Password unlock, a paid API call or a decision about the repo or the public site.

Each item says **where** it happens and **when**. Tick the box in a PR when it's done.

Checked on 2026-11-13. Facts marked "verified" came from `gh api` calls and read-only Cloudflare API calls that day. They can drift, so re-run the check commands before relying on them.

## Who does what

| Actor | Can do | Never does |
| --- | --- | --- |
| Skylar | Everything below: Console, 1Password, GitHub settings, Cloudflare, merging PRs, typing `y` at the write gate | — |
| Claude Code | Code, tests, docs, PRs, read-only `gh api` checks, live `op run` commands (key check, `ping`, `eval`; allowed by Skylar on 2026-11-19) | Read `.env*`, run `op read` / `op item get` / `op inject`, print the key or the environment, answer a write-gate prompt, change repo settings unless Skylar asks in the session, deploy |
| CI | Lint, format, unit tests (mocked client, `ANTHROPIC_API_KEY=""`), gitleaks | Call the real API |

## 1. When the credits land (around 2026-11-18)

None of this can start before the credits are on the account. Do it the day they arrive, before the Phase 3 live steps. Until then, everything is built against the mocked client.

- [ ] **Create a dedicated workspace.** Console UI (console.anthropic.com → Settings → Workspaces). Name it e.g. `helpdesk-agent-dev`. Keep it separate from anything else on the account so spend and keys are scoped.
- [ ] **Set a spend limit on that workspace.** Console UI (workspace → Limits). Pick a monthly cap that would hurt to exceed but covers Phase 5 (50–100 tickets × a few runs, Haiku while developing). Turn on email alerts below the cap if the Console offers them.
- [ ] **Set workspace rate limits if offered.** Console UI. Lower than the org default is fine; this is a demo.
- [ ] **Create a workspace-scoped API key.** Console UI (workspace → API keys). Name it after the project and the date, e.g. `helpdesk-agent-dev-2026-11`. The key is shown once.
- [x] **Store the key only in 1Password.** 1Password app (not the CLI, so the value never touches shell history). Vault `nerd shit`, item `HelpDeskAgent`, field `credential`. Paste straight from the Console into 1Password. Don't paste it into a terminal, chat, file, note or Claude session.
- [x] **Check the reference resolves, without printing the value.** Terminal, Skylar or Claude Code:

  ```bash
  op run --env-file=.env.tpl -- sh -c 'test -n "$ANTHROPIC_API_KEY" && echo key present'
  ```

  `.env.tpl` points at `op://nerd shit/HelpDeskAgent/credential` (updated 2026-11-19 to match where the key was stored). If you rename the item, update `.env.tpl` in a PR.
- [ ] **Set a 90-day rotation reminder.** Calendar or 1Password (item → add an expiry date, which 1Password Watchtower then flags). Date = key creation + 90 days; a key made on 2026-11-18 is due on **2027-02-16**.
- [ ] **Confirm the local tools are installed and unlocked.** Terminal: `op --version`, `op whoami` (sign in via the 1Password app integration), `gitleaks version`, `pre-commit install` in your main checkout.

**Console UI:** workspace, spend limit, rate limits, key creation.
**1Password:** storing the key, expiry/rotation reminder, `op run` check.

## 1b. Before Phase 7: the Okta org (added 2026-11-24)

Skylar, by hand. Nothing uses it until Phase 8 (identity phase I5), but it's created early so the rewrite can be designed around it.

- [ ] **Create an Okta Integrator Free Plan org** at developer.okta.com. Use it only for this project.
- [ ] **Sign in with phishing-resistant MFA** on your own admin account (a passkey or WebAuthn key).
- [ ] **Put nothing real in it.** Only the synthetic Larkspur users and groups, loaded later by a script from `directory.json`. No real people, no connections to other orgs, no production apps.
- [ ] **Store the org URL in 1Password** (e.g. a new `HelpDeskAgent-Okta` item). Client IDs and the agent's private key go in the same item later and are referenced from `.env.tpl`; never paste them into a terminal, chat or file.
- [ ] **Note:** `example.test` addresses can't receive activation email, so the synthetic users' passwords will be set by you, through the admin console or the seeding script.

Claude Code never signs in to this org, never completes a device sign-in, and never creates or reads its credentials.

## 2. GitHub hygiene

Checked with `gh api` on 2026-11-13 against `gayrobot/helpdesk-agent` (public). At Skylar's request, Claude turned on Dependabot alerts and required SHA pinning that day; everything else is unchanged. Settings live at GitHub → repo → Settings.

### Already in place

- [x] **Secret scanning:** enabled.
- [x] **Push protection:** enabled.
- [x] **Branch protection on `main`:** required checks `lint + test` and `gitleaks`, branches must be up to date (strict), force-push off, deletion off, linear history, conversation resolution required, enforced for admins too, stale reviews dismissed.
- [x] **CODEOWNERS:** `.github/CODEOWNERS` assigns `* @gayrobot`; GitHub reports no errors in it.
- [x] **Actions:** default `GITHUB_TOKEN` permission is read-only, and Actions can't approve PRs.
- [x] **Merge settings:** squash only, branches deleted after merge, auto-merge off.
- [x] **Dependabot alerts:** turned on 2026-11-13 (`vulnerability-alerts` returns 204). Alerts only; no PRs are opened.
- [x] **Require actions pinned to full SHAs:** turned on 2026-11-13 (`sha_pinning_required: true`). The workflows already pin by SHA, so this enforces what's there. A new action added by tag will fail until it's pinned.

### Missing or worth deciding

- [ ] **Dependabot security updates: off.** Optional. If you turn it on, its PRs still have to respect the exact pins, `uv.lock` and the 7-day cooldown, so review them like any dependency change (section 5).
- [ ] **Allowed actions: all.** Optional: restrict to actions from GitHub plus `astral-sh/setup-uv` and `gitleaks/gitleaks-action`.
- [ ] **Non-provider secret patterns and validity checks: off.** Settings → Code security → Secret scanning. Optional extras on a public repo.
- [ ] **Code-owner review not required** (`require_code_owner_reviews: false`, 0 approvals). That's deliberate for a solo repo: GitHub doesn't let you approve your own PR, so requiring it would block every merge. Leave as is unless a second reviewer joins.

Re-check any time, read-only:

```bash
gh api repos/gayrobot/helpdesk-agent --jq .security_and_analysis
gh api repos/gayrobot/helpdesk-agent/branches/main/protection
gh api repos/gayrobot/helpdesk-agent/codeowners/errors
gh api repos/gayrobot/helpdesk-agent/actions/permissions
gh api -i repos/gayrobot/helpdesk-agent/vulnerability-alerts | head -1   # 204 = on, 404 = off
```

### Every PR

- [ ] **Review and merge.** GitHub UI. Claude opens PRs; Skylar reads the diff and merges. Claude never pushes to `main` or bypasses CI.

## 3. Live steps (from 2026-11-18, once the key exists)

**Skylar or Claude Code** (since 2026-11-19). These spend money and send synthetic data to the API. CI never runs them. Write-gate approvals stay with Skylar. Run from a clean checkout of `main` after the matching phase has merged.

The subcommand names below follow `docs/plan.md`; the Phase 3 PR may change flags. Run `uv run helpdesk-agent --help` (no key needed) first and adjust.

### Phase 3 live (after Phase 3 merges)

- [ ] **Dry run first, no key.** Terminal:

  ```bash
  uv run helpdesk-agent --dry-run ticket --requester jamie@example.test "Please reset MFA for jamie@example.test, I got a new phone."
  ```

- [ ] **Ping.** Terminal. Expect a reply and one log line with tokens and cost in `logs/`:

  ```bash
  op run --env-file=.env.tpl -- uv run helpdesk-agent ping
  ```

- [ ] **MFA ticket.** Terminal. You'll see the approval prompt; read the arguments and the requester/target line, then type `y`. Run it a second time and type anything else to see the denial path.

  ```bash
  op run --env-file=.env.tpl -- uv run helpdesk-agent ticket --requester jamie@example.test "Please reset MFA for jamie@example.test, I got a new phone."
  ```

- [ ] **Check the logs.** Terminal. `logs/` should have the model call lines and `logs/audit.jsonl` entries for lookup, proposal and approval. Confirm no key is in them:

  ```bash
  gitleaks dir logs/ --redact --no-banner
  ```

- [ ] **Check spend.** Console UI → workspace → Usage. Compare with the cost the CLI logged.

### Phase 5 live (after the Phase 5 ticket set and scorer merge)

- [ ] **Read the Haiku grader prompt** before the first graded run: `src/helpdesk_agent/data/grader-prompt.md`. It grades only how-to answers (tickets with an expected runbook that the agent answered or escalated with a reply) on three yes/no questions; `src/helpdesk_agent/grader.py` has the rest.
- [ ] **Run the eval set.** Terminal. Expect pass rates by category, cost and latency, the grader line, and a file in `evals/results/<date>.json`. Measure cost on a small run first:

  ```bash
  op run --env-file=.env.tpl -- uv run helpdesk-agent eval --category howto --limit 3 --grade
  ```

  ```bash
  op run --env-file=.env.tpl -- uv run helpdesk-agent eval --grade
  ```

  The grade is reported next to the deterministic pass rate and never changes it; grader cost is shown on its own line, apart from the agent's cost.

  The approval step uses the auto-deny stub, so nothing should be written.
- [ ] **Run it again after one system prompt change** and keep both result files; the plan's "done" needs a measurable difference.
- [ ] **Check spend** in the Console against the cap, and review `evals/results/*.json` before committing them (synthetic data only, no key, no full prompts you wouldn't publish).

## 4. Phase 6: the project on its own subdomain, featured on damiano.dev

> **Superseded on 2026-11-24.** The project is now a web app on a Cloudflare Worker (see "Sequence from Phase 6" in `docs/plan.md`); the static-site option below no longer applies, and this section's steps now belong to Phase 10. The token, environment, domain and review steps still apply.

**Not before launch.** Phase 6 starts only after the live steps in section 3 are done and there are real eval numbers. Nothing here is built or created in Cloudflare before then.

**Decided 2026-11-13 (Skylar):** the project lives on its own subdomain, e.g. `helpdesk-agent.damiano.dev`, and gets a project entry on damiano.dev like the other projects. It's built with the same setup as damiano.dev: the same Cloudflare account and zone, a Worker serving static assets, previews on every PR, deploys from GitHub Actions on `main` only, and one check gating every deploy.

### How damiano.dev is served (checked 2026-11-13, read-only Cloudflare API)

- The `damiano.dev` zone is on Cloudflare (Free plan). `damiano.dev` and `www.damiano.dev` are **Workers custom domains** bound to the Worker `damiano-dev`. There's no Pages project.
- The Worker serves a static **Astro** build with Workers static assets (`assets.directory = ./dist`, no server code). Source: the public repo `gayrobot/damiano.dev`, which has `src/content/projects/` and `src/pages/projects/`.
- **Preview:** `.github/workflows/preview.yml` in that repo runs on every PR that touches `src/**` and uploads a Worker version with the alias `pr-<N>`. It comments the preview URL on the PR. Nothing is promoted.
- **Production:** merging to `main` deploys, through the deploy job in its `ci.yml` only.


So the work has two parts: the subdomain site, and an entry in the damiano.dev project list.

### How other projects are featured

Each project is one file in `gayrobot/damiano.dev` under `src/content/projects/` (today `hvrad-io.md`, `netstack.md`, `ride-waits.md`). The front matter has `title`, `date`, `summary`, `status`, `tags`, `url` (the project's own domain) and `featured: true`, then a write-up in Markdown. `hvrad.io` and `ride-waits` each run as their own Worker on their own domain, and the entry links out to them. The helpdesk-agent entry follows the same pattern, with `url: https://helpdesk-agent.damiano.dev`.

### Decide at the start of Phase 6

- [ ] **What the subdomain serves.** Skylar. The agent is a CLI with a paid API key and a human write gate, so it can't simply be put online as is. Options:
  - **Static site (recommended starting point):** the write-up, architecture, governance rules, eval results from `evals/results/`, cost per ticket, and recorded transcripts of real runs (synthetic data only). No key on the server, no spend exposure.
  - **Live demo:** a Worker that holds an Anthropic key and runs tickets on request. Needs its own design first: a separate workspace key with a low spend limit stored as a Worker secret, rate limiting and abuse protection (e.g. Turnstile), no real write tools (the write gate can't be a stranger on the internet), and logging that never stores visitor text we wouldn't publish. Treat it as its own phase.
- [ ] **Where its source lives.** Skylar. Either a `site/` folder in this repo (next to the code and `evals/results/`) or a separate repo like `hvrad.io`. Either way it copies damiano.dev's harness: `wrangler.jsonc` with assets, a CI workflow with a deploy job behind a `production` GitHub environment, and a preview workflow behind a `preview` environment.

### Steps (after launch)

- [ ] **Build the site.** Claude, in a PR, following damiano.dev's setup (Astro, Workers static assets, pinned dependencies, actions pinned by SHA). Claude doesn't deploy.
- [ ] **Create a scoped Cloudflare API token.** Cloudflare dashboard (My Profile → API Tokens), Skylar. Workers edit for this account only. Store it in 1Password, then as `CLOUDFLARE_API_TOKEN` in the new repo's `production` and `preview` GitHub environments (GitHub UI → Settings → Environments), with `CLOUDFLARE_ACCOUNT_ID` as an environment variable. Limit `production` to the `main` branch.
- [ ] **Turn on secret scanning, push protection, Dependabot alerts, required SHA pinning and branch protection** on the new repo if it's separate (GitHub UI), matching section 2.
- [ ] **First deploy and the custom domain.** Merging to `main` creates the Worker. Then Cloudflare dashboard → Workers & Pages → the new Worker → Settings → Domains & Routes → add `helpdesk-agent.damiano.dev`; Cloudflare creates the DNS record and certificate. Skylar does this, or tells Claude to in the session.
- [ ] **Check the preview, then production.** Browser, Skylar: the `pr-<N>` preview link on the PR, then `https://helpdesk-agent.damiano.dev` on desktop and phone. Numbers must match `evals/results/`.
- [ ] **Add the project entry to damiano.dev.** Claude, in a PR to `gayrobot/damiano.dev`: `src/content/projects/helpdesk-agent.md` with the same front matter as the others and `url: https://helpdesk-agent.damiano.dev`. Skylar reviews the preview the site's workflow posts, and merges. The merge deploys through Actions.
- [ ] **Review both for data.** Skylar, before each merge. Real eval numbers and cost are fine. No key, no request IDs, no real names, nothing from employers, only `example.test` data.
- [ ] **Link the subdomain from this repo's README** in a PR once it's live.

Claude may build both and open the PRs. It doesn't run `wrangler deploy`, create tokens, or merge.

### Fixed: double deploy

- [x] **One production deploy path.** Until 2026-11-13 both the site's GitHub Actions deploy job and a Cloudflare Workers Builds trigger deployed on every push to `main`; the build history shows both ran for the same commits. At Skylar's request, Claude deleted the Workers Builds trigger through the Cloudflare API that day, so only Actions deploys. The unused build token named `damiano-dev` and the GitHub repo connection are still there; remove them in the dashboard (Workers & Pages → `damiano-dev` → Settings → Build) if you like.

## 5. Dependency reviews (when a phase adds one)

CLAUDE.md requires a short review before any new dependency. Claude writes the review in the PR; Skylar reads it and decides.

- [ ] **`fastembed` (Phase 4, if it's added).** GitHub PR. Check: maintainer (Qdrant), release history and download numbers, what it pulls in (`onnxruntime`, `tokenizers`, `huggingface-hub`, `numpy` and more), that it's pinned exactly and passes the 7-day cooldown in `uv.lock`. Also check that it **downloads model weights at runtime** from Hugging Face: decide which model and revision is pinned, where it's cached, its license, and that CI either caches it or skips the embeddings test without network. Keep it only if embeddings beat BM25 on the retrieval eval.
- [ ] **Any other new package** (e.g. a BM25 library): same questions, same PR.
- [ ] **Dependabot PRs**, if turned on in section 2: read the changelog, check the version passes the cooldown, merge by hand.

## 6. Ongoing and incident steps

- [ ] **Rotate the key every 90 days** (first due 2027-02-16 if made on 2026-11-18). Console: create a new workspace key. 1Password: replace the `credential` field in the same item, so `.env.tpl` doesn't change. Run the `op run ... echo key present` check and `helpdesk-agent ping`. Console: delete the old key. Move the reminder forward 90 days.
- [ ] **If the key leaks** (GitHub push-protection alert, gitleaks hit, Anthropic notice, pasted somewhere by mistake):
  1. Console UI → workspace → API keys → **delete the key now**. Don't wait to investigate.
  2. Console UI → Usage: look for calls you didn't make; lower the spend limit if needed.
  3. Create a new key and store it in 1Password as above.
  4. If it reached Git: resolve the GitHub secret-scanning alert, and clean history only after the key is dead (rewriting history doesn't make a public key safe again).
  5. Find how it leaked (logs, shell history, a file) and fix that in a PR.
- [ ] **Watch spend** while live work is active, weekly: Console → Usage.
- [ ] **Answer every write-gate prompt yourself.** Never pipe `y` into the CLI or script approvals; the gate is the point of the project.
- [ ] **Optional Voyage AI retriever** (plan, "optional later"): a second account and key, stored in 1Password as its own item, a new line in `.env.tpl`, its own spend limit and rotation reminder. Same rules as the Anthropic key.
- [ ] **When the project winds down:** delete the workspace keys in the Console, archive the 1Password item, and lower the spend limit to zero.
