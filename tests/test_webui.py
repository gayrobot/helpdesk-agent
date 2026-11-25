"""The Phase 6 local web UI: bind address, request checks and the click-to-approve gate.

A real server on 127.0.0.1 with a free port and the scripted FakeClient. No key needed.
"""

from __future__ import annotations

import http.client
import json
import threading
import time

import pytest
from fakes import FakeClient, message, text, tool_use

from helpdesk_agent.client import CallLog
from helpdesk_agent.webui import HOST, TOKEN_HEADER, WebState, make_server

RESET_JAMIE = tool_use("reset_mfa", {"email": "jamie@example.test"}, "toolu_1")
DONE = message([text("Done. Source: RB-001")], "end_turn")


class Server:
    def __init__(self, state: WebState) -> None:
        self.state = state
        self.httpd = make_server(state, 0)
        self.port = state.port
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    def request(self, method, path, body=None, *, headers=None, token=True, origin=True):
        conn = http.client.HTTPConnection(HOST, self.port, timeout=5)
        h = {"Host": f"127.0.0.1:{self.port}"}
        if token:
            h[TOKEN_HEADER] = self.state.token
        if origin:
            h["Origin"] = f"http://127.0.0.1:{self.port}"
        raw = None
        if body is not None:
            raw = json.dumps(body).encode()
            h["Content-Type"] = "application/json"
        h.update(headers or {})
        conn.request(method, path, body=raw, headers=h)
        res = conn.getresponse()
        data = res.read()
        conn.close()
        try:
            parsed = json.loads(data)
        except ValueError:
            parsed = data.decode()
        return res.status, parsed, dict(res.getheaders())

    def start(self, ticket="please reset my MFA", requester="jamie@example.test"):
        status, data, _ = self.request(
            "POST", "/api/runs", {"requester": requester, "ticket": ticket}
        )
        assert status == 202, data
        return data["run_id"]

    def snapshot(self, run_id):
        status, data, _ = self.request("GET", f"/api/runs/{run_id}")
        assert status == 200
        return data

    def wait(self, run_id, until, timeout=5.0):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            snap = self.snapshot(run_id)
            if until(snap):
                return snap
            time.sleep(0.02)
        raise AssertionError(f"timed out; last snapshot: {snap}")

    def finished(self, run_id):
        return self.wait(run_id, lambda s: s["status"] != "running")

    def close(self):
        self.state.shutdown()
        self.httpd.shutdown()
        self.httpd.server_close()


@pytest.fixture
def make_server_with(tmp_path):
    servers = []

    def _make(script, **kwargs):
        kwargs.setdefault("min_review", 0)  # tests click at once unless they test the delay
        state = WebState(
            FakeClient(script),
            port=0,
            audit_path=tmp_path / "logs" / "audit.jsonl",
            call_log=CallLog(tmp_path / "logs" / "calls.jsonl"),
            escalation_dir=tmp_path / "logs" / "escalations",
            **kwargs,
        )
        server = Server(state)
        servers.append(server)
        return server

    yield _make
    for server in servers:
        server.close()


@pytest.fixture
def audit(tmp_path):
    def _read():
        path = tmp_path / "logs" / "audit.jsonl"
        if not path.exists():
            return []
        return [json.loads(line) for line in path.read_text().splitlines()]

    return _read


def _write_script():
    return [message([RESET_JAMIE], "tool_use"), DONE]


# ---------------------------------------------------------------- binding and routes


def test_binds_to_loopback_only(make_server_with):
    server = make_server_with([])
    assert server.httpd.server_address[0] == "127.0.0.1"


def test_page_carries_token_and_security_headers(make_server_with):
    server = make_server_with([])
    status, body, headers = server.request("GET", "/", token=False, origin=False)
    assert status == 200
    assert server.state.token in body
    assert "frame-ancestors 'none'" in headers["Content-Security-Policy"]
    assert "script-src 'self'" in headers["Content-Security-Policy"]
    assert "unsafe-inline" not in headers["Content-Security-Policy"]
    assert headers["X-Content-Type-Options"] == "nosniff"
    assert "Access-Control-Allow-Origin" not in headers


