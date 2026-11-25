"""Phase 6: a local web page over the Python agent.

    op run --env-file=.env.tpl -- uv run helpdesk-agent serve [--port 8765]

A viewer, not the product. It runs one ticket at a time through the same ``Agent`` and
``Gate`` as the CLI; the only thing it replaces is how the operator types ``y``. Every
governance rule still runs in ``Gate``, and audit and call logs are written as before.

Rules this module keeps:

- Binds to ``127.0.0.1`` only. There is no option to change it.
- The API key stays in this process (the SDK reads it from the environment). Nothing the
  server sends to the browser comes from the environment.
- A write runs only after an Approve click on that exact proposal: each proposal gets a
  one-time random id, and the approver blocks until a decision for that id arrives. A
  deny, a timeout, a wrong or reused id, or a server shutdown all deny.
- Other web pages in the same browser can send requests to localhost, so every API call
  needs a per-process token in a custom header, every POST must come from this page's
  own origin, and the ``Host`` header must name this server (against DNS rebinding).
- Ticket text, directory fields and tool arguments are untrusted. The page renders them
  as text only, and proposal fields pass through ``tools.display`` first.
- Only routes in ``STATIC_FILES`` and ``/api/...`` exist; nothing serves the filesystem.
"""

from __future__ import annotations

import hmac
import json
import re
import secrets
import sys
import threading
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from importlib import resources
from pathlib import Path
from typing import Any, TextIO

from helpdesk_agent.agent import Agent
from helpdesk_agent.audit import DEFAULT_AUDIT_PATH, AuditLog
from helpdesk_agent.client import CallLog, MessagesClient, ModelCaller
from helpdesk_agent.directory import Directory
from helpdesk_agent.governance import DEFAULT_ESCALATION_DIR, EMAIL_PATTERN, Gate, Proposal
from helpdesk_agent.tools import display

HOST = "127.0.0.1"
DEFAULT_PORT = 8765
APPROVAL_TIMEOUT_SECONDS = 300.0
MAX_BODY_BYTES = 16_384
MAX_TICKET_CHARS = 8_000
MAX_PANEL_CHARS = 300
TOKEN_HEADER = "X-Helpdesk-Token"  # noqa: S105 (a header name, not a secret)

# path -> (file in helpdesk_agent/web, content type)
STATIC_FILES = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/app.js": ("app.js", "text/javascript; charset=utf-8"),
    "/style.css": ("style.css", "text/css; charset=utf-8"),
}

SECURITY_HEADERS = {
    "Content-Security-Policy": (
        "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; "
        "img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
    ),
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
}

_RUN_PATH = re.compile(r"/api/runs/([0-9a-f]{16})\Z")
_DECISION_PATH = re.compile(r"/api/runs/([0-9a-f]{16})/decision\Z")


def _safe(value: Any, limit: int = MAX_PANEL_CHARS) -> str:
    text = display(value)
    return text if len(text) <= limit else text[:limit] + "…"


def _safe_args(args: Any) -> dict[str, str] | str:
    if isinstance(args, dict):
        return {_safe(k, 64): _safe(v) for k, v in args.items()}
    return _safe(args)


# ---------------------------------------------------------------- run state


@dataclass
class PendingApproval:
    id: str
    fields: dict[str, Any]
    event: threading.Event = field(default_factory=threading.Event)
    decision: bool | None = None


@dataclass
class Run:
    id: str
    ticket_id: str
    requester: str
    status: str = "running"  # running | answered | escalated | ... | server_error
    final_text: str = ""
    tool_turns: int = 0
    events: list[dict[str, Any]] = field(default_factory=list)
    pending: PendingApproval | None = None
    lock: threading.Lock = field(default_factory=threading.Lock)

    def snapshot(self) -> dict[str, Any]:
        with self.lock:
            pending = None
            if self.pending is not None and self.pending.decision is None:
                pending = {"id": self.pending.id, **self.pending.fields}
            return {
                "run_id": self.id,
                "ticket_id": self.ticket_id,
                "requester": self.requester,
                "status": self.status,
                "final_text": self.final_text,
                "tool_turns": self.tool_turns,
                "events": list(self.events),
                "pending": pending,
            }


