"""The TypeScript port's golden files must match what the Python code produces now."""

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def test_parity_fixtures_are_current():
    result = subprocess.run(  # noqa: S603
        [sys.executable, str(ROOT / "scripts" / "parity_fixtures.py"), "--check"],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr
