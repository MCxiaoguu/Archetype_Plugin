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

POOLS_RESPONSE = {
    "personaPools": [
        {
            "poolId": "pool-fiona-001",
            "name": "Impatient Founders",
            "description": "Vibe-coding solo founders who ship fast and trust their gut.",
            "personaCount": 3,
            "activePersonaCount": 3,
            "createdAt": "2026-08-01T00:00:00Z",
            "metadata": {"primary_archetype_name": "Impatient Founders"},
        },
        {
            "poolId": "pool-default-001",
            "name": "My Personas",
            "description": "Replay-derived testers.",
            "personaCount": 1,
            "activePersonaCount": 1,
            "createdAt": "2026-07-22T00:00:00Z",
            "metadata": {},
        },
    ],
    "totalCount": 2,
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

# POST /api/persona/custom — the spec preset + one reference persona.
CUSTOM_CREATE_RESPONSE = {
    "persona": {
        "personaId": "ref-persona-001",
        "name": "Fiona Founder",
        "story": "A vibe-coding solo founder who ships fast and trusts her gut.",
        "vibePromptSummary": "impatient vibe-coder founder",
        "customPersonaId": "cp-preset-001",
        "source": "vibe",
    },
    "customPersonaId": "cp-preset-001",
    "preset": {"custom_persona_id": "cp-preset-001"},
}

# POST /api/persona/pool/create — note: NO pool name in the response (the
# route hard-codes pool_name to Pool_<hex>; the plugin renames via PATCH).
POOL_CREATE_RESPONSE = {
    "personaPoolId": "pool-new-123",
    "selectedPersonaIds": [],
    "customPersonaIds": ["cp-preset-001"],
    "archetypeName": "Impatient Founders",
    "createdAt": "2026-08-27T00:00:00Z",
}

# PATCH /api/persona/pools/<pool_id> — the renamed pool.
POOL_PATCH_RESPONSE = {
    "poolId": "pool-new-123",
    "name": "Impatient Founders",
    "description": "Vibe-coding solo founders.",
    "personaCount": 0,
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
        # Likewise "/api/persona/pool/create" must precede "/api/persona/pools"
        # would-be prefixes if any ever overlap.
        if path.startswith("/api/oauth/device/code"):
            return 200, DEVICE_CODE_RESPONSE
        if path.startswith("/api/oauth/device/token"):
            return 200, DEVICE_TOKEN_RESPONSE
        if path.startswith("/api/oauth/validate-token"):
            return 200, VALIDATE_RESPONSE
        if path.startswith("/api/persona/vibe"):
            return 200, VIBE_PREVIEW_RESPONSE
        if path.startswith("/api/persona/custom"):
            return 201, CUSTOM_CREATE_RESPONSE
        if path.startswith("/api/persona/pool/create"):
            return 201, POOL_CREATE_RESPONSE
        if path.startswith("/api/persona/pools/") and method == "PATCH":
            return 200, POOL_PATCH_RESPONSE
        if path.startswith("/api/persona/pools"):
            return 200, POOLS_RESPONSE
        if path.endswith("/results"):
            return 200, RESULTS_RESPONSE
        if path.startswith("/api/plugin/runs") and method == "POST":
            # Mirror the pool-aware backend: a poolId in the body comes back
            # as a pool block (spun-off member = RUN_RESPONSE's persona).
            pool_id = (body or {}).get("poolId")
            if pool_id:
                payload = dict(RUN_RESPONSE)
                payload["pool"] = {"poolId": pool_id, "name": "Impatient Founders"}
                return 201, payload
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

    def do_PATCH(self):  # noqa: N802
        self._dispatch("PATCH")


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
                "list_pools",
                "create_pool",
                "create_feature",
                "logout",
            ]
        ),
        f"tools/list should show exactly the 10 tools, got {names}",
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


def case_17_list_pools(srv: ServerProc, data_dir: Path) -> None:
    write_auth(data_dir)
    result = call_tool(srv, "list_pools", {})
    req = STATE.last_for("/api/persona/pools")
    expect(req is not None and req["method"] == "GET", "list_pools should GET /api/persona/pools")
    expect(req["headers"].get("Authorization") == "Bearer test-token-123", "missing bearer")
    text = result_text(result)
    contains(text, "Impatient Founders", "list_pools shows pool name")
    contains(text, "pool-fiona-001", "list_pools keeps poolIds for the actor")
    contains(text, "3 member(s)", "list_pools shows member count")
    contains(text, "Vibe-coding solo founders", "list_pools shows description")
    contains(text, "created 2026-08-01T00:00:00Z", "list_pools shows created date")
    contains(text, 'pool="<name>"', "run hint is name-based, not id-based")
    expect(
        "ids are for tool calls" in text.lower(),
        f"tool text tells the actor ids are internal, got {text!r}",
    )