class Busy(Exception):
    """Another ticket is still running."""


class LiveAuditLog(AuditLog):
    """Writes the audit log as usual, then shows the record in the page's tool panel.

    The file write comes first, so if it fails the exception propagates and ``Gate``
    fails closed exactly as it does at the terminal.
    """

    def __init__(self, path: Path, sink: Callable[[str, dict[str, Any]], None]) -> None:
        super().__init__(path)
        self.sink = sink

    def record(self, event: str, **fields: Any) -> None:
        super().record(event, **fields)
        self.sink(event, fields)


class WebState:
    """Everything the HTTP handlers share. One ticket runs at a time."""

    def __init__(
        self,
        client: MessagesClient,
        *,
        port: int = DEFAULT_PORT,
        directory_loader: Callable[[], Directory] = Directory.load,
        audit_path: Path = DEFAULT_AUDIT_PATH,
        call_log: CallLog | None = None,
        escalation_dir: Path = DEFAULT_ESCALATION_DIR,
        approval_timeout: float = APPROVAL_TIMEOUT_SECONDS,
    ) -> None:
        self.client = client
        self.port = port
        self.directory_loader = directory_loader
        self.audit_path = audit_path
        self.call_log = call_log or CallLog()
        self.escalation_dir = escalation_dir
        self.approval_timeout = approval_timeout
        self.token = secrets.token_urlsafe(32)
        self.runs: dict[str, Run] = {}
        self.current: Run | None = None
        self.threads: list[threading.Thread] = []
        self._lock = threading.Lock()
        self._closed = False
        # Read once: the picker shows names and emails only, never other directory fields.
        directory = directory_loader()
        self.requesters = sorted(
            (
                {"email": u["email"], "name": _safe(u.get("name", ""), 80)}
                for u in directory.users.values()
                if EMAIL_PATTERN.match(u["email"])
            ),
            key=lambda u: u["email"],
        )
        self._known = {u["email"] for u in self.requesters}

    # ------------------------------------------------------------ origins

    def allowed_hosts(self) -> set[str]:
        return {f"127.0.0.1:{self.port}", f"localhost:{self.port}"}

    def allowed_origins(self) -> set[str]:
        return {f"http://{h}" for h in self.allowed_hosts()}

    # ------------------------------------------------------------ runs

    def start_run(self, requester: str, body: str) -> Run:
        if not isinstance(requester, str) or requester not in self._known:
            raise ValueError("Pick a requester from the list.")
        if not isinstance(body, str) or not body.strip():
            raise ValueError("Ticket text is empty.")
        if len(body) > MAX_TICKET_CHARS:
            raise ValueError(f"Ticket text is longer than {MAX_TICKET_CHARS} characters.")
        with self._lock:
            if self._closed:
                raise Busy("The server is shutting down.")
            if self.current is not None and self.current.status == "running":
                raise Busy("Another ticket is still running.")
            run = Run(
                id=secrets.token_hex(8),
                ticket_id=f"W-{datetime.now(UTC):%Y%m%d-%H%M%S}",
                requester=requester,
            )
            self.runs[run.id] = run
            self.current = run
        thread = threading.Thread(target=self._work, args=(run, body), daemon=True)
        self.threads.append(thread)
        thread.start()
        return run

    def _work(self, run: Run, body: str) -> None:
        try:
            gate = Gate(
                directory=self.directory_loader(),  # fresh copy per ticket, as in the CLI
                approver=self._approver_for(run),
                audit=LiveAuditLog(self.audit_path, self._sink_for(run)),
                ticket_id=run.ticket_id,
                requester=run.requester,
                escalation_dir=self.escalation_dir,
            )
            result = Agent(ModelCaller(self.client, self.call_log), gate).run(body)
            with run.lock:
                run.final_text = result.final_text
                run.tool_turns = result.tool_turns
                run.status = result.status
        except Exception as exc:
            # The page gets a fixed message; only the exception type goes to stderr.
            sys.stderr.write(f"[serve] run {run.ticket_id} failed: {type(exc).__name__}\n")
            with run.lock:
                run.final_text = "The run failed inside the server. Nothing more was attempted."
                run.status = "server_error"

    def _sink_for(self, run: Run) -> Callable[[str, dict[str, Any]], None]:
        def sink(event: str, fields: dict[str, Any]) -> None:
            if event != "tool_call":
                return
            entry = {
                "tool": _safe(fields.get("tool"), 64),
                "kind": fields.get("kind"),
                "args": _safe_args(fields.get("args")),
                "decision": fields.get("decision"),
                "approval": fields.get("approval"),
                "reason": _safe(fields.get("reason")),
                "is_error": bool(fields.get("is_error")),
            }
            with run.lock:
                run.events.append(entry)

        return sink

    def _approver_for(self, run: Run) -> Callable[[Proposal], bool]:
        def approve(proposal: Proposal) -> bool:
            pending = PendingApproval(
                id=secrets.token_urlsafe(24),
                fields={
                    "tool": _safe(proposal.tool, 64),
                    "args": _safe_args(proposal.args),
                    "effect": _safe(proposal.description),
                    "requester": _safe(proposal.requester),
                    "target": _safe(proposal.target),
                    "requester_is_target": proposal.requester_is_target,
                },
            )
            with run.lock:
                if self._closed:
                    return False
                run.pending = pending
            pending.event.wait(self.approval_timeout)
            with run.lock:
                run.pending = None
                # Only an Approve recorded for this proposal's id counts. No decision
                # (timeout, shutdown) or a Deny both return False.
                return pending.decision is True

        return approve

    def decide(self, run_id: str, proposal_id: Any, approve: bool) -> bool:
        """Record one decision for the pending proposal. False if there is none, the id
        doesn't match, or it was already decided."""
        run = self.runs.get(run_id)
        if run is None or not isinstance(proposal_id, str):
            return False
        with run.lock:
            pending = run.pending
            if pending is None or pending.decision is not None:
                return False
            if not hmac.compare_digest(pending.id.encode(), proposal_id.encode()):
                return False
            pending.decision = approve
            pending.event.set()
            return True

    def shutdown(self) -> None:
        """Deny anything waiting for approval and refuse new runs."""
        with self._lock:
            self._closed = True
            runs = list(self.runs.values())
        for run in runs:
            with run.lock:
                if run.pending is not None and run.pending.decision is None:
                    run.pending.decision = False
                    run.pending.event.set()


