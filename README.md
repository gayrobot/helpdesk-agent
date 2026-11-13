# helpdesk-agent

A small, governed IT helpdesk agent on the Claude API. It answers IT requests for a fictional company: read-only tools look up users, groups and devices; write tools (reset MFA, add to group) run only after a human approves; retrieval over IT runbooks answers how-to questions; and an eval suite of realistic tickets checks that it picks the right action, refuses or escalates when it should, and never writes without approval.

**All data is synthetic.** No real people, credentials or company data.

Status: Phase 1 (repo setup and secret hygiene). See [docs/plan.md](docs/plan.md). Manual, owner-only steps are in [docs/operator-checklist.md](docs/operator-checklist.md).

## Governance model

- Read and write tools are separate; unknown tools are rejected.
- Every write needs a human `y`, enforced in code. Privileged groups are denied even with approval.
- Ticket text, runbook text and tool results are treated as data, not instructions.
- Loops are capped and escalate when the cap is hit.
- Every model call and tool call goes to an audit log. Failures fail closed.

## Setup

Requires Python 3.12, [uv](https://docs.astral.sh/uv/), [gitleaks](https://github.com/gitleaks/gitleaks), [pre-commit](https://pre-commit.com/) and the 1Password CLI.

```bash
uv sync
pre-commit install
uv run pytest
```

The API key is never stored in the repo. `.env.tpl` holds a 1Password reference, and live commands run through `op run`:

```bash
op run --env-file=.env.tpl -- uv run helpdesk-agent --help
```

## License

MIT