def case_18_list_pools_empty(srv: ServerProc, data_dir: Path) -> None:
    write_auth(data_dir)
    STATE.error_overrides["/api/persona/pools"] = (200, {"personaPools": [], "totalCount": 0})
    result = call_tool(srv, "list_pools", {})
    expect(not result.get("isError"), "empty pool list is not an error")
    text = result_text(result)
    expect("no persona pools" in text.lower(), f"empty list says so plainly, got {text!r}")
    contains(text, "/archetype:persona", "empty list points at pool creation")


def case_19_create_pool_preview(srv: ServerProc, data_dir: Path) -> None:
    write_auth(data_dir)
    result = call_tool(
        srv,
        "create_pool",
        {
            "vibe_prompt": "vibe-coding solo founders who ship fast",
            "age_range": [28, 35],
            "skills_range": [70, 90],
            "occupation": "startup founder",
            "product_description": "Lumina Notes, a note-taking app",
            "preview_only": True,
            "preview_count": 2,
        },
    )
    req = STATE.last_for("/api/persona/vibe")
    expect(req is not None and req["method"] == "POST", "create_pool preview should POST /api/persona/vibe")
    body = req["body"]
    expect(body.get("mode") == "vibe", "mode is vibe")
    expect(body.get("vibePrompt") == "vibe-coding solo founders who ship fast", "vibe_prompt -> vibePrompt")
    expect(body.get("previewOnly") is True, "preview_only -> previewOnly")
    expect(body.get("previewCount") == 2, "preview_count -> previewCount")
    expect(body.get("productDescription") == "Lumina Notes, a note-taking app", "product_description -> productDescription")
    controls = body.get("controls") or {}
    expect(controls.get("ageRange") == [28, 35], f"age_range -> controls.ageRange, got {controls}")
    expect(controls.get("skillsRange") == [70, 90], f"skills_range -> controls.skillsRange, got {controls}")
    expect(controls.get("occupation") == "startup founder", "occupation -> controls.occupation")
    assert_no_snake_case(body, "create_pool preview body")
    expect(STATE.last_for("/api/persona/custom") is None, "preview must not persist a spec")
    expect(STATE.last_for("/api/persona/pool/create") is None, "preview must not create a pool")
    text = result_text(result)
    contains(text, "Fiona Founder", "preview shows candidate 1")
    contains(text, "Gary Garage", "preview shows candidate 2")
    expect("preview" in text.lower(), "preview result says these are previews")