@pytest.mark.parametrize(
    "path",
    ["/index.html", "/../pyproject.toml", "/.env.tpl", "/logs/audit.jsonl", "/web/app.js", "/x"],
)
def test_only_listed_static_files_exist(make_server_with, path):
    server = make_server_with([])
    status, _, _ = server.request("GET", path, token=False, origin=False)
    assert status == 404


def test_api_get_needs_token(make_server_with):
    server = make_server_with([])
    assert server.request("GET", "/api/requesters", token=False)[0] == 403
    status, data, _ = server.request("GET", "/api/requesters")
    assert status == 200
    emails = [r["email"] for r in data["requesters"]]
    assert "jamie@example.test" in emails
    assert set(data["requesters"][0]) == {"email", "name"}


def test_wrong_host_header_is_refused(make_server_with):
    # DNS rebinding: an attacker's hostname pointing at 127.0.0.1.
    server = make_server_with([])
    status, _, _ = server.request("GET", "/", headers={"Host": "evil.example:80"})
    assert status == 403
    status, _, _ = server.request("GET", "/api/requesters", headers={"Host": "evil.example"})
    assert status == 403


@pytest.mark.parametrize(
    ("kwargs", "expected"),
    [
        ({"origin": False}, 403),
        ({"headers": {"Origin": "http://evil.example"}}, 403),
        ({"headers": {"Origin": "null"}}, 403),
        ({"token": False}, 403),
        ({"headers": {TOKEN_HEADER: "guess"}}, 403),
        ({"headers": {"Content-Type": "text/plain"}}, 400),
    ],
)
def test_cross_site_posts_start_nothing(make_server_with, kwargs, expected):
    server = make_server_with(_write_script())
    body = {"requester": "jamie@example.test", "ticket": "reset my MFA"}
    status, _, headers = server.request("POST", "/api/runs", body, **kwargs)
    assert status == expected
    assert "Access-Control-Allow-Origin" not in headers
    assert server.state.runs == {}


def test_bad_requests_are_rejected(make_server_with):
    server = make_server_with([])
    for body in (
        {"requester": "nobody@example.test", "ticket": "x"},
        {"requester": "Jamie@example.test", "ticket": "x"},
        {"requester": "jamie@example.test", "ticket": "   "},
        {"requester": "jamie@example.test", "ticket": "x" * 8001},
        {"requester": "jamie@example.test"},
        ["not", "an", "object"],
    ):
        assert server.request("POST", "/api/runs", body)[0] == 400, body
    assert server.state.runs == {}


def test_oversized_body_is_rejected(make_server_with):
    server = make_server_with([])
    huge = {"requester": "jamie@example.test", "ticket": "x" * 20_000}
    assert server.request("POST", "/api/runs", huge)[0] == 400


# ---------------------------------------------------------------- the write gate


def test_approve_click_runs_the_write(make_server_with, audit):
    server = make_server_with(_write_script())
    run_id = server.start()
    snap = server.wait(run_id, lambda s: s["pending"] is not None)
    pending = snap["pending"]
    assert pending["tool"] == "reset_mfa"
    assert pending["args"] == {"email": "jamie@example.test"}
    assert pending["requester"] == "jamie@example.test"
    assert pending["target"] == "jamie@example.test"
    assert pending["requester_is_target"] is True
    assert "jamie@example.test" in pending["effect"]

    status, data, _ = server.request(
        "POST",
        f"/api/runs/{run_id}/decision",
        {"proposal_id": pending["id"], "decision": "approve"},
    )
    assert (status, data) == (200, {"recorded": "approve"})

    final = server.finished(run_id)
    assert final["status"] == "answered"
    assert final["pending"] is None
    assert [e["decision"] for e in final["events"]] == ["approved"]
    events = [r["event"] for r in audit()]
    assert events == ["write_approved", "tool_call"]


