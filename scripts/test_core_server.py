#!/usr/bin/env python3
"""Scripted stdio test harness for scripts/core-server.py.

Runs the MCP server as a subprocess, driving line-delimited JSON-RPC over
stdin/stdout, while a stdlib http.server stub records every backend request
(method, path, headers, parsed JSON body) and replays canned responses.

Run:  python3 scripts/test_core_server.py
Exits non-zero on the first failing assertion in any case; prints per-case
PASS/FAIL and a final ``ALL PASS`` line when every case passes.

Stdlib-only (no pytest, no pip deps) — matches repo conventions.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
SERVER = HERE / "core-server.py"


# ---------------------------------------------------------------------------
# Canned backend responses (realistic §2.1 / §2.2 / §2.3 shapes)
# ---------------------------------------------------------------------------

RUN_RESPONSE = {
    "runId": "665f0a1b2c3d4e5f60718293",
    "sessionId": "plugin-a1b2c3d4e5f6",
    "brief": (
        "You are Priya, a price-sensitive product manager evaluating whether "
        "Lumina Notes fits your team's workflow. Test the signup flow end to "
        "end and report every point of friction faithfully."
    ),
    "persona": {
        "personaId": "persona-9001",
        "name": "Priya Nair",
        "story": "A busy PM who skims fast and abandons at the first snag.",
        "personaCard": (
            "I'm Priya. I move fast, I'm impatient with slow buttons, and I "
            "always hunt for pricing before I commit to anything."
        ),
        "traits": {"impatience": 0.7, "skepticism": 0.5},
        "personaNeed": "evaluate whether this product fits my workflow",
    },
    "instructions": {
        "targetUrl": "http://localhost:8321",
        "goal": "test the signup flow",
        "scenarios": [
            {
                "id": "SC-1",
                "title": "Start a free trial",
                "steps": [
                    "Click the Start free trial CTA on the landing page",
                    "Observe how long the button takes to respond",
                ],
                "expectedResult": "The trial starts promptly with clear feedback.",
            },
            {
                "id": "SC-2",
                "title": "Complete signup",
                "steps": [
                    "Open the signup form",
                    "Fill in name and email and submit",
                ],
                "expectedResult": "Account is created and fields are preserved on error.",
            },
        ],
        "conduct": [
            "Act with this persona's patience and skill level",
            "Stay on the target site",
            "Narrate each step in the persona's voice",
        ],
    },
    "reporting": {
        "resultsEndpoint": "/api/plugin/runs/665f0a1b2c3d4e5f60718293/results",
        "requiredFields": ["sessionId", "status", "steps", "feedback"],
    },
}

RESULTS_RESPONSE = {
    "ok": True,
    "runId": "665f0a1b2c3d4e5f60718293",
    "testStatus": "completed",
    "message": (
        "Results stored for run 665f0a1b2c3d4e5f60718293. Analytics rollup "
        "queued; findings are viewable in the Archetype dashboard."
    ),
    "summary": {"steps": 1, "findings": 2, "verdict": "mixed"},
}

GET_RUN_RESPONSE = {
    "runId": "665f0a1b2c3d4e5f60718293",
    "status": "completed",
    "progress": 100,
    "createdAt": "2026-07-22T10:00:00Z",
    "completedAt": "2026-07-22T10:05:12Z",
    "feedback": {"verdict": "mixed", "summary": "Signup works but has friction."},
    "analyticsReady": True,
}

FEATURES_RESPONSE = {
    "ok": True,
    "features": [
        {
            "_id": "665f0a1b2c3d4e5f60718293",
            "title": "Signup",
            "updatedAt": "2026-07-01T00:00:00Z",
        }
    ],
}

DEVICE_CODE_RESPONSE = {
    "device_code": "dev-code-123",
    "user_code": "ABCD-EFGH",
    "verification_uri_complete": "https://auth0.test/activate?user_code=ABCD-EFGH",
    "interval": 1,
    "expires_in": 15,
}

DEVICE_TOKEN_RESPONSE = {
    "access_token": "new-token-456",
    "token_type": "Bearer",
    "expires_in": 86400,
}

VALIDATE_RESPONSE = {
    "valid": True,
    "user_id": "auth0|abc123",
    "audience": "https://api.syntheticarchetype.com",
    "issuer": "https://dev.auth0.test/",
}

PERSONAS_RESPONSE = {
    "personas": [
        {
            "personaId": "vp-fiona-001",
            "name": "Fiona Founder",
            "story": "A vibe-coding solo founder who ships fast and trusts her gut.",
            "source": "vibe",
            "createdAt": "2026-08-01T00:00:00Z",
            "demographics": {"occupation": "startup founder"},
        },
        {
            "personaId": "rp-replay-001",
            "name": "Priya Nair",
            "story": "A busy PM who skims fast and abandons at the first snag.",
            "source": "replay",
            "createdAt": "2026-07-22T00:00:00Z",
            "demographics": {},
        },
    ]
}

VIBE_PREVIEW_RESPONSE = {
    "examples": [
        {
            "name": "Fiona Founder",
            "story": "Ships fast, trusts her gut, hates onboarding friction.",
            "personaNeed": "see whether this saves her an afternoon",
            "vibeSummary": "impatient vibe-coder founder",
        },
        {
            "name": "Gary Garage",
            "story": "Tinkers late at night; skeptical of shiny tools.",
            "personaNeed": "prove the tool is not vaporware",
            "vibeSummary": "skeptical hacker founder",
        },
    ]
}

VIBE_CREATE_RESPONSE = {
    "personaId": "vp-new-123",
    "name": "Fiona Founder",
    "story": "A vibe-coding solo founder who ships fast and trusts her gut.",
    "personaNeed": "see whether this product saves her time",
    "source": "vibe",
    "createdAt": "2026-08-01T00:00:00Z",
}

FEATURE_CREATE_RESPONSE = {
    "ok": True,
    "feature": {
        "_id": "feat-new-001",
        "title": "Trial signup",
        "fields": {
            "description": "New users start a free trial from the landing page",
            "expected-usage": "Click CTA, fill the form, land in the app",
            "strategic-goals": "",
        },
    },
}


# ---------------------------------------------------------------------------
# Recording HTTP stub
# ---------------------------------------------------------------------------


class StubState:
    """Shared, mutable state driving the stub server across a test run."""

    def __init__(self) -> None:
        self.requests: list[dict] = []
        # path-substring -> (status, body). _dispatch matches by substring
        # (`needle in path`), so needles like "/results" or "/api/plugin/runs"
        # hit run-id paths too.
        self.error_overrides: dict[str, tuple[int, dict]] = {}
        # like error_overrides, but consumed on first match (for retry paths)
        self.once_overrides: dict[str, tuple[int, dict]] = {}
        self.lock = threading.Lock()

    def record(self, entry: dict) -> None:
        with self.lock:
            self.requests.append(entry)

    def reset(self) -> None:
        with self.lock:
            self.requests.clear()
            self.error_overrides.clear()
            self.once_overrides.clear()

    def last_for(self, needle: str) -> dict | None:
        with self.lock:
            for entry in reversed(self.requests):
                if needle in entry["path"]:
                    return entry
        return None


STATE = StubState()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):  # silence default stderr logging
        pass

    def _read_body(self) -> dict | None:
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        if not raw:
            return None
        try:
            return json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError:
            return {"__raw__": raw.decode("utf-8", "replace")}

    def _dispatch(self, method: str) -> None:
        body = self._read_body()
        STATE.record(
            {
                "method": method,
                "path": self.path,
                "headers": {k: v for k, v in self.headers.items()},
                "body": body,
            }
        )

        # One-shot overrides fire first and are consumed on match.
        with STATE.lock:
            for needle in list(STATE.once_overrides):
                if needle in self.path:
                    status, payload = STATE.once_overrides.pop(needle)
                    self._reply(status, payload)
                    return

        # Error overrides take precedence (matched by path substring).
        with STATE.lock:
            overrides = dict(STATE.error_overrides)
        for needle, (status, payload) in overrides.items():
            if needle in self.path:
                self._reply(status, payload)
                return

        status, payload = self._canned(method, self.path, body)
        self._reply(status, payload)

    def _canned(self, method: str, path: str, body: dict | None) -> tuple[int, dict]:
        # NOTE: ordering is load-bearing — the "/results" check must precede
        # the "/api/plugin/runs" prefix check, or result POSTs (which live
        # under /api/plugin/runs/<id>/results) would get RUN_RESPONSE instead.
        # Likewise "/api/persona/vibe" must precede the "/api/persona" prefix.
        if path.startswith("/api/oauth/device/code"):
            return 200, DEVICE_CODE_RESPONSE
        if path.startswith("/api/oauth/device/token"):
            return 200, DEVICE_TOKEN_RESPONSE
        if path.startswith("/api/oauth/validate-token"):
            return 200, VALIDATE_RESPONSE
        if path.startswith("/api/persona/vibe"):
            if (body or {}).get("previewOnly"):
                return 200, VIBE_PREVIEW_RESPONSE
            return 201, VIBE_CREATE_RESPONSE
        if path.startswith("/api/persona"):
            return 200, PERSONAS_RESPONSE
        if path.endswith("/results"):
            return 200, RESULTS_RESPONSE
        if path.startswith("/api/plugin/runs") and method == "POST":
            return 201, RUN_RESPONSE
        if path.startswith("/api/plugin/runs") and method == "GET":
            return 200, GET_RUN_RESPONSE
        if path.startswith("/api/features") and method == "POST":
            return 201, FEATURE_CREATE_RESPONSE
        if path.startswith("/api/features"):
            return 200, FEATURES_RESPONSE
        return 404, {"error": "not_found", "message": f"no stub for {method} {path}"}

    def _reply(self, status: int, payload: dict) -> None:
        raw = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_POST(self):  # noqa: N802
        self._dispatch("POST")

    def do_GET(self):  # noqa: N802
        self._dispatch("GET")


# ---------------------------------------------------------------------------
# JSON-RPC subprocess driver
# ---------------------------------------------------------------------------


class ServerProc:
    def __init__(self, port: int, data_dir: Path) -> None:
        env = dict(os.environ)
        env["CLAUDE_PLUGIN_DATA"] = str(data_dir)
        env["ARCHETYPE_BACKEND_URL"] = f"http://127.0.0.1:{port}"
        # Neuter webbrowser.open in the login flow: `true` is a no-op command.
        env["BROWSER"] = "true"
        # How this harness answers elicitation/create: "accept" or "decline".
        self.elicit_action = "decline"
        self.elicitations: list[dict] = []
        self.proc = subprocess.Popen(
            [sys.executable, str(SERVER)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
            text=True,
            bufsize=1,
        )
        self._id = 0

    def _next_id(self) -> int:
        self._id += 1
        return self._id

    def rpc(self, method: str, params: dict | None = None) -> dict:
        """Send a request and return its response (skipping server-initiated msgs)."""
        req_id = self._next_id()
        msg = {"jsonrpc": "2.0", "id": req_id, "method": method}
        if params is not None:
            msg["params"] = params
        self._write(msg)
        while True:
            resp = self._read()
            if resp.get("id") == req_id and ("result" in resp or "error" in resp):
                return resp
            # Server-initiated elicitation: record it and answer per elicit_action.
            if resp.get("method") == "elicitation/create" and resp.get("id") is not None:
                self.elicitations.append(resp.get("params") or {})
                if self.elicit_action == "accept":
                    payload = {"action": "accept", "content": {"approved": True}}
                else:
                    payload = {"action": "decline"}
                self._write({"jsonrpc": "2.0", "id": resp["id"], "result": payload})
                continue
            # ignore other server-initiated requests / mismatched ids

    def notify(self, method: str, params: dict | None = None) -> None:
        msg = {"jsonrpc": "2.0", "method": method}
        if params is not None:
            msg["params"] = params
        self._write(msg)

    def _write(self, msg: dict) -> None:
        assert self.proc.stdin is not None
        self.proc.stdin.write(json.dumps(msg) + "\n")
        self.proc.stdin.flush()

    def _read(self) -> dict:
        assert self.proc.stdout is not None
        line = self.proc.stdout.readline()
        if not line:
            err = ""
            if self.proc.stderr is not None:
                err = self.proc.stderr.read()
            raise RuntimeError(f"server produced no output / exited. stderr:\n{err}")
        return json.loads(line)

    def initialize(self) -> dict:
        resp = self.rpc(
            "initialize",
            {
                "protocolVersion": "2025-06-18",
                "capabilities": {},
                "clientInfo": {"name": "test-harness", "version": "0"},
            },
        )
        self.notify("notifications/initialized")
        return resp

    def close(self) -> None:
        try:
            if self.proc.stdin is not None:
                self.proc.stdin.close()
        except Exception:
            pass
        try:
            self.proc.wait(timeout=5)
        except Exception:
            self.proc.kill()


# ---------------------------------------------------------------------------
# Assertion helpers / test framework
# ---------------------------------------------------------------------------


class CaseFail(AssertionError):
    pass


def expect(cond: bool, msg: str) -> None:
    if not cond:
        raise CaseFail(msg)


def contains(haystack: str, needle: str, label: str) -> None:
    expect(needle in haystack, f"{label}: expected to contain {needle!r}")


def call_tool(srv: ServerProc, name: str, arguments: dict) -> dict:
    resp = srv.rpc("tools/call", {"name": name, "arguments": arguments})
    expect("result" in resp, f"tools/call {name} returned error: {resp.get('error')}")
    return resp["result"]


def result_text(result: dict) -> str:
    return "".join(
        block.get("text", "")
        for block in result.get("content", [])
        if block.get("type") == "text"
    )


def assert_no_snake_case(obj, label: str) -> None:
    """Recursively assert no key contains an underscore (snake_case leak)."""
    if isinstance(obj, dict):
        for key, val in obj.items():
            expect("_" not in key, f"{label}: snake_case key leaked into body: {key!r}")
            assert_no_snake_case(val, label)
    elif isinstance(obj, list):
        for item in obj:
            assert_no_snake_case(item, label)


# ---------------------------------------------------------------------------
# Test cases
# ---------------------------------------------------------------------------


def write_auth(data_dir: Path) -> None:
    (data_dir / "auth.json").write_text(json.dumps({"access_token": "test-token-123"}))


def clear_auth(data_dir: Path) -> None:
    for name in ("auth.json", "runs.json"):
        path = data_dir / name
        if path.exists():
            path.unlink()


def _b64url(data: bytes) -> str:
    import base64

    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def fake_id_token(email: str, name: str) -> str:
    """JWT-shaped token whose payload segment decodes to {email, name}."""
    header = _b64url(json.dumps({"alg": "RS256", "typ": "JWT"}).encode())
    payload = _b64url(json.dumps({"email": email, "name": name}).encode())
    return f"{header}.{payload}.fakesig"


def write_auth_full(data_dir: Path, **extra) -> None:
    payload = {"access_token": "test-token-123"}
    payload.update(extra)
    (data_dir / "auth.json").write_text(json.dumps(payload))


def read_run_log(data_dir: Path) -> list:
    path = data_dir / "runs.json"
    if not path.exists():
        return []
    return json.loads(path.read_text())


def case_1_tools_list(srv: ServerProc, data_dir: Path) -> None:
    init = srv.initialize()
    expect("result" in init, f"initialize failed: {init.get('error')}")
    resp = srv.rpc("tools/list")
    tools = resp["result"]["tools"]
    names = sorted(t["name"] for t in tools)
    expect(
        names
        == sorted(
            [
                "login",
                "start_run",
                "report_result",
                "get_run",
                "list_features",
                "status",
                "list_personas",
                "create_persona",
                "create_feature",
            ]
        ),
        f"tools/list should show exactly the 9 tools, got {names}",
    )


def case_2_start_run_happy(srv: ServerProc, data_dir: Path) -> None:
    write_auth(data_dir)
    result = call_tool(srv, "start_run", {"goal": "test signup", "url": "http://localhost:8321"})

    req = STATE.last_for("/api/plugin/runs")
    expect(req is not None, "no POST recorded for /api/plugin/runs")
    expect(req["method"] == "POST", "start_run should POST")
    expect(req["path"] == "/api/plugin/runs", f"unexpected path {req['path']}")
    expect(
        req["headers"].get("Authorization") == "Bearer test-token-123",
        f"missing/incorrect bearer: {req['headers'].get('Authorization')}",
    )
    body = req["body"]
    expect(body == {"goal": "test signup", "url": "http://localhost:8321"},
           f"body must be exactly camelCase goal+url, got {body}")
    assert_no_snake_case(body, "start_run body")

    text = result_text(result)
    expect(not result.get("isError"), "start_run happy path must not be an error")
    contains(text, RUN_RESPONSE["brief"], "start_run text (brief)")
    contains(text, RUN_RESPONSE["persona"]["personaCard"], "start_run text (personaCard)")
    contains(text, "Click the Start free trial CTA on the landing page", "start_run text (scenario steps)")
    contains(text, "Stay on the target site", "start_run text (conduct rules)")
    # §2.2 enums verbatim
    for enum in ("bug|ux|content|performance|other",
                 "critical|high|medium|low",
                 "pass|fail|blocked"):
        contains(text, enum, "start_run text (enums)")
    contains(text, RUN_RESPONSE["runId"], "start_run text (runId)")
    contains(text, RUN_RESPONSE["sessionId"], "start_run text (sessionId)")
    contains(text, "report_result", "start_run text (report guidance)")


def case_2b_start_run_feature_id(srv: ServerProc, data_dir: Path) -> None:
    write_auth(data_dir)
    call_tool(srv, "start_run",
              {"goal": "g", "feature_id": "665f0a1b2c3d4e5f60718293", "url": "http://x"})
    req = STATE.last_for("/api/plugin/runs")
    body = req["body"]
    expect(body.get("featureId") == "665f0a1b2c3d4e5f60718293",
           f"feature_id must map to camelCase featureId, got {body}")
    assert_no_snake_case(body, "start_run body (with feature)")


def case_3_start_run_no_auth_declined(srv: ServerProc, data_dir: Path) -> None:
    # No token + user declines the inline login -> clean login-hint error.
    clear_auth(data_dir)
    srv.elicit_action = "decline"
    result = call_tool(srv, "start_run", {"goal": "g", "url": "http://x"})
    expect(result.get("isError") is True, "start_run without auth must be isError")
    contains(result_text(result), "Run /archetype:setup to log in", "start_run no-auth text")
    expect(len(srv.elicitations) == 1, "self-heal should have offered the login modal once")


def case_4_report_result_happy(srv: ServerProc, data_dir: Path) -> None:
    write_auth(data_dir)
    args = {
        "run_id": "665f0a1b2c3d4e5f60718293",
        "session_id": "plugin-a1b2c3d4e5f6",
        "status": "completed",
        "duration_seconds": 312,
        "steps": [
            {
                "seq": 1,
                "scenario_id": "SC-1",
                "action_text": "clicked Start free trial",
                "narration": "Ugh, this is slow.",
                "url": "http://localhost:8321",
                "observation_page_type": "landing",
                "success": True,
            }
        ],
        # feedback is passed through untouched by the server, so its nested
        # keys are camelCase already (per the contract start_run renders).
        "feedback": {
            "verdict": "mixed",
            "summary": "ok",
            "scenarioResults": [
                {
                    "scenarioId": "SC-1",
                    "status": "pass",
                    "actualResult": "Trial started after a sluggish delay.",
                }
            ],
            "findings": [
                {
                    "scenarioId": "SC-1",
                    "category": "performance",
                    "severity": "medium",
                    "description": "CTA takes ~900ms with no loading state.",
                    "evidenceStepSeq": 1,
                }
            ],
            "personaReaction": "That button felt broken for a second.",
        },
    }
    result = call_tool(srv, "report_result", args)

    req = STATE.last_for("/results")
    expect(req is not None, "no POST recorded for results endpoint")
    expect(req["method"] == "POST", "report_result should POST")
    expect(
        req["path"] == "/api/plugin/runs/665f0a1b2c3d4e5f60718293/results",
        f"run_id should be a path param, got {req['path']}",
    )
    expect(req["headers"].get("Authorization") == "Bearer test-token-123", "missing bearer")

    body = req["body"]
    expect(body.get("sessionId") == "plugin-a1b2c3d4e5f6", "session_id -> sessionId")
    expect(body.get("durationSeconds") == 312, "duration_seconds -> durationSeconds")
    expect(body.get("status") == "completed", "status passed through")
    step = body["steps"][0]
    expect(step.get("actionText") == "clicked Start free trial", "action_text -> actionText")
    expect(step.get("observationPageType") == "landing", "observation_page_type -> observationPageType")
    expect(step.get("scenarioId") == "SC-1", "scenario_id -> scenarioId")
    # feedback pass-through: nested camelCase keys must arrive verbatim
    feedback = body.get("feedback") or {}
    sc_results = feedback.get("scenarioResults")
    expect(
        isinstance(sc_results, list) and sc_results
        and sc_results[0].get("scenarioId") == "SC-1"
        and sc_results[0].get("status") == "pass"
        and "actualResult" in sc_results[0],
        f"feedback.scenarioResults must pass through camelCase, got {sc_results}",
    )
    findings = feedback.get("findings")
    expect(
        isinstance(findings, list) and findings
        and findings[0].get("scenarioId") == "SC-1"
        and findings[0].get("evidenceStepSeq") == 1,
        f"feedback.findings must pass through camelCase, got {findings}",
    )
    # run_id is a path param, must NOT appear in the body
    expect("runId" not in body and "run_id" not in body, "run_id must not be in body")
    assert_no_snake_case(body, "report_result body")

    text = result_text(result)
    contains(text, RESULTS_RESPONSE["message"], "report_result surfaces backend message")


def case_5_report_result_conflict(srv: ServerProc, data_dir: Path) -> None:
    write_auth(data_dir)
    STATE.error_overrides["/results"] = (
        409,
        {"error": "run_conflict", "message": "This run is already completed."},
    )
    args = {
        "run_id": "665f0a1b2c3d4e5f60718293",
        "session_id": "plugin-a1b2c3d4e5f6",
        "status": "completed",
        "steps": [],
        "feedback": {},
    }
    result = call_tool(srv, "report_result", args)
    expect(result.get("isError") is True, "409 must be isError")
    contains(result_text(result), "This run is already completed.", "409 NL message surfaced")


def case_6_401_declined_heal_appends_login_hint(srv: ServerProc, data_dir: Path) -> None:
    # Stale token, backend keeps saying 401, user declines re-login ->
    # the original backend message + login hint must surface.
    write_auth(data_dir)
    srv.elicit_action = "decline"
    STATE.error_overrides["/api/plugin/runs"] = (
        401,
        {"error": "invalid_token", "message": "Token expired or invalid."},
    )
    result = call_tool(srv, "start_run", {"goal": "g", "url": "http://x"})
    expect(result.get("isError") is True, "401 must be isError")
    text = result_text(result)
    contains(text, "Token expired or invalid.", "401 surfaces backend message")
    contains(text, "Run /archetype:setup to log in.", "401 appends login hint")


def case_7_get_run(srv: ServerProc, data_dir: Path) -> None:
    write_auth(data_dir)
    result = call_tool(srv, "get_run", {"run_id": "665f0a1b2c3d4e5f60718293"})
    req = STATE.last_for("/api/plugin/runs/665f0a1b2c3d4e5f60718293")
    expect(req is not None, "no GET recorded for get_run")
    expect(req["method"] == "GET", "get_run should GET")
    expect(req["headers"].get("Authorization") == "Bearer test-token-123", "missing bearer")
    text = result_text(result)
    contains(text, "completed", "get_run text (status)")
    contains(text, "100", "get_run text (progress)")
    contains(text, "mixed", "get_run text (feedback verdict)")
    expect("analyticsReady" in text or "analytics" in text.lower(),
           "get_run text should mention analyticsReady")


def case_8_list_features(srv: ServerProc, data_dir: Path) -> None:
    write_auth(data_dir)
    result = call_tool(srv, "list_features", {})
    req = STATE.last_for("/api/features")
    expect(req is not None, "no GET recorded for /api/features")
    expect(req["method"] == "GET", "list_features should GET")
    expect(req["headers"].get("Authorization") == "Bearer test-token-123", "missing bearer")
    text = result_text(result)
    contains(text, "Signup", "list_features text (title)")
    contains(text, "665f0a1b2c3d4e5f60718293", "list_features text (_id)")


def case_9_status_not_connected(srv: ServerProc, data_dir: Path) -> None:
    # status reports state; it must NOT self-heal into a login modal.
    clear_auth(data_dir)
    srv.elicit_action = "decline"
    result = call_tool(srv, "status", {})
    expect(not result.get("isError"), "status not-connected is a report, not an error")
    text = result_text(result)
    contains(text, "Not connected", "status not-connected text")
    contains(text, "https://www.syntheticarchetype.com", "status portal link")
    contains(text, "/archetype:setup", "status login hint")
    expect(len(srv.elicitations) == 0, "status must not trigger the login modal")
    expect(
        STATE.last_for("/api/oauth/device/code") is None,
        "status must not start a device flow",
    )


def case_10_status_connected(srv: ServerProc, data_dir: Path) -> None:
    write_auth_full(
        data_dir,
        id_token=fake_id_token("priya@example.com", "Priya Nair"),
        expires_in=86400,
        saved_at=int(time.time()),
    )
    result = call_tool(srv, "status", {})
    expect(not result.get("isError"), "status connected must not be an error")
    text = result_text(result)
    contains(text, "priya@example.com", "status shows email from id_token")
    contains(text, "Priya Nair", "status shows name from id_token")
    contains(text, "auth0|abc123", "status shows user_id from validate-token")
    contains(text, "Features: 1", "status shows feature count")
    contains(text, "https://www.syntheticarchetype.com", "status portal link")
    req = STATE.last_for("/api/oauth/validate-token")
    expect(req is not None, "status should validate the token against the backend")
    freq = STATE.last_for("/api/features")
    expect(freq is not None, "status should fetch the feature count")


def case_11_status_invalid_token(srv: ServerProc, data_dir: Path) -> None:
    write_auth(data_dir)
    STATE.error_overrides["/api/oauth/validate-token"] = (
        401,
        {"valid": False, "error": "invalid_token", "reason": "expired"},
    )
    result = call_tool(srv, "status", {})
    expect(not result.get("isError"), "status with stale token still renders a report")
    text = result_text(result)
    expect(
        "expired" in text.lower() or "invalid" in text.lower(),
        f"status should flag the stale token, got: {text!r}",
    )
    contains(text, "https://www.syntheticarchetype.com", "status portal link (stale token)")
    contains(text, "/archetype:setup", "status login hint (stale token)")


def case_12_run_log_start_report_status(srv: ServerProc, data_dir: Path) -> None:
    write_auth(data_dir)
    call_tool(srv, "start_run", {"goal": "test signup", "url": "http://localhost:8321"})
    log_entries = read_run_log(data_dir)
    expect(len(log_entries) == 1, f"start_run should append one run-log entry, got {log_entries}")
    entry = log_entries[0]
    expect(entry.get("run_id") == RUN_RESPONSE["runId"], f"run_id recorded, got {entry}")
    expect(entry.get("goal") == "test signup", "goal recorded")
    expect(entry.get("url") == "http://localhost:8321", "url recorded")
    expect(entry.get("started_at") is not None, "started_at recorded")

    call_tool(
        srv,
        "report_result",
        {
            "run_id": RUN_RESPONSE["runId"],
            "session_id": RUN_RESPONSE["sessionId"],
            "status": "completed",
            "steps": [],
            "feedback": {"verdict": "mixed", "summary": "ok"},
        },
    )
    entry = read_run_log(data_dir)[0]
    expect(entry.get("status") == "completed", f"report_result records status, got {entry}")
    expect(entry.get("verdict") == "mixed", f"report_result records verdict, got {entry}")

    text = result_text(call_tool(srv, "status", {}))
    contains(text, RUN_RESPONSE["runId"], "status shows recent run id")
    contains(text, "test signup", "status shows recent run goal")
    contains(text, "mixed", "status shows recent run verdict")


def case_13_run_log_truncation(srv: ServerProc, data_dir: Path) -> None:
    write_auth(data_dir)
    stale = [
        {"run_id": f"old-{i}", "goal": "g", "url": "u", "started_at": i}
        for i in range(20)
    ]
    (data_dir / "runs.json").write_text(json.dumps(stale))
    call_tool(srv, "start_run", {"goal": "g", "url": "http://x"})
    log_entries = read_run_log(data_dir)
    expect(len(log_entries) == 20, f"run log must cap at 20 entries, got {len(log_entries)}")
    ids = [e.get("run_id") for e in log_entries]
    expect(RUN_RESPONSE["runId"] in ids, "newest run kept")
    expect("old-0" not in ids, "oldest entry dropped")


def case_14_run_log_corrupt(srv: ServerProc, data_dir: Path) -> None:
    write_auth(data_dir)
    (data_dir / "runs.json").write_text("{not json")
    result = call_tool(srv, "start_run", {"goal": "g", "url": "http://x"})
    expect(not result.get("isError"), "corrupt run log must not break start_run")
    log_entries = read_run_log(data_dir)
    expect(len(log_entries) == 1, "corrupt log replaced by fresh one")
    status_text = result_text(call_tool(srv, "status", {}))
    contains(status_text, "https://www.syntheticarchetype.com", "status survives log rewrite")


def case_15_self_heal_missing_token(srv: ServerProc, data_dir: Path) -> None:
    # No token, user accepts the inline login -> the ORIGINAL call completes.
    clear_auth(data_dir)
    srv.elicit_action = "accept"
    result = call_tool(srv, "list_features", {})
    expect(not result.get("isError"), f"self-healed call must succeed, got {result_text(result)!r}")
    contains(result_text(result), "Signup", "self-healed list_features returns data")
    expect(len(srv.elicitations) == 1, "exactly one login modal")
    req = STATE.last_for("/api/features")
    expect(
        req["headers"].get("Authorization") == "Bearer new-token-456",
        f"retry must use the fresh token, got {req['headers'].get('Authorization')}",
    )
    auth = json.loads((data_dir / "auth.json").read_text())
    expect(auth.get("access_token") == "new-token-456", "fresh token persisted")


def case_16_self_heal_401_retry(srv: ServerProc, data_dir: Path) -> None:
    # Stale token -> one 401 -> inline re-login -> retry succeeds.
    write_auth(data_dir)
    srv.elicit_action = "accept"
    STATE.once_overrides["/api/features"] = (
        401,
        {"error": "invalid_token", "message": "Token expired or invalid."},
    )
    result = call_tool(srv, "list_features", {})
    expect(not result.get("isError"), f"401-healed call must succeed, got {result_text(result)!r}")
    contains(result_text(result), "Signup", "401-healed list_features returns data")
    expect(len(srv.elicitations) == 1, "exactly one login modal")
    req = STATE.last_for("/api/features")
    expect(
        req["headers"].get("Authorization") == "Bearer new-token-456",
        f"retry must use the fresh token, got {req['headers'].get('Authorization')}",
    )
    auth = json.loads((data_dir / "auth.json").read_text())
    expect(auth.get("access_token") == "new-token-456", "fresh token persisted after 401 heal")


def case_17_list_personas(srv: ServerProc, data_dir: Path) -> None:
    write_auth(data_dir)
    result = call_tool(srv, "list_personas", {})
    req = STATE.last_for("/api/persona")
    expect(req is not None and req["method"] == "GET", "list_personas should GET /api/persona")
    expect(req["headers"].get("Authorization") == "Bearer test-token-123", "missing bearer")
    text = result_text(result)
    contains(text, "Fiona Founder", "list_personas shows name")
    contains(text, "vp-fiona-001", "list_personas keeps ids for the actor")
    contains(text, "vibe", "list_personas labels vibe source")
    contains(text, "replay", "list_personas labels replay source")
    contains(text, 'persona="<name>"', "run hint is name-based, not id-based")
    expect(
        "ids are for tool calls" in text.lower(),
        f"tool text tells the actor ids are internal, got {text!r}",
    )


def case_18_list_personas_empty(srv: ServerProc, data_dir: Path) -> None:
    write_auth(data_dir)
    STATE.error_overrides["/api/persona"] = (200, {"personas": []})
    result = call_tool(srv, "list_personas", {})
    expect(not result.get("isError"), "empty persona list is not an error")
    text = result_text(result)
    expect("no personas" in text.lower(), f"empty list says so plainly, got {text!r}")
    expect("create" in text.lower(), f"empty list nudges toward creation, got {text!r}")


def case_19_create_persona_preview(srv: ServerProc, data_dir: Path) -> None:
    write_auth(data_dir)
    result = call_tool(
        srv,
        "create_persona",
        {
            "vibe_prompt": "a vibe-coding solo founder who ships fast",
            "age_range": [28, 35],
            "skills_range": [70, 90],
            "occupation": "startup founder",
            "product_description": "Lumina Notes, a note-taking app",
            "preview_only": True,
            "preview_count": 2,
        },
    )
    req = STATE.last_for("/api/persona/vibe")
    expect(req is not None and req["method"] == "POST", "create_persona should POST /api/persona/vibe")
    body = req["body"]
    expect(body.get("mode") == "vibe", "mode is vibe")
    expect(body.get("vibePrompt") == "a vibe-coding solo founder who ships fast", "vibe_prompt -> vibePrompt")
    expect(body.get("previewOnly") is True, "preview_only -> previewOnly")
    expect(body.get("previewCount") == 2, "preview_count -> previewCount")
    expect(body.get("productDescription") == "Lumina Notes, a note-taking app", "product_description -> productDescription")
    controls = body.get("controls") or {}
    expect(controls.get("ageRange") == [28, 35], f"age_range -> controls.ageRange, got {controls}")
    expect(controls.get("skillsRange") == [70, 90], f"skills_range -> controls.skillsRange, got {controls}")
    expect(controls.get("occupation") == "startup founder", "occupation -> controls.occupation")
    assert_no_snake_case(body, "create_persona body")
    text = result_text(result)
    contains(text, "Fiona Founder", "preview shows candidate 1")
    contains(text, "Gary Garage", "preview shows candidate 2")
    expect("preview" in text.lower(), "preview result says these are previews")


def case_20_create_persona_final(srv: ServerProc, data_dir: Path) -> None:
    write_auth(data_dir)
    result = call_tool(
        srv,
        "create_persona",
        {"vibe_prompt": "a vibe-coding solo founder who ships fast"},
    )
    req = STATE.last_for("/api/persona/vibe")
    body = req["body"]
    expect(not body.get("previewOnly"), "final create must not set previewOnly")
    text = result_text(result)
    contains(text, "vp-new-123", "create still carries the id for the actor")
    contains(text, 'persona="Fiona Founder"', "usage hint is name-based")


def case_21_start_run_persona_id(srv: ServerProc, data_dir: Path) -> None:
    # persona-9001 matches RUN_RESPONSE's persona.personaId -> honored, happy path.
    write_auth(data_dir)
    result = call_tool(
        srv,
        "start_run",
        {"goal": "g", "url": "http://x", "persona_id": "persona-9001"},
    )
    expect(not result.get("isError"), "honored persona_id must succeed")
    req = STATE.last_for("/api/plugin/runs")
    body = req["body"]
    expect(body.get("personaId") == "persona-9001", f"persona_id -> personaId, got {body}")
    assert_no_snake_case(body, "start_run body (with persona)")
    entry = read_run_log(data_dir)[-1]
    expect(
        entry.get("persona_id") == "persona-9001",
        f"run log must record persona_id, got {entry}",
    )


def case_22_start_run_persona_not_honored(srv: ServerProc, data_dir: Path) -> None:
    # Backend (e.g. an outdated deploy) ignores personaId and returns a
    # different persona -> the tool must FAIL LOUDLY, never hand the actor a
    # briefing for the wrong persona.
    write_auth(data_dir)
    result = call_tool(
        srv,
        "start_run",
        {"goal": "g", "url": "http://x", "persona_id": "vp-fiona-001"},
    )
    expect(result.get("isError") is True, "unhonored persona_id must be an error")
    text = result_text(result)
    expect(
        "vp-fiona-001" in text and "persona-9001" in text,
        f"error names requested vs returned persona ids, got {text!r}",
    )
    expect(
        "did not honor" in text.lower() or "ignored" in text.lower(),
        f"error explains the backend ignored the selection, got {text!r}",
    )
    expect(len(read_run_log(data_dir)) == 0, "aborted run must not be logged as started")


def case_23_create_feature(srv: ServerProc, data_dir: Path) -> None:
    write_auth(data_dir)
    result = call_tool(
        srv,
        "create_feature",
        {
            "title": "Trial signup",
            "description": "New users start a free trial from the landing page",
            "expected_usage": "Click CTA, fill the form, land in the app",
        },
    )
    req = STATE.last_for("/api/features")
    expect(req is not None and req["method"] == "POST", "create_feature should POST /api/features")
    expect(req["headers"].get("Authorization") == "Bearer test-token-123", "missing bearer")
    body = req["body"]
    expect(body.get("title") == "Trial signup", f"title passed, got {body}")
    fields = body.get("fields") or {}
    expect(
        fields.get("description") == "New users start a free trial from the landing page",
        f"description -> fields.description, got {fields}",
    )
    expect(
        fields.get("expected-usage") == "Click CTA, fill the form, land in the app",
        f"expected_usage -> fields.expected-usage, got {fields}",
    )
    text = result_text(result)
    contains(text, "Trial signup", "create_feature echoes title")
    contains(text, "feat-new-001", "create_feature returns the feature id for start_run")


CASES = [
    ("initialize + tools/list shows 9 tools", case_1_tools_list),
    ("start_run happy path (camelCase body, rich tool text)", case_2_start_run_happy),
    ("start_run maps feature_id -> featureId", case_2b_start_run_feature_id),
    ("start_run no auth + declined login -> login hint error", case_3_start_run_no_auth_declined),
    ("report_result happy path (snake->camel, message surfaced)", case_4_report_result_happy),
    ("report_result 409 conflict -> NL message error", case_5_report_result_conflict),
    ("persistent 401 + declined heal -> login hint", case_6_401_declined_heal_appends_login_hint),
    ("get_run renders status/progress/feedback", case_7_get_run),
    ("list_features renders title + _id", case_8_list_features),
    ("status: not connected, no login modal", case_9_status_not_connected),
    ("status: connected dashboard (account, features, portal)", case_10_status_connected),
    ("status: stale token degrades gracefully", case_11_status_invalid_token),
    ("run log: start_run appends, report_result updates, status renders", case_12_run_log_start_report_status),
    ("run log: caps at 20 entries", case_13_run_log_truncation),
    ("run log: corrupt file tolerated", case_14_run_log_corrupt),
    ("self-heal: missing token -> inline login -> original call", case_15_self_heal_missing_token),
    ("self-heal: 401 -> re-login -> retry once", case_16_self_heal_401_retry),
    ("list_personas renders dashboard rows", case_17_list_personas),
    ("list_personas: empty -> creation nudge", case_18_list_personas_empty),
    ("create_persona preview (camelCase body, both candidates)", case_19_create_persona_preview),
    ("create_persona final -> personaId + usage hint", case_20_create_persona_final),
    ("start_run maps persona_id -> personaId + logs it", case_21_start_run_persona_id),
    ("start_run aborts when backend ignores personaId", case_22_start_run_persona_not_honored),
    ("create_feature POSTs title+fields, returns id", case_23_create_feature),
]


# ---------------------------------------------------------------------------
# Runner
# ---------------------------------------------------------------------------


def main() -> int:
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    port = httpd.server_address[1]
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()

    failures = 0
    with tempfile.TemporaryDirectory() as tmp:
        data_dir = Path(tmp)
        for label, fn in CASES:
            STATE.reset()
            clear_auth(data_dir)
            srv = ServerProc(port, data_dir)
            try:
                srv.initialize()
                fn(srv, data_dir)
                print(f"PASS  {label}")
            except CaseFail as exc:
                failures += 1
                print(f"FAIL  {label}\n        {exc}")
            except Exception as exc:  # unexpected error in a case
                failures += 1
                err = ""
                if srv.proc.stderr is not None and srv.proc.poll() is not None:
                    err = srv.proc.stderr.read()
                print(f"FAIL  {label}\n        unexpected: {exc!r}\n        stderr:{err}")
            finally:
                srv.close()

    httpd.shutdown()

    print("-" * 60)
    if failures:
        print(f"{failures} FAILED ({len(CASES) - failures}/{len(CASES)} passed)")
        return 1
    print(f"ALL PASS ({len(CASES)}/{len(CASES)})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
