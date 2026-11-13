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
    for pattern in (".env", ".env.*", "!.env.tpl", "logs/", "*.jsonl"):
        assert pattern in ignored, f"{pattern!r} missing from .gitignore"


def test_no_real_env_file_is_tracked():
    assert not _tracked(".env")


def _tracked(name: str) -> bool:
    import subprocess

    result = subprocess.run(  # noqa: S603
        ["git", "ls-files", "--error-unmatch", name],  # noqa: S607
        cwd=ROOT,
        capture_output=True,
        check=False,
    )
    return result.returncode == 0
