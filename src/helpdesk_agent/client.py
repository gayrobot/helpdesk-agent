"""The one place the Claude API is called.

- One client per process: ``max_retries=2``, ``timeout=60`` seconds.
- Model IDs and prices are constants here, nowhere else.
- ``max_tokens`` is always set.
- Every call, success or failure, writes one JSON line to ``logs/calls.jsonl``: time,
  ticket, model, request ID, tokens, cost, latency, stop reason. Never the prompt, the
  response text or anything from the environment.

The API key is read by the SDK from ``ANTHROPIC_API_KEY``, which only ``op run`` sets.
This module never reads, passes or logs it.
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Protocol

AGENT_MODEL = "claude-sonnet-5-5"
GRADER_MODEL = "claude-haiku-5-5"

MAX_RETRIES = 2
TIMEOUT_SECONDS = 60.0
MAX_TOKENS = 16_000
# Sonnet 5.5 recommends starting multistep tool use at medium effort.
EFFORT = "medium"

# Server-side refusal fallback: if the model declines, the API re-runs the request on a
# fallback model it picks by refusal category, inside the same call.
FALLBACK_BETA = "server-side-fallback-2026-07-01"
FALLBACKS = "default"

DEFAULT_CALL_LOG = Path("logs/calls.jsonl")


@dataclass(frozen=True)
class Price:
    """US dollars per million tokens."""

    input: float
    output: float
    cache_write: float  # 5-minute cache writes: 1.25x input
    cache_read: float
    # Above this many prompt tokens, the long-context rates apply (Haiku 5.5 only).
    long_context_threshold: int | None = None
    long_input: float | None = None
    long_output: float | None = None


# Checked against the published price list on 2026-11-13. Re-check before quoting costs
# in the write-up.
PRICES: dict[str, Price] = {
    "claude-sonnet-5-5": Price(input=2.00, output=10.00, cache_write=2.50, cache_read=0.10),
    # Possible refusal-fallback target for Sonnet 5.5.
    "claude-sonnet-5": Price(input=2.00, output=10.00, cache_write=2.50, cache_read=0.20),
    "claude-haiku-5-5": Price(
        input=0.10,
        output=0.50,
        cache_write=0.125,
        cache_read=0.01,
        long_context_threshold=100_000,
        long_input=0.50,
        long_output=2.50,
    ),
}


def _get(usage: Any, name: str) -> int:
    value = getattr(usage, name, None)
    return int(value) if isinstance(value, int) else 0


def cost_usd(model: str, usage: Any) -> float | None:
    """Cost of one response in US dollars, or None if the model isn't in ``PRICES``."""
    price = PRICES.get(model)
    if price is None or usage is None:
        return None
    fresh = _get(usage, "input_tokens")
    written = _get(usage, "cache_creation_input_tokens")
    read = _get(usage, "cache_read_input_tokens")
    out = _get(usage, "output_tokens")
    input_rate, output_rate = price.input, price.output
    if price.long_context_threshold is not None and (
        fresh + written + read > price.long_context_threshold
    ):
        assert price.long_input is not None and price.long_output is not None  # noqa: S101
        scale = price.long_input / price.input
        input_rate, output_rate = price.long_input, price.long_output
        written_rate, read_rate = price.cache_write * scale, price.cache_read * scale
    else:
        written_rate, read_rate = price.cache_write, price.cache_read
    total = (
        fresh * input_rate + written * written_rate + read * read_rate + out * output_rate
    ) / 1_000_000
    return round(total, 6)


class MessagesClient(Protocol):
    """What we need from ``anthropic.Anthropic``. Tests pass a scripted fake instead."""

    @property
    def beta(self) -> Any: ...


def make_client() -> MessagesClient:
    """The real client. Only called on a live run; unit tests never reach this."""
    import anthropic  # imported here so tests and --dry-run never construct a client

    return anthropic.Anthropic(max_retries=MAX_RETRIES, timeout=TIMEOUT_SECONDS)


class CallLog:
    def __init__(self, path: Path = DEFAULT_CALL_LOG) -> None:
        self.path = path

    def write(self, entry: dict[str, Any]) -> None:
        line = {"ts": datetime.now(UTC).isoformat(timespec="milliseconds"), **entry}
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(line, sort_keys=True) + "\n")


class ModelCaller:
    """Makes Messages API calls with our fixed settings and logs each one."""

    def __init__(
        self,
        client: MessagesClient,
        log: CallLog | None = None,
        model: str = AGENT_MODEL,
        max_tokens: int = MAX_TOKENS,
        effort: str | None = EFFORT,
        fallbacks: bool = True,
    ) -> None:
        self.client = client
        self.log = log or CallLog()
        self.model = model
        self.max_tokens = max_tokens
        self.effort = effort
        self.fallbacks = fallbacks

    def request_params(
        self,
        *,
        system: str,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        params: dict[str, Any] = {
            "model": self.model,
            "max_tokens": self.max_tokens,
            "system": system,
            "messages": messages,
            # Caches tools + system + history up to the last block: the prefix is stable
            # because the tool list is sorted and the system prompt has no timestamps.
            "cache_control": {"type": "ephemeral"},
        }
        if tools:
            params["tools"] = tools
        if self.effort is not None:
            params["output_config"] = {"effort": self.effort}
        if self.fallbacks:
            params["betas"] = [FALLBACK_BETA]
            params["fallbacks"] = FALLBACKS
        return params

    def create(self, *, ticket_id: str, purpose: str, **request: Any) -> Any:
        """Send one request and log it. Re-raises API errors after logging them."""
        params = self.request_params(**request)
        started = time.monotonic()
        try:
            response = self.client.beta.messages.create(**params)
        except Exception as exc:
            self.log.write(
                {
                    "event": "model_call",
                    "ticket_id": ticket_id,
                    "purpose": purpose,
                    "model_requested": self.model,
                    "latency_ms": round((time.monotonic() - started) * 1000),
                    "error": type(exc).__name__,
                    "status_code": getattr(exc, "status_code", None),
                    "request_id": getattr(exc, "request_id", None),
                }
            )
            raise
        latency_ms = round((time.monotonic() - started) * 1000)
        usage = getattr(response, "usage", None)
        served_by = getattr(response, "model", None) or self.model
        stop_details = getattr(response, "stop_details", None)
        self.log.write(
            {
                "event": "model_call",
                "ticket_id": ticket_id,
                "purpose": purpose,
                "model_requested": self.model,
                "model": served_by,
                "request_id": getattr(response, "_request_id", None),
                "input_tokens": _get(usage, "input_tokens"),
                "output_tokens": _get(usage, "output_tokens"),
                "cache_creation_input_tokens": _get(usage, "cache_creation_input_tokens"),
                "cache_read_input_tokens": _get(usage, "cache_read_input_tokens"),
                "cost_usd": cost_usd(served_by, usage),
                "latency_ms": latency_ms,
                "stop_reason": getattr(response, "stop_reason", None),
                "refusal_category": getattr(stop_details, "category", None),
            }
        )
        return response
