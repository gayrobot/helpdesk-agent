"""Append-only JSON-lines audit log for tool calls.

Every record is one line in ``logs/audit.jsonl``. The log never holds secrets; arguments
are synthetic directory values, and long strings are truncated.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

DEFAULT_AUDIT_PATH = Path("logs/audit.jsonl")
MAX_FIELD_CHARS = 300


def _clip(value: Any) -> Any:
    if isinstance(value, str) and len(value) > MAX_FIELD_CHARS:
        return value[:MAX_FIELD_CHARS] + "…[truncated]"
    if isinstance(value, dict):
        return {k: _clip(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_clip(v) for v in value]
    return value


class AuditLog:
    def __init__(self, path: Path = DEFAULT_AUDIT_PATH) -> None:
        self.path = path

    def record(self, event: str, **fields: Any) -> None:
        """Append one record. Raises if the write fails, so callers can fail closed."""
        entry = {"ts": datetime.now(UTC).isoformat(timespec="milliseconds"), "event": event}
        entry.update(_clip(fields))
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(entry, ensure_ascii=False, sort_keys=True) + "\n")
            fh.flush()
