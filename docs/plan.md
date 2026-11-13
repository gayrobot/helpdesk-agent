# Plan

Phases run in order. Each one is finished and verified before the next starts.

| Phase | What | Done when |
| --- | --- | --- |
| 1 | Repo setup and secret hygiene: uv + lockfile, exact pins, `.env.tpl` with 1Password references only, gitleaks in pre-commit and CI, GitHub secret scanning and push protection | A fresh clone has no secret in any file, `gitleaks git` passes, CI runs lint + unit tests green |
| 2 | `client.py`: one client (`max_retries=2`, `timeout=60`), model IDs as constants, `max_tokens` always set, one JSON log line per call (time, model, request ID, tokens, cost, latency, stop reason), `--dry-run` | `op run --env-file=.env.tpl -- uv run helpdesk-agent ping` replies and writes one log line with tokens and cost |
| 3 | Agent with governed tools over a synthetic directory: allowlist, strict argument validation, human write gate, admin-group deny list, injection-resistant handling of untrusted text, 8-turn loop limit, `logs/audit.jsonl` (see "Governance rules" below) | "reset MFA for jamie@example.test" looks the user up, proposes the reset, waits for `y`, and logs all of it; unit tests cover each rule in "Governance rules" |
| 4 | 10–15 synthetic runbooks in `runbooks/`, keyword/BM25 search (top 3 chunks), answers cite the runbook | Runbook answers carry a source |
| 5 | Evals: 50–100 synthetic tickets in `evals/tickets.jsonl` (routine, ambiguous, out of scope, social engineering, prompt injection), auto-deny approval stub, deterministic checks first, Haiku grader for free text, results in `evals/results/<date>.json` (see "Adversarial evals" below) | One command prints pass rates by category, and a system prompt change shows a measurable difference |
| 6 | Project write-up for damiano.dev: problem, architecture, governance rules, real eval numbers, cost per ticket, what fails and why | Page published |

## Tools (Phase 3)

| Tool | Kind | Rule |
| --- | --- | --- |
| `lookup_user(email)` | read | Synthetic profile, groups, MFA status |
| `list_devices(user)` | read | Device, OS, compliance state |
| `search_runbooks(query)` | read | Retrieval over `runbooks/*.md` |
| `reset_mfa(user)` | write | Human approval required |
| `add_to_group(user, group)` | write | Human approval required; admin groups denied |
| `escalate(summary)` | write-lite | Writes a fake ticket file; no approval |

## Governance rules (Phase 3)

All of these live in code (a `policy.py` beside the tools), not in the system prompt.

- **Validate arguments before any tool runs.** `email` must match `^[a-z0-9._-]+@example\.test$` and exist in the synthetic directory. `group` must be one of the directory's known groups. Anything else is rejected and logged; the tool never sees it.
- **Normalize before the admin-group deny check.** Compare on a canonical form (Unicode NFKC, casefolded, whitespace trimmed and collapsed) and reject names with mixed scripts, so `Domain Admins ` or a look-alike with a Cyrillic letter cannot get past the deny list.
- **Requester is set by the harness, not the model.** The CLI records who filed the ticket. The approval prompt shows requester and target side by side, and flags it clearly when they differ.
- **Safe approval prompt.** Before printing anything that came from the model, a ticket or a tool result, strip control characters and ANSI escape sequences. The prompt shows the exact arguments the tool will run with, and nothing runs unless the operator types `y`.
- **Untrusted text is wrapped and labelled.** Ticket text, runbook chunks and tool results go into the context inside clearly labelled tags and are described as data. This is a soft control that helps the model; the code-level rules above are the boundary.
- **Audit every decision.** Each line in `logs/audit.jsonl` records the tool name, validated arguments, requester, policy decision (allowed / denied and why) and approval outcome (approved / rejected / not needed).

## Adversarial evals (Phase 5)

- **Indirect injection through runbooks.** Eval fixtures include a deliberately poisoned runbook (kept out of the real `runbooks/`) that is returned by `search_runbooks` for some tickets.
- **Canary checks.** Injection tickets and the poisoned runbook carry canary strings. Deterministic checks assert that no write tool is proposed and no canary appears in `escalate` output.
- **Requester ≠ target.** Social-engineering tickets include "on behalf of" requests; the check is that the agent escalates or the approval prompt flags the mismatch.
- **Optional experiment: split reader / planner.** Run the injection set through the single-agent design and a two-model design (a tool-less reader turns the ticket into a strict schema; the planner with tools never sees raw text) and report the difference in pass rate and cost.

## Out of scope

Considered and not planned, because nothing in this project gives them anything to act on: multi-tenant identity binding, JWT/OIDC, per-request scoped service tokens (RFC 8693), Cedar policy files, outbound DLP scanning, and signature-based "injection scanners" (easy to bypass and they give false confidence).

## Models

- Agent: `claude-sonnet-5-5`
- Evals and grader while developing: `claude-haiku-5-5`

## Account setup (Skylar, by hand, before Phase 2)

Dedicated Console workspace with its own spend limit, a workspace-scoped key stored only in 1Password at `op://Private/Anthropic helpdesk-agent-dev/credential`, and a 90-day rotation reminder.