def case_20_create_pool_final(srv: ServerProc, data_dir: Path) -> None:
    # The save path is a THREE-call sequence: POST /api/persona/custom ->
    # POST /api/persona/pool/create -> PATCH /api/persona/pools/<poolId>.
    write_auth(data_dir)
    vibe = "vibe-coding solo founders who ship fast"
    result = call_tool(
        srv,
        "create_pool",
        {"vibe_prompt": vibe, "name": "Impatient Founders"},
    )

    custom_req = STATE.last_for("/api/persona/custom")
    expect(custom_req is not None and custom_req["method"] == "POST",
           "save should POST /api/persona/custom first")
    custom_body = custom_req["body"]
    expect(custom_body.get("mode") == "vibe", "custom body mode is vibe")
    expect(custom_body.get("vibePrompt") == vibe, "vibe_prompt -> vibePrompt")
    expect(custom_body.get("archetypeName") == "Impatient Founders",
           f"name -> archetypeName, got {custom_body}")
    expect(not custom_body.get("previewOnly"), "final save must not set previewOnly")

    pool_req = STATE.last_for("/api/persona/pool/create")
    expect(pool_req is not None and pool_req["method"] == "POST",
           "save should POST /api/persona/pool/create second")
    pool_body = pool_req["body"]
    expect(pool_body.get("selectedPersonaIds") == ["ref-persona-001"],
           f"pool links the reference persona, got {pool_body}")
    expect(pool_body.get("archetypeName") == "Impatient Founders",
           f"pool carries the archetype name, got {pool_body}")
    expect(pool_body.get("description") == vibe, f"pool description is the spec, got {pool_body}")

    patch_req = STATE.last_for("/api/persona/pools/pool-new-123")
    expect(patch_req is not None and patch_req["method"] == "PATCH",
           "save should PATCH /api/persona/pools/<poolId> third")
    patch_body = patch_req["body"]
    # CRITICAL: the route only recognizes the body key "name" — "pool_name"
    # is silently ignored and the rename would be dropped.
    expect(patch_body.get("name") == "Impatient Founders",
           f"rename must use body key 'name', got {patch_body}")
    expect("pool_name" not in patch_body, "rename must NOT send 'pool_name'")
    expect(patch_body.get("description") == vibe, f"rename carries description, got {patch_body}")

    persona_paths = [r["path"] for r in STATE.requests if "/api/persona" in r["path"]]
    expect(
        persona_paths == [
            "/api/persona/custom",
            "/api/persona/pool/create",
            "/api/persona/pools/pool-new-123",
        ],
        f"save must be exactly the three-call sequence in order, got {persona_paths}",
    )

    expect(not result.get("isError"), "create_pool save happy path must not error")
    text = result_text(result)
    contains(text, "Impatient Founders", "save echoes the pool name")
    contains(text, "pool-new-123", "save carries the poolId for the actor")
    contains(text, 'pool="Impatient Founders"', "usage hint is name-based")
    expect("spun off" in text.lower(), f"save explains members are spun off later, got {text!r}")


def case_20b_create_pool_rename_fails(srv: ServerProc, data_dir: Path) -> None:
    # Step 3 (rename) failing leaves a WORKING pool under Pool_<hex>: report
    # the poolId and continue — never an error result.
    write_auth(data_dir)
    STATE.error_overrides["/api/persona/pools/pool-new-123"] = (
        500,
        {"error": "internal_error", "message": "rename blew up"},
    )
    result = call_tool(
        srv,
        "create_pool",
        {"vibe_prompt": "skeptical IT admins", "name": "Skeptical Admins"},
    )
    expect(not result.get("isError"), "rename failure must not fail the save")
    text = result_text(result)
    contains(text, "pool-new-123", "rename failure still reports the poolId")
    contains(text, "Pool_", "rename failure names the Pool_<hex> placeholder")
    expect("usable" in text.lower(), f"rename failure says the pool is usable, got {text!r}")
    contains(text, "rename blew up", "rename failure surfaces the backend message")


def case_20c_create_pool_step2_fails(srv: ServerProc, data_dir: Path) -> None:
    # Step 2 failing leaves only an orphan preset (benign): error out with
    # retry guidance and never attempt the rename.
    write_auth(data_dir)
    STATE.error_overrides["/api/persona/pool/create"] = (
        500,
        {"error": "internal_error", "message": "pool store down"},
    )
    result = call_tool(
        srv,
        "create_pool",
        {"vibe_prompt": "skeptical IT admins", "name": "Skeptical Admins"},
    )
    expect(result.get("isError") is True, "step-2 failure must be an error")
    text = result_text(result)
    contains(text, "pool store down", "step-2 failure surfaces the backend message")
    expect("retry" in text.lower(), f"step-2 failure tells the user to retry, got {text!r}")
    patch_reqs = [r for r in STATE.requests if r["method"] == "PATCH"]
    expect(not patch_reqs, "no rename attempt after a failed pool create")


def case_21_start_run_pool_id(srv: ServerProc, data_dir: Path) -> None:
    # The stub echoes the requested poolId back in the pool block -> honored.
    write_auth(data_dir)
    result = call_tool(
        srv,
        "start_run",
        {"goal": "g", "url": "http://x", "pool_id": "pool-fiona-001"},
    )
    expect(not result.get("isError"), "honored pool_id must succeed")
    req = STATE.last_for("/api/plugin/runs")
    body = req["body"]
    expect(body.get("poolId") == "pool-fiona-001", f"pool_id -> poolId, got {body}")
    expect("personaId" not in body, f"legacy personaId must never be sent, got {body}")
    assert_no_snake_case(body, "start_run body (with pool)")
    text = result_text(result)
    contains(text, "spun from pool Impatient Founders", "briefing names the source pool")
    entry = read_run_log(data_dir)[-1]
    expect(
        entry.get("pool_id") == "pool-fiona-001",
        f"run log must record pool_id, got {entry}",
    )
    expect("persona_id" not in entry, f"run log must not record persona_id, got {entry}")


