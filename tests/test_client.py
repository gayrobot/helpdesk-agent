import json

import anthropic
import pytest
from fakes import FakeClient, message, text

from helpdesk_agent.client import (
    AGENT_MODEL,
    FALLBACK_BETA,
    MAX_RETRIES,
    TIMEOUT_SECONDS,
    CallLog,
    ModelCaller,
    cost_usd,
)


class U:
    def __init__(self, **kw):
        self.__dict__.update(kw)


def test_client_settings():
    assert MAX_RETRIES == 2
    assert TIMEOUT_SECONDS == 60


def test_cost_sonnet():
    usage = U(
        input_tokens=1_000_000,
        output_tokens=100_000,
        cache_creation_input_tokens=0,
        cache_read_input_tokens=1_000_000,
    )
    assert cost_usd("claude-sonnet-5-5", usage) == pytest.approx(2.00 + 1.00 + 0.10)


def test_cost_haiku_long_context_rates():
    short = U(input_tokens=50_000, output_tokens=1_000)
    long = U(input_tokens=200_000, output_tokens=1_000)
    assert cost_usd("claude-haiku-5-5", short) == pytest.approx((50_000 * 0.10 + 500) / 1e6)
    assert cost_usd("claude-haiku-5-5", long) == pytest.approx(
        (200_000 * 0.50 + 1_000 * 2.50) / 1e6
    )


def test_unknown_model_cost_is_none_not_zero():
    assert cost_usd("claude-something-else", U(input_tokens=5, output_tokens=5)) is None


def test_request_always_sets_max_tokens_model_and_fallback(tmp_path):
    fake = FakeClient([message([text("pong")], "end_turn")])
    caller = ModelCaller(fake, CallLog(tmp_path / "calls.jsonl"))
    caller.create(ticket_id="T1", purpose="test", system="s", messages=[])
    sent = fake.requests[0]
    assert sent["model"] == AGENT_MODEL
    assert sent["max_tokens"] > 0
    assert sent["betas"] == [FALLBACK_BETA]
    assert sent["fallbacks"] == "default"
    assert "tool_choice" not in sent  # forced tool use is a 400 on Sonnet 5.5


def test_one_log_line_per_call_with_required_fields(tmp_path):
    log = tmp_path / "calls.jsonl"
    usage = {"input_tokens": 1200, "output_tokens": 80, "cache_read_input_tokens": 3000}
    fake = FakeClient([message([text("pong")], "end_turn", usage=usage)])
    ModelCaller(fake, CallLog(log)).create(
        ticket_id="T1", purpose="test", system="secret system prompt", messages=[]
    )
    lines = log.read_text().splitlines()
    assert len(lines) == 1
    entry = json.loads(lines[0])
    for key in (
        "ts",
        "model",
        "request_id",
        "input_tokens",
        "output_tokens",
        "cost_usd",
        "latency_ms",
        "stop_reason",
    ):
        assert key in entry, key
    assert entry["request_id"] == "req_fake"
    assert entry["cache_read_input_tokens"] == 3000
    assert entry["cost_usd"] == pytest.approx((1200 * 2 + 3000 * 0.10 + 80 * 10) / 1e6)
    assert "secret system prompt" not in lines[0]  # prompts never reach the log


def test_cost_uses_the_model_that_served_the_reply(tmp_path):
    log = tmp_path / "calls.jsonl"
    fake = FakeClient([message([text("ok")], "end_turn", model="claude-sonnet-5")])
    ModelCaller(fake, CallLog(log)).create(ticket_id="T1", purpose="t", system="", messages=[])
    entry = json.loads(log.read_text())
    assert entry["model_requested"] == "claude-sonnet-5-5"
    assert entry["model"] == "claude-sonnet-5"


def test_api_errors_are_logged_then_raised(tmp_path):
    log = tmp_path / "calls.jsonl"
    err = anthropic.APIConnectionError(request=None)  # type: ignore[arg-type]
    fake = FakeClient([err])
    with pytest.raises(anthropic.APIConnectionError):
        ModelCaller(fake, CallLog(log)).create(ticket_id="T1", purpose="t", system="", messages=[])
    entry = json.loads(log.read_text())
    assert entry["error"] == "APIConnectionError"


def test_refusal_category_is_logged(tmp_path):
    log = tmp_path / "calls.jsonl"
    refusal = message(
        [], "refusal", stop_details={"type": "refusal", "category": "cyber", "explanation": None}
    )
    ModelCaller(FakeClient([refusal]), CallLog(log)).create(
        ticket_id="T1", purpose="t", system="", messages=[]
    )
    assert json.loads(log.read_text())["refusal_category"] == "cyber"
