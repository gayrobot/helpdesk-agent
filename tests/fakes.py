"""A scripted stand-in for ``anthropic.Anthropic``. No network, no key.

Each scripted turn is a list of content blocks plus a stop reason. Responses are real SDK
``BetaMessage`` objects, so the agent loop handles exactly the types it gets live.
"""

from __future__ import annotations

import copy
from typing import Any

from anthropic.types.beta import BetaMessage


def text(value: str) -> dict[str, Any]:
    return {"type": "text", "text": value}


def tool_use(name: str, args: dict[str, Any], id_: str | None = None) -> dict[str, Any]:
    return {"type": "tool_use", "id": id_ or f"toolu_{name}", "name": name, "input": args}


def thinking(value: str = "") -> dict[str, Any]:
    return {"type": "thinking", "thinking": value, "signature": "sig-fake"}


def message(
    content: list[dict[str, Any]],
    stop_reason: str,
    *,
    model: str = "claude-sonnet-5-5",
    usage: dict[str, int] | None = None,
    stop_details: dict[str, Any] | None = None,
) -> BetaMessage:
    msg = BetaMessage.model_validate(
        {
            "id": "msg_fake",
            "type": "message",
            "role": "assistant",
            "model": model,
            "content": content,
            "stop_reason": stop_reason,
            "stop_sequence": None,
            "stop_details": stop_details,
            "usage": usage or {"input_tokens": 1000, "output_tokens": 100},
        }
    )
    msg._request_id = "req_fake"
    return msg


class _Messages:
    def __init__(self, owner: FakeClient) -> None:
        self.owner = owner

    def create(self, **params: Any) -> BetaMessage:
        # Snapshot the request: the agent keeps appending to the same messages list.
        self.owner.requests.append(copy.deepcopy(params))
        if not self.owner.script:
            raise AssertionError("FakeClient ran out of scripted responses")
        item = self.owner.script.pop(0)
        if isinstance(item, Exception):
            raise item
        return item


class _Beta:
    def __init__(self, owner: FakeClient) -> None:
        self.messages = _Messages(owner)


class FakeClient:
    def __init__(self, script: list[BetaMessage | Exception]) -> None:
        self.script = list(script)
        self.requests: list[dict[str, Any]] = []
        self.beta = _Beta(self)
