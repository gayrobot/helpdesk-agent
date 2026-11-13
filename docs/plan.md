# Plan

Phases run in order. Each one is finished and verified before the next starts.

| Phase | What | Done when |
| --- | --- | --- |
| 1 | Repo setup and secret hygiene: uv + lockfile, exact pins, `.env.tpl` with 1Password references only, gitleaks in pre-commit and CI, GitHub secret scanning and push protection | A fresh clone has no secret in any file, `gitleaks git` passes, CI runs lint + unit tests green |
| 2 | `client.py`: one client (`max_retries=2`, `timeout=60`), model IDs as constants, `max_tokens` always set, one JSON log line per call (time, model, request ID, tokens, cost, latency, stop reason), `--dry-run` | `op run --env-file=.env.tpl -- uv run helpdesk-agent ping` replies and writes one log line with tokens and cost |
| 3 | Agent with governed tools over a synthetic directory: allowlist, human write gate, admin-group deny list, injection-resistant handling of untrusted text, 8-turn loop limit, `logs/audit.jsonl` | "reset MFA for jamie@example.test" looks the user up, proposes the reset, waits for `y`, and logs all of it |
| 4 | 10–15 synthetic runbooks in `runbooks/`, keyword/BM25 search (top 3 chunks), answers cite the runbook | Runbook answers carry a source |
| 5 | Evals: 50–100 synthetic tickets in `evals/tickets.jsonl` (routine, ambiguous, out of scope, social engineering, prompt injection), auto-deny approval stub, deterministic checks first, Haiku grader for free text, results in `evals/results/<date>.json` | One command prints pass rates by category, and a system prompt change shows a measurable difference |
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

## Models

- Agent: `claude-sonnet-5-5`
- Evals and grader while developing: `claude-haiku-5-5`

## Account setup (Skylar, by hand, before Phase 2)

Dedicated Console workspace with its own spend limit, a workspace-scoped key stored only in 1Password at `op://Private/Anthropic helpdesk-agent-dev/credential`, and a 90-day rotation reminder.
