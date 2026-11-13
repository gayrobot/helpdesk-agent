# Operator checklist

Steps that only Skylar can do by hand, in order. Claude Code and CI never do these. They need a human login, a 1Password unlock, a paid API call or a decision about the repo or the public site.

Each item says **where** it happens and **when**. Tick the box in a PR when it's done.

Checked on 2026-11-13. Facts marked "verified" came from `gh api` calls and read-only Cloudflare API calls that day. They can drift, so re-run the check commands before relying on them.

## Who does what

| Actor | Can do | Never does |
| --- | --- | --- |
| Skylar | Everything below: Console, 1Password, GitHub settings, Cloudflare, live `op run` commands, merging PRs, typing `y` at the write gate | — |
| Claude Code | Code, tests, docs, PRs, read-only `gh api` checks | Read `.env*`, run `op read` / `op item get` / `op inject`, run anything through `op run`, change repo settings unless Skylar asks in the session, deploy |
| CI | Lint, format, unit tests (mocked client, `ANTHROPIC_API_KEY=""`), gitleaks | Call the real API |

## 1. When the credits land (around 2026-11-18)

None of this can start before the credits are on the account. Do it the day they arrive, before the Phase 3 live steps. Until then, everything is built against the mocked client.

- [ ] **Create a dedicated workspace.** Console UI (console.anthropic.com → Settings → Workspaces). Name it e.g. `helpdesk-agent-dev`. Keep it separate from anything else on the account so spend and keys are scoped.
- [ ] **Set a spend limit on that workspace.** Console UI (workspace → Limits). Pick a monthly cap that would hurt to exceed but covers Phase 5 (50–100 tickets × a few runs, Haiku while developing). Turn on email alerts below the cap if the Console offers them.
- [ ] **Set workspace rate limits if offered.** Console UI. Lower than the org default is fine; this is a demo.
- [ ] **Create a workspace-scoped API key.** Console UI (workspace → API keys). Name it after the project and the date, e.g. `helpdesk-agent-dev-2026-11`. The key is shown once.
- [ ] **Store the key only in 1Password.** 1Password app (not the CLI, so the value never touches shell history). Vault `Private`, item `Anthropic helpdesk-agent-dev`, field `credential`. Paste straight from the Console into 1Password. Don't paste it into a terminal, chat, file, note or Claude session.
- [ ] **Check the reference resolves, without printing the value.** Terminal, Skylar only:

  ```bash
  op run --env-file=.env.tpl -- sh -c 'test -n "$ANTHROPIC_API_KEY" && echo key present'
  ```

  `.env.tpl` already points at `op://Private/Anthropic helpdesk-agent-dev/credential` (verified 2026-11-13). If you rename the item, update `.env.tpl` in a PR.
- [ ] **Set a 90-day rotation reminder.** Calendar or 1Password (item → add an expiry date, which 1Password Watchtower then flags). Date = key creation + 90 days; a key made on 2026-11-18 is due on **2027-02-16**.
- [ ] **Confirm the local tools are installed and unlocked.** Terminal: `op --version`, `op whoami` (sign in via the 1Password app integration), `gitleaks version`, `pre-commit install` in your main checkout.

**Console UI:** workspace, spend limit, rate limits, key creation.
**1Password:** storing the key, expiry/rotation reminder, `op run` check.

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

**Skylar only.** These spend money and send synthetic data to the API. Claude Code and CI never run them. Run from a clean checkout of `main` after the matching phase has merged.

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

- [ ] **Read the Haiku grader prompt** checked into the repo before the first graded run.
- [ ] **Run the eval set.** Terminal. Expect pass rates by category, cost and latency, and a file in `evals/results/<date>.json`:

  ```bash
  op run --env-file=.env.tpl -- uv run helpdesk-agent eval evals/tickets.jsonl
  ```

  The approval step uses the auto-deny stub, so nothing should be written.
- [ ] **Run it again after one system prompt change** and keep both result files; the plan's "done" needs a measurable difference.
- [ ] **Check spend** in the Console against the cap, and review `evals/results/*.json` before committing them (synthetic data only, no key, no full prompts you wouldn't publish).

## 4. Phase 6: publish the write-up on damiano.dev

### How the site is served (checked 2026-11-13, read-only Cloudflare API)

- The `damiano.dev` zone is on Cloudflare (Free plan). `damiano.dev` and `www.damiano.dev` are **Workers custom domains** bound to the Worker `damiano-dev`. There's no Pages project.
- The Worker serves a static **Astro** build with Workers static assets (`assets.directory = ./dist`, no server code). Source: the public repo `gayrobot/damiano.dev`, which has `src/content/projects/` and `src/pages/projects/`.
- **Preview:** `.github/workflows/preview.yml` in that repo runs on every PR that touches `src/**` and uploads a Worker version with the alias `pr-<N>`. It comments the preview URL on the PR. Nothing is promoted.
- **Production:** merging to `main` deploys (the deploy job in its `ci.yml`). The Worker also has a Workers Builds trigger on `main` (`npm run build`, then `npx wrangler deploy`). See the follow-up below.

So publishing the write-up is a content PR in the site repo. It needs no new DNS record, route, Worker, Pages project or `wrangler login`.

### Steps

- [ ] **Draft the page.** Claude can do this, in a PR to `gayrobot/damiano.dev`: a new entry under `src/content/projects/` (e.g. `helpdesk-agent.md`) following the existing entries. The URL becomes `damiano.dev/projects/<slug>`. Content: problem, architecture, governance rules, real eval numbers, cost per ticket, retrieval comparison, what fails and why. It waits for the Phase 5 live numbers.
- [ ] **Review the write-up for data.** GitHub PR, Skylar. Real eval numbers and cost are fine. No key, no request IDs, no real names, nothing from employers, only `example.test` data in screenshots and transcripts. The site's `npm run check:privacy` and `lint:content` checks help but don't replace reading it.
- [ ] **Check the preview.** Browser, Skylar: open the `pr-<N>` URL that the preview workflow comments on the PR, on desktop and phone. Check links, images, and that the numbers match `evals/results/`.
- [ ] **Merge to publish.** GitHub UI, Skylar. Merging to `main` deploys to production. Then check `https://damiano.dev/projects/<slug>` live.
- [ ] **Link the page from this repo's README** in a PR once it's live.

The Cloudflare dashboard and `wrangler login` are needed only if the preview workflow fails for a credentials reason. Its token lives in the site repo's `preview` GitHub environment as `CLOUDFLARE_API_TOKEN`; if it expired, Skylar makes a new one in the Cloudflare dashboard (My Profile → API Tokens, Workers edit, this account only) and replaces the environment secret.

Claude may draft the page and open the PR, but doesn't run `wrangler`, create Cloudflare resources or merge.

### Follow-up found while checking

- [ ] **Two production deploy paths on `main`.** Both the site's GitHub Actions deploy job and the Cloudflare Workers Builds trigger deploy on every push to `main`. Recent versions were uploaded by `wrangler` from Actions. Decide which one you want, then disconnect the other in the Cloudflare dashboard (Workers & Pages → `damiano-dev` → Settings → Build) or remove the job, so one merge doesn't deploy twice. This belongs to the site repo, not this one.

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