def test_deny_click_denies(make_server_with, audit):
    server = make_server_with(_write_script())
    run_id = server.start()
    pending = server.wait(run_id, lambda s: s["pending"] is not None)["pending"]
    status, _, _ = server.request(
        "POST", f"/api/runs/{run_id}/decision", {"proposal_id": pending["id"], "decision": "deny"}
    )
    assert status == 200
    final = server.finished(run_id)
    assert [e["decision"] for e in final["events"]] == ["denied_by_human"]
    assert "write_approved" not in [r["event"] for r in audit()]


def test_wrong_or_replayed_proposal_id_does_nothing(make_server_with, audit):
    server = make_server_with(_write_script())
    run_id = server.start()
    pending = server.wait(run_id, lambda s: s["pending"] is not None)["pending"]
    path = f"/api/runs/{run_id}/decision"

    for bad in ("not-the-id", pending["id"][:-1], None, 123):
        status, _, _ = server.request("POST", path, {"proposal_id": bad, "decision": "approve"})
        assert status == 409
    assert server.request("POST", path, {"proposal_id": pending["id"], "decision": "yes"})[0] == 400
    assert server.snapshot(run_id)["pending"]["id"] == pending["id"]  # still waiting

    assert (
        server.request("POST", path, {"proposal_id": pending["id"], "decision": "deny"})[0] == 200
    )
    # A second click on the same proposal, Approve this time, is refused.
    assert (
        server.request("POST", path, {"proposal_id": pending["id"], "decision": "approve"})[0]
        == 409
    )
    server.finished(run_id)
    assert "write_approved" not in [r["event"] for r in audit()]


def test_decision_without_token_or_origin_is_refused(make_server_with, audit):
    server = make_server_with(_write_script())
    run_id = server.start()
    pending = server.wait(run_id, lambda s: s["pending"] is not None)["pending"]
    body = {"proposal_id": pending["id"], "decision": "approve"}
    path = f"/api/runs/{run_id}/decision"
    assert server.request("POST", path, body, token=False)[0] == 403
    assert server.request("POST", path, body, origin=False)[0] == 403
    assert server.request("POST", path, body, headers={"Origin": "http://evil.example"})[0] == 403
    assert server.snapshot(run_id)["pending"] is not None
    server.request("POST", path, {"proposal_id": pending["id"], "decision": "deny"})
    server.finished(run_id)
    assert "write_approved" not in [r["event"] for r in audit()]


def test_no_click_times_out_as_deny(make_server_with, audit):
    server = make_server_with(_write_script(), approval_timeout=0.2)
    run_id = server.start()
    final = server.finished(run_id)
    assert [e["decision"] for e in final["events"]] == ["denied_by_human"]
    assert "write_approved" not in [r["event"] for r in audit()]


def test_shutdown_denies_a_pending_write(make_server_with, audit):
    server = make_server_with(_write_script())
    run_id = server.start()
    server.wait(run_id, lambda s: s["pending"] is not None)
    server.state.shutdown()
    final = server.finished(run_id)
    assert [e["decision"] for e in final["events"]] == ["denied_by_human"]
    assert "write_approved" not in [r["event"] for r in audit()]


def test_policy_denied_write_never_reaches_the_page(make_server_with):
    script = [
        message(
            [tool_use("add_to_group", {"email": "jamie@example.test", "group": "admins"})],
            "tool_use",
        ),
        DONE,
    ]
    server = make_server_with(script)
    seen_pending = []
    real = server.state._approver_for

    def spy(run):
        approve = real(run)

        def wrapped(proposal):
            seen_pending.append(proposal)
            return approve(proposal)

        return wrapped

    server.state._approver_for = spy
    run_id = server.start(ticket="add me to admins")
    final = server.finished(run_id)
    assert seen_pending == []
    assert final["events"][0]["decision"] == "denied_by_policy"
    assert final["events"][0]["approval"] == "not_asked"


