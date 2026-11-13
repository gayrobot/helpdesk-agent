"""Command-line entry point.

    helpdesk-agent ping [--dry-run]
    helpdesk-agent run --requester EMAIL (--ticket TEXT | --ticket-file PATH) [--dry-run]

Live calls need ``ANTHROPIC_API_KEY``, which only ``op run --env-file=.env.tpl`` provides.
``--dry-run`` prints what would be sent and never builds a client, so it needs no key.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, TextIO

from helpdesk_agent import __version__
from helpdesk_agent.agent import Agent, build_first_request
from helpdesk_agent.audit import AuditLog
from helpdesk_agent.client import (
    DEFAULT_CALL_LOG,
    CallLog,
    MessagesClient,
    ModelCaller,
    make_client,
)
from helpdesk_agent.directory import Directory
from helpdesk_agent.governance import EMAIL_RE, Approver, Gate, make_tty_approver

PING_PROMPT = "Reply with the single word: pong"

ClientFactory = Callable[[], MessagesClient]


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="helpdesk-agent",
        description="A governed IT helpdesk agent on the Claude API. Synthetic data only.",
    )
    parser.add_argument("--version", action="version", version=f"%(prog)s {__version__}")
    sub = parser.add_subparsers(dest="command")

    ping = sub.add_parser("ping", help="One tiny model call; logs tokens and cost.")
    ping.add_argument("--dry-run", action="store_true", help="Print the request, don't send.")

    run = sub.add_parser("run", help="Handle one ticket.")
    run.add_argument("--requester", required=True, help="Who filed the ticket (an email).")
    body = run.add_mutually_exclusive_group(required=True)
    body.add_argument("--ticket", help="Ticket text.")
    body.add_argument("--ticket-file", type=Path, help="File holding the ticket text.")
    run.add_argument("--ticket-id", help="Defaults to a timestamp.")
    run.add_argument("--dry-run", action="store_true", help="Print the request, don't send.")
    return parser


def _print_json(data: Any, out: TextIO) -> None:
    out.write(json.dumps(data, indent=2, ensure_ascii=False, default=str) + "\n")


def cmd_ping(args: argparse.Namespace, client_factory: ClientFactory, out: TextIO) -> int:
    messages = [{"role": "user", "content": PING_PROMPT}]
    if args.dry_run:
        caller = ModelCaller(client=None, effort="low")  # type: ignore[arg-type]
        params = caller.request_params(system="", messages=messages)
        _print_json({"dry_run": True, "request": params}, out)
        return 0
    caller = ModelCaller(client_factory(), CallLog(), effort="low")
    response = caller.create(ticket_id="ping", purpose="ping", system="", messages=messages)
    text = " ".join(b.text for b in response.content if getattr(b, "type", "") == "text").strip()
    out.write(f"{response.model}: {text}\n")
    out.write(f"Logged to {DEFAULT_CALL_LOG} (tokens, cost, latency, request ID).\n")
    return 0


def cmd_run(
    args: argparse.Namespace,
    client_factory: ClientFactory,
    approver: Approver,
    out: TextIO,
) -> int:
    if not EMAIL_RE.fullmatch(args.requester):
        out.write("--requester must be a lower-case address like name@example.test\n")
        return 2
    body = args.ticket if args.ticket is not None else args.ticket_file.read_text()
    ticket_id = args.ticket_id or f"T-{datetime.now(UTC):%Y%m%d-%H%M%S}"

    if args.dry_run:
        request = build_first_request(ticket_id, args.requester, body)
        caller = ModelCaller(client=None)  # type: ignore[arg-type]
        params = caller.request_params(**request)
        _print_json(
            {
                "dry_run": True,
                "model": params["model"],
                "max_tokens": params["max_tokens"],
                "output_config": params.get("output_config"),
                "betas": params.get("betas"),
                "tools": [t["name"] for t in params["tools"]],
                "system_chars": len(params["system"]),
                "first_message": params["messages"][0]["content"],
            },
            out,
        )
        return 0

    gate = Gate(
        directory=Directory.load(),
        approver=approver,
        audit=AuditLog(),
        ticket_id=ticket_id,
        requester=args.requester,
    )
    agent = Agent(ModelCaller(client_factory(), CallLog()), gate)
    result = agent.run(body)
    out.write(f"\n[{result.status}] {ticket_id} after {result.tool_turns} tool turn(s)\n\n")
    out.write(result.final_text + "\n")
    return 0 if result.status in ("answered", "escalated") else 1


def main(
    argv: list[str] | None = None,
    *,
    client_factory: ClientFactory = make_client,
    approver: Approver | None = None,
    out: TextIO | None = None,
) -> int:
    out = out or sys.stdout
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.command == "ping":
        return cmd_ping(args, client_factory, out)
    if args.command == "run":
        return cmd_run(args, client_factory, approver or make_tty_approver(), out)
    parser.print_help(out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
