# helpdesk-agent

A small, governed IT helpdesk agent on the Claude API. It answers IT requests for a fictional company: read-only tools look up users, groups and devices; write tools (reset MFA, add to group) run only after a human approves; retrieval over IT runbooks answers how-to questions; and an eval suite of realistic tickets checks that it picks the right action, refuses or escalates when it should, and never writes without approval.

**All data is synthetic.** No real people, credentials or company data.

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

`--dry-run` on the live commands prints what would be sent and needs no key. Each model call is logged to `logs/calls.jsonl` (model, request ID, tokens, cost, latency, stop reason) and each tool call to `logs/audit.jsonl`.

## License

MIT