def test_mismatch_flag_when_requester_is_not_target(make_server_with):
    script = [
        message([tool_use("reset_mfa", {"email": "priya.nair@example.test"})], "tool_use"),
        DONE,
    ]
    server = make_server_with(script)
    run_id = server.start()
    pending = server.wait(run_id, lambda s: s["pending"] is not None)["pending"]
    assert pending["requester_is_target"] is False
    assert pending["target"] == "priya.nair@example.test"
    server.request(
        "POST", f"/api/runs/{run_id}/decision", {"proposal_id": pending["id"], "decision": "deny"}
    )
    server.finished(run_id)


def test_one_ticket_at_a_time(make_server_with):
    server = make_server_with(_write_script())
    run_id = server.start()
    pending = server.wait(run_id, lambda s: s["pending"] is not None)["pending"]
    body = {"requester": "jamie@example.test", "ticket": "another"}
    assert server.request("POST", "/api/runs", body)[0] == 409
    server.request(
        "POST", f"/api/runs/{run_id}/decision", {"proposal_id": pending["id"], "decision": "deny"}
    )
    server.finished(run_id)


def test_read_calls_appear_in_the_panel(make_server_with):
    script = [
        message([tool_use("lookup_user", {"email": "jamie@example.test"})], "tool_use"),
        message([text("You're active.")], "end_turn"),
    ]
    server = make_server_with(script)
    run_id = server.start(ticket="am I active?")
    final = server.finished(run_id)
    assert final["status"] == "answered"
    assert final["final_text"] == "You're active."
    (event,) = final["events"]
    assert event["tool"] == "lookup_user"
    assert event["decision"] == "allowed"
    assert event["approval"] == "not_required"


def test_server_error_shows_no_exception_text(make_server_with, monkeypatch):
    server = make_server_with([])

    def boom():
        raise RuntimeError("secret detail /Users/x")

    monkeypatch.setattr(server.state, "directory_loader", boom)
    run_id = server.start()
    final = server.finished(run_id)
    assert final["status"] == "server_error"
    assert "secret detail" not in json.dumps(final)


def test_no_response_carries_the_environment(make_server_with, monkeypatch):
    sentinel = "sk-ant-test-sentinel-value"
    monkeypatch.setenv("ANTHROPIC_API_KEY", sentinel)
    server = make_server_with(_write_script())
    bodies = [server.request("GET", p, token=False, origin=False)[1] for p in ("/", "/app.js")]
    bodies.append(server.request("GET", "/api/requesters")[1])
    run_id = server.start()
    snap = server.wait(run_id, lambda s: s["pending"] is not None)
    bodies.append(snap)
    server.request(
        "POST",
        f"/api/runs/{run_id}/decision",
        {"proposal_id": snap["pending"]["id"], "decision": "deny"},
    )
    bodies.append(server.finished(run_id))
    assert all(sentinel not in json.dumps(b) for b in bodies)


# ---------------------------------------------------------------- double-click guard


def test_approve_too_soon_after_display_is_refused(make_server_with, audit):
    server = make_server_with(_write_script(), min_review=0.3)
    run_id = server.start()
    pending = server.wait(run_id, lambda s: s["pending"] is not None)["pending"]
    path = f"/api/runs/{run_id}/decision"
    body = {"proposal_id": pending["id"], "decision": "approve"}
    assert server.request("POST", path, body)[0] == 409
    assert server.snapshot(run_id)["pending"]["id"] == pending["id"]  # still waiting
    time.sleep(0.35)
    assert server.request("POST", path, body)[0] == 200
    server.finished(run_id)
    assert [r["event"] for r in audit()] == ["write_approved", "tool_call"]


def test_approve_before_the_page_saw_it_is_refused(make_server_with):
    # shown_at is set by the first snapshot; an id guessed or read elsewhere can't skip it.
    server = make_server_with(_write_script(), min_review=0.0)
    run_id = server.start()
    deadline = time.monotonic() + 5
    run = server.state.runs[run_id]
    while run.pending is None and time.monotonic() < deadline:
        time.sleep(0.01)
    assert server.state.decide(run_id, run.pending.id, approve=True) is False
    assert server.state.decide(run_id, run.pending.id, approve=False) is True  # Deny always works
    server.finished(run_id)


