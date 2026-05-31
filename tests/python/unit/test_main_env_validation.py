from __future__ import annotations

import os
import subprocess
import sys


def _run_main(env: dict[str, str]) -> subprocess.CompletedProcess[str]:
    pythonpath = os.path.join(os.getcwd(), "backend", "src")
    return subprocess.run(
        [sys.executable, "-m", "opencode_antigravity"],
        env={
            **env,
            "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
            "PYTHONPATH": pythonpath,
        },
        capture_output=True,
        text=True,
        timeout=5,
        input="",
        check=False,
    )


def test_live_mode_without_api_key_exits_nonzero() -> None:
    proc = _run_main(
        {
            "OAG_BACKEND_MODE": "live",
            "ANTIGRAVITY_MODEL": "gemini-2.5-pro",
        }
    )

    assert proc.returncode != 0
    assert "GEMINI_API_KEY" in proc.stderr


def test_mock_mode_does_not_require_api_key() -> None:
    proc = _run_main(
        {
            "OAG_BACKEND_MODE": "mock",
            "ANTIGRAVITY_MODEL": "gemini-2.5-pro",
        }
    )

    assert proc.returncode == 0
