#!/usr/bin/env python3
"""Scripted stdio test harness for scripts/setup-server.py.

Runs the MCP server as a subprocess, driving line-delimited JSON-RPC over
stdin/stdout, while a stdlib http.server stub records every backend request
(method, path, headers, parsed JSON body) and replays canned responses.

Run:  python3 scripts/test_setup_server.py
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
SERVER = HERE / "setup-server.py"


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
        self.lock = threading.Lock()

    def record(self, entry: dict) -> None:
        with self.lock:
            self.requests.append(entry)

    def reset(self) -> None:
        with self.lock:
            self.requests.clear()
            self.error_overrides.clear()

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

        # Error overrides take precedence (matched by path substring).
        with STATE.lock:
            overrides = dict(STATE.error_overrides)
        for needle, (status, payload) in overrides.items():
            if needle in self.path:
                self._reply(status, payload)
                return

        status, payload = self._canned(method, self.path)
        self._reply(status, payload)

    def _canned(self, method: str, path: str) -> tuple[int, dict]:
        # NOTE: ordering is load-bearing — the "/results" check must precede
        # the "/api/plugin/runs" prefix check, or result POSTs (which live
        # under /api/plugin/runs/<id>/results) would get RUN_RESPONSE instead.
        if path.endswith("/results"):
            return 200, RESULTS_RESPONSE
        if path.startswith("/api/plugin/runs") and method == "POST":
            return 201, RUN_RESPONSE
        if path.startswith("/api/plugin/runs") and method == "GET":
            return 200, GET_RUN_RESPONSE
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
            # ignore server-initiated requests / mismatched ids

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
    auth = data_dir / "auth.json"
    if auth.exists():
        auth.unlink()


def case_1_tools_list(srv: ServerProc, data_dir: Path) -> None:
    init = srv.initialize()
    expect("result" in init, f"initialize failed: {init.get('error')}")
    resp = srv.rpc("tools/list")
    tools = resp["result"]["tools"]
    names = sorted(t["name"] for t in tools)
    expect(
        names == sorted(["login", "start_run", "report_result", "get_run", "list_features"]),
        f"tools/list should show exactly the 5 tools, got {names}",
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


def case_3_start_run_no_auth(srv: ServerProc, data_dir: Path) -> None:
    clear_auth(data_dir)
    result = call_tool(srv, "start_run", {"goal": "g", "url": "http://x"})
    expect(result.get("isError") is True, "start_run without auth must be isError")
    contains(result_text(result), "Run /archetype:validation to log in", "start_run no-auth text")


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


def case_6_401_appends_login_hint(srv: ServerProc, data_dir: Path) -> None:
    write_auth(data_dir)
    STATE.error_overrides["/api/plugin/runs"] = (
        401,
        {"error": "invalid_token", "message": "Token expired or invalid."},
    )
    result = call_tool(srv, "start_run", {"goal": "g", "url": "http://x"})
    expect(result.get("isError") is True, "401 must be isError")
    text = result_text(result)
    contains(text, "Token expired or invalid.", "401 surfaces backend message")
    contains(text, "Run /archetype:validation to log in.", "401 appends login hint")


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


CASES = [
    ("initialize + tools/list shows 5 tools", case_1_tools_list),
    ("start_run happy path (camelCase body, rich tool text)", case_2_start_run_happy),
    ("start_run maps feature_id -> featureId", case_2b_start_run_feature_id),
    ("start_run without auth -> login hint error", case_3_start_run_no_auth),
    ("report_result happy path (snake->camel, message surfaced)", case_4_report_result_happy),
    ("report_result 409 conflict -> NL message error", case_5_report_result_conflict),
    ("401 on any tool -> appends login hint", case_6_401_appends_login_hint),
    ("get_run renders status/progress/feedback", case_7_get_run),
    ("list_features renders title + _id", case_8_list_features),
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
