#!/usr/bin/env python3
"""Security invariants of the core MCP server (no network, no backend)."""

from __future__ import annotations

import importlib.util
import os
import stat
import sys
import tempfile
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("core_server", HERE / "core-server.py")
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)

failures = 0


def check(cond: bool, label: str) -> None:
    global failures
    print(("PASS  " if cond else "FAIL  ") + label)
    failures += 0 if cond else 1


check(core._is_safe_url("https://api.syntheticarchetype.com"), "https backend allowed")
check(core._is_safe_url("http://127.0.0.1:5001"), "loopback http allowed")
check(core._is_safe_url("http://localhost:5001"), "localhost http allowed")
check(not core._is_safe_url("http://api.example.com"), "remote http refused")
check(not core._is_safe_url("file:///etc/passwd"), "file: refused")
check(not core._is_safe_url("javascript:alert(1)"), "javascript: refused")

core.BACKEND_IS_SAFE = False
req = urllib.request.Request("http://api.example.com/x")
check(core._attach_auth(req, "tok") is False, "token refused for insecure backend")
check(req.get_header("Authorization") is None, "no Authorization header added")
core.BACKEND_IS_SAFE = True

with tempfile.TemporaryDirectory() as tmp:
    old = os.umask(0o022)
    try:
        target = Path(tmp) / "data" / "auth.json"
        core._write_private(target, '{"access_token": "x"}\n')
    finally:
        os.umask(old)
    mode = stat.S_IMODE(target.stat().st_mode)
    check(mode == 0o600, f"auth file is 0600 (got {oct(mode)})")
    check(not list(target.parent.glob(".*.tmp")), "no temp file left behind")

print("-" * 60)
print("ALL PASS" if not failures else f"{failures} FAILED")
sys.exit(1 if failures else 0)
