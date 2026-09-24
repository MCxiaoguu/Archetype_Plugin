#!/usr/bin/env python3
"""Tests for scripts/session-hook.py. Run: python3 scripts/test_session_hook.py

Stdlib-only, same conventions as test_core_server.py.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

HOOK = Path(__file__).resolve().parent / "session-hook.py"


def run_hook(data_dir: str | None) -> tuple[int, str]:
    env = {k: v for k, v in os.environ.items() if k != "CLAUDE_PLUGIN_DATA"}
    if data_dir is not None:
        env["CLAUDE_PLUGIN_DATA"] = data_dir
    proc = subprocess.run(
        [sys.executable, str(HOOK)], env=env, capture_output=True, text=True, timeout=10
    )
    return proc.returncode, proc.stdout.strip()


def main() -> int:
    now = int(time.time())
    cases = [
        ("no auth.json", None, "not connected"),
        ("unreadable auth.json", "not json", "unreadable"),
        ("no access token", {"token_type": "Bearer"}, "not connected"),
        ("expired", {"access_token": "t", "saved_at": now - 90000, "expires_in": 86400}, "has expired"),
        ("expiring soon", {"access_token": "t", "saved_at": now - 86000, "expires_in": 86400}, "expires in about"),
        ("valid", {"access_token": "t", "saved_at": now, "expires_in": 86400}, ""),
        ("valid, no lifetime recorded", {"access_token": "t"}, ""),
    ]
    failures = 0
    for label, content, expected in cases:
        with tempfile.TemporaryDirectory() as tmp:
            if content is not None:
                raw = content if isinstance(content, str) else json.dumps(content)
                (Path(tmp) / "auth.json").write_text(raw)
            code, out = run_hook(tmp)
        ok = code == 0 and (expected in out if expected else out == "")
        failures += not ok
        print(f"{'PASS' if ok else 'FAIL'}  {label}" + ("" if ok else f"\n        exit={code} out={out!r}"))

    code, out = run_hook(None)
    ok = code == 0 and out == ""
    failures += not ok
    print(f"{'PASS' if ok else 'FAIL'}  CLAUDE_PLUGIN_DATA unset is silent")

    print("-" * 60)
    print(f"{failures} FAILED" if failures else f"ALL PASS ({len(cases) + 1}/{len(cases) + 1})")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
