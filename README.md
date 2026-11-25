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

It binds to `127.0.0.1` only and runs one ticket at a time. Every rule still runs in the same governance gate; the page only replaces typing `y`. Each proposal has a one-time id, and a write runs only after Approve is clicked on that proposal. A deny, a 5-minute timeout or stopping the server all deny. API calls need a per-process token and this page's own origin, so other sites open in the same browser can't drive it. The key stays in the server process.

`--dry-run` on the live commands prints what would be sent and needs no key. Each model call is logged to `logs/calls.jsonl` (model, request ID, tokens, cost, latency, stop reason) and each tool call to `logs/audit.jsonl`.

## License

MIT