def case_22_start_run_pool_not_honored(srv: ServerProc, data_dir: Path) -> None:
    # Backend (e.g. an outdated deploy) ignores poolId and returns no pool
    # block -> the tool must FAIL LOUDLY, never hand the actor a briefing for
    # a tester the caller didn't pick.
    write_auth(data_dir)
    STATE.error_overrides["/api/plugin/runs"] = (201, RUN_RESPONSE)
    result = call_tool(
        srv,
        "start_run",
        {"goal": "g", "url": "http://x", "pool_id": "pool-fiona-001"},
    )
    expect(result.get("isError") is True, "unhonored pool_id must be an error")
    text = result_text(result)
    contains(text, "pool-fiona-001", "error names the requested pool id")
    expect(
        "did not honor" in text.lower() or "ignored" in text.lower(),
        f"error explains the backend ignored the selection, got {text!r}",
    )
    expect(len(read_run_log(data_dir)) == 0, "aborted run must not be logged as started")


def case_22b_status_tolerates_legacy_run_log(srv: ServerProc, data_dir: Path) -> None:
    # Pre-0.4.0 run-log entries carry persona_id; status must render anyway.
    write_auth(data_dir)
    (data_dir / "runs.json").write_text(json.dumps([
        {
            "run_id": "legacy-run-1",
            "goal": "old persona run",
            "persona_id": "vp-fiona-001",
            "started_at": 1,
            "status": "completed",
            "verdict": "pass",
        }
    ]))
    result = call_tool(srv, "status", {})
    expect(not result.get("isError"), "status must tolerate legacy run-log entries")
    text = result_text(result)
    contains(text, "legacy-run-1", "legacy entry still renders in recent runs")
    contains(text, "old persona run", "legacy entry goal still renders")


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


def case_24_logout_connected(srv: ServerProc, data_dir: Path) -> None:
    write_auth_full(data_dir, id_token=fake_id_token("priya@example.com", "Priya Nair"))
    (data_dir / "runs.json").write_text(json.dumps([{"run_id": "r1", "goal": "g"}]))
    result = call_tool(srv, "logout", {})
    expect(not result.get("isError"), "logout while connected must succeed")
    text = result_text(result)
    expect("logged out" in text.lower(), f"logout says so plainly, got {text!r}")
    contains(text, "priya@example.com", "logout names who was logged out")
    contains(text, "/archetype:setup", "logout points at how to reconnect")
    expect(not (data_dir / "auth.json").exists(), "auth.json must be deleted")
    expect((data_dir / "runs.json").exists(), "run history must be preserved")
    expect(len(srv.elicitations) == 0, "logout must never trigger the login modal")


def case_25_logout_not_connected(srv: ServerProc, data_dir: Path) -> None:
    clear_auth(data_dir)
    result = call_tool(srv, "logout", {})
    expect(not result.get("isError"), "logout when not connected is a no-op, not an error")
    text = result_text(result)
    expect("not connected" in text.lower(), f"no-op logout says so, got {text!r}")


CASES = [
    ("initialize + tools/list shows 10 tools", case_1_tools_list),
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
    ("list_pools renders dashboard rows", case_17_list_pools),
    ("list_pools: empty -> creation nudge", case_18_list_pools_empty),
    ("create_pool preview (camelCase body, both candidates, nothing saved)", case_19_create_pool_preview),
    ("create_pool save = custom -> pool/create -> PATCH rename", case_20_create_pool_final),
    ("create_pool: rename failure -> pool usable under Pool_<hex>", case_20b_create_pool_rename_fails),
    ("create_pool: pool-create failure -> retryable error, no rename", case_20c_create_pool_step2_fails),
    ("start_run maps pool_id -> poolId + logs it", case_21_start_run_pool_id),
    ("start_run aborts when backend ignores poolId", case_22_start_run_pool_not_honored),
    ("status tolerates legacy persona_id run-log entries", case_22b_status_tolerates_legacy_run_log),
    ("create_feature POSTs title+fields, returns id", case_23_create_feature),
    ("logout deletes auth.json, keeps run history", case_24_logout_connected),
    ("logout when not connected is a friendly no-op", case_25_logout_not_connected),
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