# ---------------------------------------------------------------- HTTP


def _static(name: str) -> bytes:
    return resources.files("helpdesk_agent").joinpath("web", name).read_bytes()


def make_handler(state: WebState) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        server_version = "helpdesk-agent"
        sys_version = ""

        def log_message(self, format: str, *args: Any) -> None:
            pass  # request lines aren't needed; the audit and call logs record the work

        # -------------------------------------------------------- responses

        def _send(self, status: int, body: bytes, content_type: str) -> None:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            for key, value in SECURITY_HEADERS.items():
                self.send_header(key, value)
            self.end_headers()
            self.wfile.write(body)

        def _json(self, status: int, data: Any) -> None:
            body = json.dumps(data, ensure_ascii=False).encode()
            self._send(status, body, "application/json; charset=utf-8")

        def _error(self, status: int, message: str) -> None:
            self._json(status, {"error": message})

        # -------------------------------------------------------- checks

        def _host_ok(self) -> bool:
            return self.headers.get("Host", "") in state.allowed_hosts()

        def _token_ok(self) -> bool:
            sent = self.headers.get(TOKEN_HEADER, "")
            return hmac.compare_digest(sent.encode(), state.token.encode())

        def _origin_ok(self) -> bool:
            return self.headers.get("Origin", "") in state.allowed_origins()

        def _read_json(self) -> Any:
            ctype = self.headers.get("Content-Type", "").split(";")[0].strip().lower()
            if ctype != "application/json":
                raise ValueError("Content-Type must be application/json.")
            try:
                length = int(self.headers.get("Content-Length", ""))
            except ValueError:
                raise ValueError("Content-Length is required.") from None
            if length < 0 or length > MAX_BODY_BYTES:
                raise ValueError("Request body is too large.")
            try:
                return json.loads(self.rfile.read(length))
            except (UnicodeDecodeError, json.JSONDecodeError):
                raise ValueError("Request body is not valid JSON.") from None

        # -------------------------------------------------------- verbs

        def do_GET(self) -> None:
            if not self._host_ok():
                return self._error(HTTPStatus.FORBIDDEN, "Bad Host header.")
            path = self.path.split("?", 1)[0]
            if path in STATIC_FILES:
                name, ctype = STATIC_FILES[path]
                body = _static(name)
                if name == "index.html":
                    body = body.replace(b"__TOKEN__", state.token.encode())
                return self._send(HTTPStatus.OK, body, ctype)
            if not path.startswith("/api/"):
                return self._error(HTTPStatus.NOT_FOUND, "Not found.")
            if not self._token_ok():
                return self._error(HTTPStatus.FORBIDDEN, "Missing or wrong token.")
            if path == "/api/requesters":
                return self._json(HTTPStatus.OK, {"requesters": state.requesters})
            match = _RUN_PATH.match(path)
            if match and match.group(1) in state.runs:
                return self._json(HTTPStatus.OK, state.runs[match.group(1)].snapshot())
            return self._error(HTTPStatus.NOT_FOUND, "Not found.")

        def do_POST(self) -> None:
            if not (self._host_ok() and self._origin_ok() and self._token_ok()):
                return self._error(HTTPStatus.FORBIDDEN, "Request not from this page.")
            try:
                data = self._read_json()
            except ValueError as exc:
                return self._error(HTTPStatus.BAD_REQUEST, str(exc))
            if not isinstance(data, dict):
                return self._error(HTTPStatus.BAD_REQUEST, "Expected a JSON object.")
            path = self.path.split("?", 1)[0]

            if path == "/api/runs":
                try:
                    run = state.start_run(data.get("requester"), data.get("ticket"))
                except ValueError as exc:
                    return self._error(HTTPStatus.BAD_REQUEST, str(exc))
                except Busy as exc:
                    return self._error(HTTPStatus.CONFLICT, str(exc))
                return self._json(HTTPStatus.ACCEPTED, {"run_id": run.id})

            match = _DECISION_PATH.match(path)
            if match:
                choice = data.get("decision")
                if choice not in ("approve", "deny"):
                    return self._error(HTTPStatus.BAD_REQUEST, "decision is approve or deny.")
                ok = state.decide(match.group(1), data.get("proposal_id"), choice == "approve")
                if not ok:
                    return self._error(HTTPStatus.CONFLICT, "No such pending proposal.")
                return self._json(HTTPStatus.OK, {"recorded": choice})

            return self._error(HTTPStatus.NOT_FOUND, "Not found.")

        def do_PUT(self) -> None:
            self._error(HTTPStatus.METHOD_NOT_ALLOWED, "Method not allowed.")

        do_DELETE = do_PATCH = do_OPTIONS = do_PUT

    return Handler


def make_server(state: WebState, port: int) -> ThreadingHTTPServer:
    """Bind to 127.0.0.1. ``port=0`` picks a free port (tests); ``state.port`` is updated
    so the Host and Origin checks match the real one."""
    server = ThreadingHTTPServer((HOST, port), make_handler(state))
    server.daemon_threads = True
    state.port = server.server_address[1]
    return server


def serve(client: MessagesClient, port: int = DEFAULT_PORT, out: TextIO | None = None) -> int:
    out = out or sys.stdout
    state = WebState(client, port=port)
    server = make_server(state, port)
    out.write(
        f"Serving on http://{HOST}:{state.port}/  (local only; Ctrl-C to stop)\n"
        "Writes run only after you click Approve on that proposal.\n"
    )
    out.flush()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        state.shutdown()
        server.server_close()
    out.write("Stopped.\n")
    return 0
