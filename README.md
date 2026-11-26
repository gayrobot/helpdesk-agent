# helpdesk-agent

A small, governed IT helpdesk agent on the Claude API. It answers IT requests for a fictional company: read-only tools look up users, groups and devices; write tools (reset MFA, add to group) run only after a human approves; retrieval over IT runbooks answers how-to questions; and an eval suite of realistic tickets checks that it picks the right action, refuses or escalates when it should, and never writes without approval.

**All data is synthetic.** No real people, credentials or company data.

**Nothing here acts on a real system.** The tools never call a real identity provider, directory or device manager. `reset_mfa` and `add_to_group` change only an in-memory copy of `src/helpdesk_agent/data/directory.json` (per ticket in the Python agent, per browser session in the Worker). No one's MFA is ever reset and no one is added to a real group. Okta (Phase 8) is used only to sign people in to the demo and issue tokens, never as a target for writes.

The tool descriptions and system prompt deliberately don't say "simulated": they're what the agent was evaluated with, so the model's replies read as if the action happened. The page labels it instead.

Status: Phase 3 built against a mocked client; live calls start when API credits arrive. See [docs/plan.md](docs/plan.md). Manual, owner-only steps are in [docs/operator-checklist.md](docs/operator-checklist.md).

## Governance model

- Read and write tools are separate; unknown tools are rejected.
- Every write needs a human `y`, enforced in code. Privileged groups are denied even with approval.
- Ticket text, runbook text and tool results are treated as data, not instructions.
- Loops are capped and escalate when the cap is hit.
- Every model call and tool call goes to an audit log. Failures fail closed.

## Setup

Requires Python 3.12, [uv](https://docs.astral.sh/uv/), [gitleaks](https://github.com/gitleaks/gitleaks), [pre-commit](https://pre-commit.com/) and the 1Password CLI.

```bash
uv sync                       # add --extra embeddings for local embedding retrieval
pre-commit install
uv run pytest
```

The API key is never stored in the repo. `.env.tpl` holds a 1Password reference, and live commands run through `op run`:

```bash
op run --env-file=.env.tpl -- uv run helpdesk-agent ping
```

```bash
op run --env-file=.env.tpl -- uv run helpdesk-agent run --requester jamie@example.test --ticket "Lost my phone, please reset my MFA"
```

Key-free checks:

```bash
uv run helpdesk-agent eval-retrieval   # recall@3 and MRR per retriever
uv run helpdesk-agent score            # scorer against hand-labelled transcripts
```

The full eval (62 synthetic tickets, every write auto-denied) is live:

```bash
op run --env-file=.env.tpl -- uv run helpdesk-agent eval
```

### Local web page

`serve` runs tickets from a browser page on `http://127.0.0.1:8765/`. Pick a requester (a synthetic user), type a ticket, and watch the reply with its `Source:` runbook line and every tool call with its policy decision. A write shows the same fields as the terminal prompt (tool, arguments, effect, requester, target, and a warning when the requester isn't the target) with **Approve** and **Deny** buttons:

```bash
op run --env-file=.env.tpl -- uv run helpdesk-agent serve
```

It binds to `127.0.0.1` only and runs one ticket at a time. Every rule still runs in the same governance gate; the page only replaces typing `y`. Each proposal has a one-time id, and a write runs only after Approve is clicked on that proposal. A deny, a 5-minute timeout or stopping the server all deny. Approve unlocks only after a proposal has been on screen for a second, so a double-click can't approve a second write. API calls need a per-process token and this page's own origin, so other sites open in the same browser can't drive it. The key stays in the server process. It does not stop another program running as you on this machine, which could read the token from the page; the terminal prompt refused anything but a real keyboard, so stop `serve` when you're not using it. Reloading the page picks up a run that is still waiting for a decision.

Each tool call on the page can be expanded to show the exact result sent back to the model. That text is held in memory only. The audit log never stores results; instead each `tool_call` record has `result_sha256` and `result_bytes`, the SHA-256 and length of that exact text. To prove later what the model saw, rerun the same call (the directory is reloaded fresh for every ticket) and compare:

```bash
uv run python -c "from helpdesk_agent.governance import Gate, deny_all, result_fingerprint as f; from helpdesk_agent.directory import Directory; from helpdesk_agent.audit import AuditLog; from pathlib import Path; o = Gate(Directory.load(), deny_all, AuditLog(Path('/dev/null')), 'CHECK', 'eli.novak@example.test').execute('lookup_user', {'email': 'eli.novak@example.test'}); print(o.content); print(*f(o.content))"
```

### TypeScript and the Cloudflare Worker (Phase 7)

`web/` is the agent rewritten in TypeScript, at parity with the Python one (see the parity bar in [docs/plan.md](docs/plan.md)). The same page runs as a Cloudflare Worker, with one Durable Object per browser session holding that session's copy of the directory, its audit trail and its approval state:

```bash
op run --env-file=.env.tpl -- npm --prefix web run dev:worker
```

It runs locally only, on `http://127.0.0.1:8787/`. Wrangler reads the key from the environment `op run` sets (never a file), and the SDK inside the Worker reads it from there. The launcher turns off the devtools inspector and wrangler's local explorer API. The approval rules are the same as the Python page's. Unlike the Python page, a session keeps its directory changes from one ticket to the next, and if the Worker restarts mid-run, the run is marked interrupted and any waiting write is not made.

Key-free checks: `cd web && npm ci && npm run check`. The TypeScript eval is `op run --env-file=.env.tpl -- npm --prefix web run eval`.

`--dry-run` on the live commands prints what would be sent and needs no key. Each model call is logged to `logs/calls.jsonl` (model, request ID, tokens, cost, latency, stop reason) and each tool call to `logs/audit.jsonl`.

## License

MIT
