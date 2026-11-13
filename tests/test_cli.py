import pytest

from helpdesk_agent import __version__
from helpdesk_agent.cli import main


def test_no_args_prints_help(capsys):
    assert main([]) == 0
    assert "helpdesk-agent" in capsys.readouterr().out


def test_version(capsys):
    with pytest.raises(SystemExit) as exc:
        main(["--version"])
    assert exc.value.code == 0
    assert __version__ in capsys.readouterr().out
