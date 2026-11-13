import json

import pytest

from helpdesk_agent.audit import AuditLog
from helpdesk_agent.directory import Directory
from helpdesk_agent.governance import Gate, deny_all


class RecordingApprover:
    """Test approver: returns a fixed answer and remembers every proposal it saw."""

    def __init__(self, answer: bool) -> None:
        self.answer = answer
        self.proposals = []

    def __call__(self, proposal):
        self.proposals.append(proposal)
        return self.answer


@pytest.fixture
def directory():
    return Directory.load()


@pytest.fixture
def audit_path(tmp_path):
    return tmp_path / "logs" / "audit.jsonl"


@pytest.fixture
def make_gate(directory, audit_path, tmp_path):
    def _make(approver=deny_all, requester="jamie@example.test"):
        return Gate(
            directory=directory,
            approver=approver,
            audit=AuditLog(audit_path),
            ticket_id="T-TEST",
            requester=requester,
            escalation_dir=tmp_path / "logs" / "escalations",
        )

    return _make


@pytest.fixture
def read_audit(audit_path):
    def _read():
        if not audit_path.exists():
            return []
        return [json.loads(line) for line in audit_path.read_text().splitlines()]

    return _read