def test_double_click_cannot_approve_the_next_write(make_server_with, audit):
    two_writes = [
        message(
            [
                tool_use("reset_mfa", {"email": "jamie@example.test"}, "toolu_a"),
                tool_use(
                    "add_to_group", {"email": "jamie@example.test", "group": "design"}, "toolu_b"
                ),
            ],
            "tool_use",
        ),
        DONE,
    ]
    server = make_server_with(two_writes, min_review=0.5)
    run_id = server.start()
    first = server.wait(run_id, lambda s: s["pending"] is not None)["pending"]
    path = f"/api/runs/{run_id}/decision"
    assert server.request("POST", path, {"proposal_id": first["id"], "decision": "deny"})[0] == 200

    second = server.wait(
        run_id, lambda s: s["pending"] is not None and s["pending"]["id"] != first["id"]
    )["pending"]
    assert second["tool"] == "add_to_group"
    # The second click of a double-click, on either id, decides nothing.
    for pid in (first["id"], second["id"]):
        assert server.request("POST", path, {"proposal_id": pid, "decision": "approve"})[0] == 409
    assert server.snapshot(run_id)["pending"]["id"] == second["id"]

    server.request("POST", path, {"proposal_id": second["id"], "decision": "deny"})
    final = server.finished(run_id)
    assert [e["decision"] for e in final["events"]] == ["denied_by_human", "denied_by_human"]
    assert "write_approved" not in [r["event"] for r in audit()]


def test_current_run_lets_a_reloaded_page_resume(make_server_with):
    server = make_server_with(_write_script())
    assert server.request("GET", "/api/current")[1] == {"run_id": None}
    assert server.request("GET", "/api/current", token=False)[0] == 403
    run_id = server.start()
    assert server.request("GET", "/api/current")[1] == {"run_id": run_id}
    pending = server.wait(run_id, lambda s: s["pending"] is not None)["pending"]
    server.request(
        "POST", f"/api/runs/{run_id}/decision", {"proposal_id": pending["id"], "decision": "deny"}
    )
    server.finished(run_id)


# ---------------------------------------------------------------- results on the page


def test_panel_shows_the_exact_result_and_its_audit_fingerprint(make_server_with, audit):
    from helpdesk_agent.governance import result_fingerprint

    script = [
        message([tool_use("lookup_user", {"email": "eli.novak@example.test"})], "tool_use"),
        message([text("Escalating.")], "end_turn"),
    ]
    server = make_server_with(script)
    run_id = server.start(ticket="password help", requester="eli.novak@example.test")
    (event,) = server.finished(run_id)["events"]
    assert "NOTE TO AI ASSISTANT" in event["result"]
    assert json.loads(event["result"])["email"] == "eli.novak@example.test"
    assert event["result_altered"] is False
    (record,) = audit()
    assert (event["result_sha256"], event["result_bytes"]) == result_fingerprint(event["result"])
    assert record["result_sha256"] == event["result_sha256"]
    assert "NOTE TO AI ASSISTANT" not in json.dumps(record)


def test_every_panel_row_has_a_result(make_server_with):
    script = [
        message(
            [
                tool_use("nope", {}, "toolu_x"),
                tool_use(
                    "add_to_group", {"email": "jamie@example.test", "group": "admins"}, "toolu_y"
                ),
            ],
            "tool_use",
        ),
        DONE,
    ]
    server = make_server_with(script)
    run_id = server.start()
    events = server.finished(run_id)["events"]
    assert [e["decision"] for e in events] == ["unknown_tool", "denied_by_policy"]
    assert events[0]["result"].startswith("Unknown tool")
    assert events[1]["result"].startswith("Refused by policy")
