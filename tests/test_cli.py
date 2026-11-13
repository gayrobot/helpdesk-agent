import io
import json

import pytest
from fakes import FakeClient, message, text

from helpdesk_agent import __version__
from helpdesk_agent.cli import main
from helpdesk_agent.governance import deny_all


def _no_client():
    raise AssertionError("a dry run must never build a client")


def test_no_args_prints_help(capsys):
    assert main([]) == 0
    assert "helpdesk-agent" in capsys.readouterr().out


def test_version(capsys):
    with pytest.raises(SystemExit) as exc:
        main(["--version"])
    assert exc.value.code == 0
    assert __version__ in capsys.readouterr().out


def test_ping_dry_run_needs_no_client():
    out = io.StringIO()
    assert main(["ping", "--dry-run"], client_factory=_no_client, out=out) == 0
    request = json.loads(out.getvalue())["request"]
    assert request["model"] == "claude-sonnet-5-5"
    assert request["max_tokens"] > 0


def test_run_dry_run_shows_request_without_sending():
    out = io.StringIO()
    code = main(
        ["run", "--requester", "jamie@example.test", "--ticket", "reset my MFA", "--dry-run"],
        client_factory=_no_client,
        out=out,
    )
    assert code == 0
    shown = json.loads(out.getvalue())
    assert shown["tools"] == sorted(shown["tools"])
    assert "<requester>jamie@example.test</requester>" in shown["first_message"]


def test_run_rejects_bad_requester():
    out = io.StringIO()
    code = main(["run", "--requester", "Jamie@Example.test", "--ticket", "x", "--dry-run"], out=out)
    assert code == 2


def test_ping_live_path_with_fake(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    fake = FakeClient([message([text("pong")], "end_turn")])
    out = io.StringIO()
    assert main(["ping"], client_factory=lambda: fake, out=out) == 0
    assert "pong" in out.getvalue()
    assert (tmp_path / "logs" / "calls.jsonl").exists()


def test_run_live_path_with_fake(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    fake = FakeClient([message([text("Hi! What do you need?")], "end_turn")])
    out = io.StringIO()
    code = main(
        ["run", "--requester", "jamie@example.test", "--ticket", "hello"],
        client_factory=lambda: fake,
        approver=deny_all,
        out=out,
    )
    assert code == 0
    assert "[answered]" in out.getvalue()
