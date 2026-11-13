# Operator checklist

Steps that only Skylar can do by hand, in order. Claude Code and CI never do these. They need a human login, a 1Password unlock, a paid API call or a decision about the repo or the public site.

Each item says **where** it happens and **when**. Tick the box in a PR when it's done.

Checked on 2026-11-13. Facts marked "verified" came from read-only `gh api` calls and public DNS that day. They can drift, so re-run the check commands before relying on them.

## Who does what

| Actor | Can do | Never does |
| --- | --- | --- |
| Skylar | Everything below: Console, 1Password, GitHub settings, Cloudflare, live `op run` commands, merging PRs, typing `y` at the write gate | — |
| Claude Code | Code, tests, docs, PRs, read-only `gh api` checks | Read `.env*`, run `op read` / `op item get` / `op inject`, run anything through `op run`, change repo settings, deploy |
| CI | Lint, format, unit tests (mocked client, `ANTHROPIC_API_KEY=""`), gitleaks | Call the real API |

## 1. Before the credits land (by 2026-11-17)

API credits arrive around **2026-11-18**. Get the account ready the day before so the Phase 3 live steps can run the same day.

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
- [ ] **Set a 90-day rotation reminder.** Calendar or 1Password (item → add an expiry date, which 1Password Watchtower then flags). Date = key creation + 90 days; a key made on 2026-11-17 is due on **2027-02-15**.
- [ ] **Confirm the local tools are installed and unlocked.** Terminal: `op --version`, `op whoami` (sign in via the 1Password app integration), `gitleaks version`, `pre-commit install` in your main checkout.

**Console UI:** workspace, spend limit, rate limits, key creation.
**1Password:** storing the key, expiry/rotation reminder, `op run` check.

## 2. GitHub hygiene

Verified with read-only `gh api` calls on 2026-11-13 against `gayrobot/helpdesk-agent` (public). Nothing was changed. Settings live at GitHub → repo → Settings; change them yourself in the UI.

### Already in place

- [x] **Secret scanning:** enabled.
- [x] **Push protection:** enabled.
- [x] **Branch protection on `main`:** required checks `lint + test` and `gitleaks`, branches must be up to date (strict), force-push off, deletion off, linear history, conversation resolution required, enforced for admins too, stale reviews dismissed.
- [x] **CODEOWNERS:** `.github/CODEOWNERS` assigns `* @gayrobot`; GitHub reports no errors in it.
- [x] **Actions:** default `GITHUB_TOKEN` permission is read-only, and Actions can't approve PRs.
- [x] **Merge settings:** squash only, branches deleted after merge, auto-merge off.

### Missing or worth deciding

- [ ] **Dependabot alerts: off** (`vulnerability-alerts` returns 404). Settings → Code security → Dependabot alerts → Enable. Alerts only; no PRs are opened. Recommended.
- [ ] **Dependabot security updates: off.** Optional. If you turn it on, its PRs still have to respect the exact pins, `uv.lock` and the 7-day cooldown, so review them like any dependency change (section 5).
- [ ] **Require actions pinned to full SHAs: off** (`sha_pinning_required: false`). Settings → Actions → General → "Require actions to be pinned to a full-length commit SHA". The workflows already pin by SHA, so turning it on only enforces what's there. Recommended.
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

### What's known (2026-11-13)

- `damiano.dev` uses Cloudflare nameservers (`bristol`, `merlin`.ns.cloudflare.com) and is proxied by Cloudflare (`server: cloudflare`, Cloudflare anycast IPs). So DNS is on Cloudflare.
- What serves the site behind the proxy (Pages, Workers static assets, or another origin) couldn't be told from outside.
- The Cloudflare plugin in Claude Code isn't authorized yet, so its account tools couldn't be used. To let Claude look up the setup read-only later, authorize it via `/mcp` in a terminal Claude Code session. `wrangler` isn't installed on this machine.

The steps below are generic. Pick the branch that matches what you find in step 1.

### Steps

- [ ] **Find out how the site is served.** Cloudflare dashboard → Workers & Pages. Look for a project bound to `damiano.dev` (Custom domains tab). Note whether it's a Pages project or a Worker, and whether it deploys from a Git repo or by direct upload.
- [ ] **Decide the URL.** A path on the existing site (e.g. `damiano.dev/projects/helpdesk-agent`) is simplest: it goes into the site's own repo and deploys with it, with no DNS change. A subdomain (e.g. `helpdesk-agent.damiano.dev`) needs its own project and a DNS record.
- [ ] **Review the write-up for data.** Real eval numbers and cost are fine. No key, no request IDs you'd rather not publish, no real names, nothing from employers, only `example.test` data in screenshots and transcripts.
- [ ] **Log in to Cloudflare from the CLI**, if deploying from your machine. Terminal, Skylar only: `npx wrangler@<pinned version> login` (opens a browser OAuth flow). Alternatively, create a scoped API token in the dashboard (My Profile → API Tokens, template "Edit Cloudflare Workers", limited to this account and zone) and keep it in 1Password like the Anthropic key.
- [ ] **Preview deploy first.**
  - *Pages, Git-connected:* push the write-up on a branch of the site's repo; Pages builds a preview at `<branch>.<project>.pages.dev`.
  - *Pages, direct upload:* `npx wrangler pages deploy <build-dir> --project-name <project> --branch preview`.
  - *Workers static assets:* `npx wrangler versions upload` gives a preview URL without moving production traffic (needs preview URLs enabled on the Worker).
- [ ] **Check the preview** on desktop and phone: links, images, numbers match `evals/results/`.
- [ ] **Promote to production.**
  - *Pages:* merge to the production branch, or `wrangler pages deploy` with the production branch.
  - *Workers:* `npx wrangler versions deploy` (or `wrangler deploy`).
- [ ] **Route or DNS, subdomain only.** Pages: project → Custom domains → add `helpdesk-agent.damiano.dev` (Cloudflare adds the proxied CNAME). Workers: Settings → Domains & Routes → add a custom domain. A path on the existing site needs neither.
- [ ] **Link the page from the repo README** in a PR once it's live.

Claude may draft the write-up and its build files in a PR, but doesn't run `wrangler`, create Cloudflare resources or deploy.

## 5. Dependency reviews (when a phase adds one)

CLAUDE.md requires a short review before any new dependency. Claude writes the review in the PR; Skylar reads it and decides.

- [ ] **`fastembed` (Phase 4, if it's added).** GitHub PR. Check: maintainer (Qdrant), release history and download numbers, what it pulls in (`onnxruntime`, `tokenizers`, `huggingface-hub`, `numpy` and more), that it's pinned exactly and passes the 7-day cooldown in `uv.lock`. Also check that it **downloads model weights at runtime** from Hugging Face: decide which model and revision is pinned, where it's cached, its license, and that CI either caches it or skips the embeddings test without network. Keep it only if embeddings beat BM25 on the retrieval eval.
- [ ] **Any other new package** (e.g. a BM25 library): same questions, same PR.
- [ ] **Dependabot PRs**, if turned on in section 2: read the changelog, check the version passes the cooldown, merge by hand.

## 6. Ongoing and incident steps

- [ ] **Rotate the key every 90 days** (first due 2027-02-15 if made on 2026-11-17). Console: create a new workspace key. 1Password: replace the `credential` field in the same item, so `.env.tpl` doesn't change. Run the `op run ... echo key present` check and `helpdesk-agent ping`. Console: delete the old key. Move the reminder forward 90 days.
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
