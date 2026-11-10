#!/usr/bin/env python3
"""Security invariants of the core MCP server (loopback only, no backend)."""

from __future__ import annotations

import importlib.util
import json
import os
import stat
import sys
import tempfile
import threading
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
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

# The device flow carries no bearer token, but its last answer IS the token:
# it must not run against a cleartext remote backend either.
with tempfile.TemporaryDirectory() as tmp:
    calls = []
    real_post = core.backend_post
    core.backend_post = lambda path, *a, **k: calls.append(path) or (200, {})
    os.environ["CLAUDE_PLUGIN_DATA"] = tmp
    core.BACKEND_IS_SAFE = False
    try:
        token, message = core.perform_device_login()
    finally:
        core.BACKEND_IS_SAFE = True
        core.backend_post = real_post
        del os.environ["CLAUDE_PLUGIN_DATA"]
    check(token is None and "must use https" in message, f"login refused for an insecure backend ({message!r})")
    check(calls == [], f"no device code or token request sent (sent {calls})")

# Tool calls run on threads: two writes of one file at once must both land
# whole, and run-log updates must not overwrite each other.
with tempfile.TemporaryDirectory() as tmp:
    target = Path(tmp) / "runs.json"
    errors = []

    def writer(n: int) -> None:
        for _ in range(40):
            try:
                core._write_private(target, json.dumps({"writer": n, "pad": "x" * 20000}) + "\n")
            except Exception as exc:  # noqa: BLE001
                errors.append(repr(exc))

    threads = [threading.Thread(target=writer, args=(n,)) for n in range(12)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    check(not errors, f"concurrent private writes never fail ({errors[:1]})")
    check(json.loads(target.read_text())["writer"] in range(12), "the file holds one whole write")
    check(not list(Path(tmp).glob(".*.tmp")), "no temp file left behind by concurrent writers")

    os.environ["CLAUDE_PLUGIN_DATA"] = tmp
    target.unlink()
    gate = threading.Barrier(12)

    def start(n: int) -> None:
        gate.wait()
        core.record_run_start({"runId": f"run{n:02d}", "sessionId": f"s{n}"}, {"goal": "g"})

    threads = [threading.Thread(target=start, args=(n,)) for n in range(12)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    del os.environ["CLAUDE_PLUGIN_DATA"]
    logged = sorted(e["run_id"] for e in json.loads(target.read_text()))
    check(logged == [f"run{n:02d}" for n in range(12)], f"every concurrent run start is logged ({len(logged)} of 12)")

# urllib copies every header, Authorization included, to wherever a redirect
# points: a redirect to another origin (or to plain http) must not be
# followed with the token. Two loopback servers stand in for the origins.
seen: list = []


class _Elsewhere(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        seen.append(self.headers.get("Authorization"))
        self.send_response(200)
        self.send_header("Content-Length", "2")
        self.end_headers()
        self.wfile.write(b"{}")


elsewhere = ThreadingHTTPServer(("127.0.0.1", 0), _Elsewhere)


class _Backend(_Elsewhere):
    def do_GET(self):
        if self.path == "/same":
            return super().do_GET()
        target = (f"http://localhost:{elsewhere.server_address[1]}/stolen" if self.path == "/away"
                  else "/same")
        self.send_response(302)
        self.send_header("Location", target)
        self.send_header("Content-Length", "0")
        self.end_headers()


backend = ThreadingHTTPServer(("127.0.0.1", 0), _Backend)
for server in (elsewhere, backend):
    threading.Thread(target=server.serve_forever, daemon=True).start()
core.BACKEND_BASE = f"http://127.0.0.1:{backend.server_address[1]}"
status, body = core.backend_get("/away", auth_token="tok")
check(seen == [], f"no request follows a redirect to another origin (saw {seen})")
check(status == 0 and "redirect" in str(body.get("message")), f"the refused redirect is named ({status}, {body})")
status, body = core.backend_get("/home", auth_token="tok")
check(status == 200 and seen == ["Bearer tok"], f"a same-origin redirect is still followed ({status}, {seen})")
for server in (elsewhere, backend):
    server.shutdown()

print("-" * 60)
print("ALL PASS" if not failures else f"{failures} FAILED")
sys.exit(1 if failures else 0)
