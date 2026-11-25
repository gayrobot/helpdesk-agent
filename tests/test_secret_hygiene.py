"""Guards for the repo's secret-handling rules. These run in CI with no API key."""

from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def _assignments(path: Path) -> list[tuple[str, str]]:
    pairs = []
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        key, _, value = line.partition("=")
        pairs.append((key.strip(), value.strip()))
    return pairs


def test_env_template_holds_only_1password_references():
    pairs = _assignments(ROOT / ".env.tpl")
    assert pairs, ".env.tpl should declare at least ANTHROPIC_API_KEY"
    for key, value in pairs:
        assert value.startswith("op://"), f"{key} in .env.tpl must be an op:// reference"


def test_gitignore_blocks_env_files_and_logs():
    ignored = (ROOT / ".gitignore").read_text().splitlines()
    for pattern in (".env", ".env.*", "!.env.tpl", ".dev.vars", ".dev.vars*", "logs/", "*.jsonl"):
        assert pattern in ignored, f"{pattern!r} missing from .gitignore"


def test_no_real_env_file_is_tracked():
    assert not _tracked(".env")


def test_no_wrangler_secrets_file_is_tracked():
    assert _git("ls-files", "*.dev.vars*") == []


def test_claude_code_is_denied_reading_secret_files():
    import json

    deny = json.loads((ROOT / ".claude" / "settings.json").read_text())["permissions"]["deny"]
    for rule in ("Read(./.env)", "Read(**/.dev.vars)", "Read(**/.dev.vars*)", "Bash(op read:*)"):
        assert rule in deny, f"{rule} missing from .claude/settings.json deny list"


def _tracked(name: str) -> bool:
    import subprocess

    result = subprocess.run(  # noqa: S603
        ["git", "ls-files", "--error-unmatch", name],  # noqa: S607
        cwd=ROOT,
        capture_output=True,
        check=False,
    )
    return result.returncode == 0


def _git(*args: str) -> list[str]:
    import subprocess

    result = subprocess.run(  # noqa: S603
        ["git", *args],  # noqa: S607
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=True,
    )
    return [line for line in result.stdout.splitlines() if line]


def test_no_tracked_file_matches_gitignore():
    # Catches files that were committed before (or despite) an ignore rule,
    # like model weights under .cache/ or logs under logs/.
    assert _git("ls-files", "--cached", "--ignored", "--exclude-standard") == []


def test_no_large_files_are_tracked():
    limit = 1_000_000
    big = [
        p for p in _git("ls-files") if (ROOT / p).is_file() and (ROOT / p).stat().st_size > limit
    ]
    assert big == [], f"tracked files over {limit} bytes: {big}"
