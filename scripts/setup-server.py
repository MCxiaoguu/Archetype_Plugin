#!/usr/bin/env python3
"""archetype-setup MCP server — the data plane between Claude (the actor LLM
inside Claude Code) and the Archetype backend.

Claude never handles tokens or raw HTTP: it calls these five MCP tools and
reads their natural-language renderings.

Tools:

- ``login``        — Auth0 device-flow login (elicitation modal). Reads any
                     cached token from ``${CLAUDE_PLUGIN_DATA}/auth.json``,
                     validates it, otherwise runs the device flow and saves
                     the new token (mode ``0600``). Unchanged from v0.2.
- ``start_run``    — ``POST /api/plugin/runs``: assemble a persona-enriched
                     validation run; renders the brief, persona card,
                     scenarios, conduct rules and reporting contract.
- ``report_result``— ``POST /api/plugin/runs/<id>/results``: ingest the
                     actor's structured results; renders the backend
                     confirmation + summary counts.
- ``get_run``      — ``GET /api/plugin/runs/<id>``: status/results readback.
- ``list_features``— ``GET /api/features``: list the user's saved features
                     (their ``_id`` is the ``feature_id`` for ``start_run``).

All tools other than ``login`` require a Bearer token; any 401 tells the user
to run ``/archetype:validation`` to log in.

Stdlib-only. Backend base URL is configurable via the
``ARCHETYPE_BACKEND_URL`` environment variable
(default: ``https://api.syntheticarchetype.com``).
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request
import webbrowser
from pathlib import Path
from typing import Any

PROTOCOL_VERSION = "2025-06-18"
SERVER_NAME = "archetype-setup"
SERVER_VERSION = "0.3.0"
TOOL_NAME = "login"

# The synchronous run-assembly endpoint runs the persona/scenario LLM chain,
# which the MCP server tolerates for up to ~90 s; give it generous headroom.
RUN_TIMEOUT = 180

# Standard hint appended to any auth-related failure so the actor knows the fix.
LOGIN_HINT = "Run /archetype:validation to log in."

BACKEND_BASE = os.environ.get(
    "ARCHETYPE_BACKEND_URL", "https://api.syntheticarchetype.com"
).rstrip("/")
HTTP_TIMEOUT = 15

# Cloudflare WAF in front of api.syntheticarchetype.com returns HTTP 403
# (error 1010) for the default Python-urllib User-Agent. Send a real,
# identifiable UA on every request — anything non-default works.
USER_AGENT = os.environ.get(
    "ARCHETYPE_PLUGIN_USER_AGENT",
    f"archetype-claude-plugin/{SERVER_VERSION}",
)


# ---------- I/O ----------


def log(msg: str) -> None:
    sys.stderr.write(f"[archetype-setup] {msg}\n")
    sys.stderr.flush()


def send(msg: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(msg) + "\n")
    sys.stdout.flush()


def recv() -> dict[str, Any] | None:
    line = sys.stdin.readline()
    if not line:
        return None
    return json.loads(line)


_next_id = 1000


def server_request(method: str, params: dict[str, Any]) -> dict[str, Any]:
    """Send a server-initiated JSON-RPC request and block until its response arrives."""
    global _next_id
    req_id = _next_id
    _next_id += 1
    send({"jsonrpc": "2.0", "id": req_id, "method": method, "params": params})
    while True:
        msg = recv()
        if msg is None:
            raise RuntimeError("client disconnected while awaiting response")
        if msg.get("id") == req_id and ("result" in msg or "error" in msg):
            return msg
        log(f"ignoring interleaved message while awaiting response: method={msg.get('method')}")


# ---------- backend HTTP ----------


def _parse_body(raw: str) -> dict[str, Any]:
    if not raw:
        return {}
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return {"error": "invalid_response_body", "message": raw[:200]}


def _send(req: urllib.request.Request, timeout: int) -> tuple[int, dict[str, Any]]:
    """Execute a prepared request, mapping every outcome to (status, body)."""
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, _parse_body(resp.read().decode())
    except urllib.error.HTTPError as exc:
        return exc.code, _parse_body(exc.read().decode())
    except urllib.error.URLError as exc:
        return 0, {"error": "network_error", "message": str(exc.reason)}
    except Exception as exc:  # pragma: no cover — defensive
        return 0, {"error": "unexpected_error", "message": repr(exc)}


def backend_post(
    path: str,
    body: dict[str, Any],
    auth_token: str | None = None,
    timeout: int = HTTP_TIMEOUT,
) -> tuple[int, dict[str, Any]]:
    """POST JSON to the Archetype backend. Returns (status, parsed-body)."""
    req = urllib.request.Request(
        f"{BACKEND_BASE}{path}",
        data=json.dumps(body).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": USER_AGENT,
        },
        method="POST",
    )
    if auth_token:
        req.add_header("Authorization", f"Bearer {auth_token}")
    return _send(req, timeout)


def backend_get(
    path: str,
    auth_token: str | None = None,
    timeout: int = HTTP_TIMEOUT,
) -> tuple[int, dict[str, Any]]:
    """GET JSON from the Archetype backend. Returns (status, parsed-body)."""
    req = urllib.request.Request(
        f"{BACKEND_BASE}{path}",
        headers={
            "Accept": "application/json",
            "User-Agent": USER_AGENT,
        },
        method="GET",
    )
    if auth_token:
        req.add_header("Authorization", f"Bearer {auth_token}")
    return _send(req, timeout)


# ---------- tool: login ----------


def tool_text(text: str, is_error: bool = False) -> dict[str, Any]:
    result: dict[str, Any] = {"content": [{"type": "text", "text": text}]}
    if is_error:
        result["isError"] = True
    return result


def existing_token_is_valid(
    auth_path: Path,
) -> tuple[bool, str | None, dict[str, Any] | None]:
    """Return (is_valid, token, validate-response-body)."""
    if not auth_path.exists():
        return False, None, None
    try:
        data = json.loads(auth_path.read_text())
    except Exception as exc:
        log(f"could not parse {auth_path}: {exc}")
        return False, None, None
    token = data.get("access_token")
    if not token:
        return False, None, data
    status, body = backend_post("/api/oauth/validate-token", {}, auth_token=token)
    if status == 200 and body.get("valid") is True:
        return True, token, body
    log(
        f"validate-token said not valid (status={status}, "
        f"error={body.get('error')}, reason={body.get('reason')})"
    )
    return False, token, body


def request_user_approval(verify_url: str, user_code: str) -> bool:
    """Render the elicitation modal with the verification URL; return True iff accepted.

    Best-effort opens the URL in the user's default browser before the modal
    renders. If the browser can't be launched (headless box, no $DISPLAY,
    etc.), we silently fall back to relying on the user to click the URL.
    """
    try:
        opened = webbrowser.open(verify_url, new=2, autoraise=True)
        log(f"webbrowser.open returned {opened}")
    except Exception as exc:
        log(f"webbrowser.open failed: {exc!r}")

    resp = server_request(
        "elicitation/create",
        {
            "message": (
                "Connect to Archetype\n\n"
                f"1) Your browser should open to this URL automatically. If it didn't, open it manually:\n   {verify_url}\n\n"
                f"2) Verification code (shown for cross-check): {user_code}\n\n"
                "3) Once you've approved in the browser, tick the box below and click Accept. "
                "The plugin will then exchange the code for an access token."
            ),
            "requestedSchema": {
                "type": "object",
                "properties": {
                    "approved": {
                        "type": "boolean",
                        "title": "I've approved the request in my browser",
                        "description": (
                            "Tick this once you've completed the Auth0 approval flow in your browser, "
                            "then click Accept."
                        ),
                    }
                },
                "required": ["approved"],
            },
        },
    )
    if "error" in resp:
        log(f"elicitation error: {resp['error']}")
        return False
    result = resp.get("result") or {}
    if result.get("action") != "accept":
        return False
    content = result.get("content") or {}
    return content.get("approved") is True


def poll_for_token(
    device_code: str, interval: int, expires_in: int
) -> tuple[bool, dict[str, Any]]:
    """Poll /api/oauth/device/token until success, terminal error, or timeout."""
    deadline = time.monotonic() + expires_in
    poll = max(int(interval), 3)
    while time.monotonic() < deadline:
        time.sleep(poll)
        status, body = backend_post(
            "/api/oauth/device/token", {"device_code": device_code}
        )
        if status == 200 and body.get("access_token"):
            return True, body
        err = body.get("error", "")
        if err == "authorization_pending":
            continue
        if err == "slow_down":
            poll += 2
            continue
        return False, body
    return False, {
        "error": "expired_token",
        "error_description": "Device flow timed out before approval.",
    }


def handle_login() -> dict[str, Any]:
    plugin_data = os.environ.get("CLAUDE_PLUGIN_DATA")
    if not plugin_data:
        return tool_text(
            "CLAUDE_PLUGIN_DATA is not set; cannot determine where to store credentials.",
            is_error=True,
        )
    auth_path = Path(plugin_data) / "auth.json"

    valid, _token, info = existing_token_is_valid(auth_path)
    if valid:
        user_id = (info or {}).get("user_id", "unknown user")
        return tool_text(
            f"Already connected to Archetype as {user_id}.\n"
            f"Token at {auth_path}. To re-login, delete that file and re-run /archetype:validation."
        )

    status, code_body = backend_post("/api/oauth/device/code", {})
    if status != 200 or "device_code" not in code_body:
        err = code_body.get("error_description") or code_body.get("error") or code_body
        return tool_text(
            f"Could not start Archetype login (backend={BACKEND_BASE}, status={status}): {err}",
            is_error=True,
        )

    device_code = code_body["device_code"]
    user_code = code_body.get("user_code", "")
    verify_url = code_body.get("verification_uri_complete") or code_body.get(
        "verification_uri", ""
    )
    interval = int(code_body.get("interval", 5))
    expires_in = int(code_body.get("expires_in", 900))

    if not verify_url:
        return tool_text(
            "Backend did not return a verification URL.", is_error=True
        )

    log(f"prompting user with verification URL: {verify_url}")
    if not request_user_approval(verify_url, user_code):
        return tool_text(
            "Login cancelled. Re-run /archetype:validation to try again.",
            is_error=True,
        )

    ok, token_body = poll_for_token(device_code, interval, expires_in)
    if not ok:
        err = (
            token_body.get("error_description")
            or token_body.get("error")
            or "unknown error"
        )
        return tool_text(f"Could not complete login: {err}", is_error=True)

    auth_path.parent.mkdir(parents=True, exist_ok=True)
    payload: dict[str, Any] = {
        "access_token": token_body["access_token"],
        "token_type": token_body.get("token_type", "Bearer"),
        "expires_in": token_body.get("expires_in"),
        "scope": token_body.get("scope"),
        "refresh_token": token_body.get("refresh_token"),
        "id_token": token_body.get("id_token"),
        "saved_at": int(time.time()),
    }
    payload = {k: v for k, v in payload.items() if v is not None}
    auth_path.write_text(json.dumps(payload, indent=2) + "\n")
    os.chmod(auth_path, 0o600)
    log(f"saved token to {auth_path}")

    return tool_text(
        f"Connected to Archetype. Access token saved to {auth_path} (mode 0600).\n"
        "Run `/archetype:validation <instruction>` to start a validation run."
    )


# ---------- auth + backend-error helpers (shared by the run tools) ----------


def load_token() -> str | None:
    """Return the cached access token from auth.json, or None if absent."""
    plugin_data = os.environ.get("CLAUDE_PLUGIN_DATA")
    if not plugin_data:
        return None
    auth_path = Path(plugin_data) / "auth.json"
    if not auth_path.exists():
        return None
    try:
        return json.loads(auth_path.read_text()).get("access_token")
    except Exception as exc:
        log(f"could not read token from {auth_path}: {exc}")
        return None


def not_connected() -> dict[str, Any]:
    return tool_text(
        "Not connected. Run /archetype:validation to log in.", is_error=True
    )


def backend_error_text(status: int, body: dict[str, Any]) -> dict[str, Any]:
    """Render a non-2xx backend response as an error tool result.

    Prefers the backend's natural-language ``message``, falling back to the
    ``error`` slug. A 401 always gets the login hint appended so the actor
    knows the remedy.
    """
    message = body.get("message") or body.get("error") or f"backend returned {status}"
    if status == 401:
        message = f"{message} {LOGIN_HINT}"
    return tool_text(message, is_error=True)


# ---------- tool: start_run ----------


def _render_run(body: dict[str, Any]) -> str:
    """Assemble the natural-language briefing the actor LLM reads and acts on."""
    persona = body.get("persona") or {}
    instructions = body.get("instructions") or {}
    scenarios = instructions.get("scenarios") or []
    conduct = instructions.get("conduct") or []

    parts: list[str] = []

    brief = body.get("brief")
    if brief:
        parts.append(brief)

    card = persona.get("personaCard")
    if card:
        parts.append("— YOUR PERSONA —\n" + card)

    goal = instructions.get("goal")
    target = instructions.get("targetUrl")
    header = "— YOUR SCENARIOS —"
    if goal or target:
        header += f"\n(goal: {goal or '—'} · target: {target or '—'})"
    parts.append(header)
    for i, sc in enumerate(scenarios, start=1):
        lines = [f"{i}. [{sc.get('id', '')}] {sc.get('title', '')}".rstrip()]
        for step in sc.get("steps") or []:
            lines.append(f"   - {step}")
        expected = sc.get("expectedResult")
        if expected:
            lines.append(f"   Expected: {expected}")
        parts.append("\n".join(lines))

    if conduct:
        parts.append(
            "— CONDUCT RULES —\n"
            + "\n".join(f"- {rule}" for rule in conduct)
        )

    parts.append(
        f"runId: {body.get('runId', '')}\nsessionId: {body.get('sessionId', '')}"
    )

    parts.append(
        "When finished, call report_result with run_id, session_id, "
        "status (completed|failed|aborted), duration_seconds, steps (seq, "
        "scenario_id, action_text, narration, url, observation_page_type, "
        "success, error?, screenshot_b64? ≤6 total ≤1MB each), feedback "
        "{verdict pass|fail|mixed, summary, scenarioResults[{scenarioId,status "
        "pass|fail|blocked,actualResult}], findings[{scenarioId,category "
        "bug|ux|content|performance|other,severity critical|high|medium|low,"
        "description,evidenceStepSeq}], personaReaction}"
    )

    return "\n\n".join(parts)


def handle_start_run(arguments: dict[str, Any]) -> dict[str, Any]:
    token = load_token()
    if not token:
        return not_connected()

    body = {
        "goal": arguments.get("goal"),
        "featureId": arguments.get("feature_id"),
        "url": arguments.get("url"),
    }
    body = {k: v for k, v in body.items() if v is not None}

    status, resp = backend_post(
        "/api/plugin/runs", body, auth_token=token, timeout=RUN_TIMEOUT
    )
    if not (200 <= status < 300):
        return backend_error_text(status, resp)

    return tool_text(_render_run(resp))


# ---------- tool: report_result ----------

# snake_case (actor-facing) -> camelCase (backend) for per-step keys.
_STEP_KEY_MAP = {
    "action_text": "actionText",
    "observation_page_type": "observationPageType",
    "scenario_id": "scenarioId",
    "screenshot_b64": "screenshotB64",
}


def _map_step(step: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for key, value in step.items():
        out[_STEP_KEY_MAP.get(key, key)] = value
    return out


def handle_report_result(arguments: dict[str, Any]) -> dict[str, Any]:
    token = load_token()
    if not token:
        return not_connected()

    run_id = arguments.get("run_id")
    body: dict[str, Any] = {
        "sessionId": arguments.get("session_id"),
        "status": arguments.get("status"),
        "steps": [_map_step(s) for s in (arguments.get("steps") or [])],
        "feedback": arguments.get("feedback") or {},
    }
    if arguments.get("duration_seconds") is not None:
        body["durationSeconds"] = arguments["duration_seconds"]

    status, resp = backend_post(
        f"/api/plugin/runs/{run_id}/results", body, auth_token=token
    )
    if not (200 <= status < 300):
        return backend_error_text(status, resp)

    message = resp.get("message", "Results stored.")
    summary = resp.get("summary") or {}
    line = (
        f"Steps: {summary.get('steps', '?')} · "
        f"Findings: {summary.get('findings', '?')} · "
        f"Verdict: {summary.get('verdict', '?')}"
    )
    return tool_text(f"{message}\n\n{line}")


# ---------- tool: get_run ----------


def handle_get_run(arguments: dict[str, Any]) -> dict[str, Any]:
    token = load_token()
    if not token:
        return not_connected()

    run_id = arguments.get("run_id")
    status, resp = backend_get(f"/api/plugin/runs/{run_id}", auth_token=token)
    if not (200 <= status < 300):
        return backend_error_text(status, resp)

    lines = [
        f"Run {resp.get('runId', run_id)}",
        f"status: {resp.get('status', 'unknown')} · "
        f"progress: {resp.get('progress', '?')}% · "
        f"analyticsReady: {resp.get('analyticsReady', False)}",
    ]
    feedback = resp.get("feedback")
    if feedback:
        lines.append(
            f"verdict: {feedback.get('verdict', '?')} — "
            f"{feedback.get('summary', '')}".rstrip(" —")
        )
    return tool_text("\n".join(lines))


# ---------- tool: list_features ----------


def handle_list_features(arguments: dict[str, Any]) -> dict[str, Any]:
    token = load_token()
    if not token:
        return not_connected()

    status, resp = backend_get("/api/features", auth_token=token)
    if not (200 <= status < 300):
        return backend_error_text(status, resp)

    features = resp.get("features") or []
    query = (arguments.get("query") or "").strip().lower()
    if query:
        features = [
            f for f in features if query in (f.get("title") or "").lower()
        ]

    if not features:
        note = "No features found." if not query else f"No features match {query!r}."
        return tool_text(note)

    lines = [
        f"{f.get('_id', '')}  {f.get('title', '')}  (updated {f.get('updatedAt', '?')})"
        for f in features
    ]
    lines.append(
        "\nPass a feature's _id as feature_id to start_run to validate it."
    )
    return tool_text("\n".join(lines))


# ---------- tool registry ----------

LOGIN_DESCRIPTION = (
    "Connect this Claude Code session to your Archetype account. "
    "Validates any cached token first; if missing or expired, runs the "
    "Auth0 device-authorization flow and saves the new access token to "
    "the plugin's data directory."
)

TOOLS: dict[str, dict[str, Any]] = {
    "login": {
        "description": LOGIN_DESCRIPTION,
        "schema": {"type": "object", "properties": {}, "required": []},
        "handler": lambda _args: handle_login(),
    },
    "start_run": {
        "description": (
            "Start an Archetype validation run: assembles a persona-enriched "
            "instruction set (brief, persona card, scenarios, conduct rules, "
            "reporting contract) for the product under test. Renders everything "
            "as guidance the actor should follow verbatim."
        ),
        "schema": {
            "type": "object",
            "properties": {
                "goal": {
                    "type": "string",
                    "description": "What to test, e.g. 'test the signup flow'.",
                },
                "feature_id": {
                    "type": "string",
                    "description": "Optional saved-feature _id (from list_features).",
                },
                "url": {
                    "type": "string",
                    "description": "The product URL under test.",
                },
            },
            "required": ["url"],
        },
        "handler": handle_start_run,
    },
    "report_result": {
        "description": (
            "Post the actor's structured results for a run back to Archetype "
            "and return the backend's confirmation plus summary counts."
        ),
        "schema": {
            "type": "object",
            "properties": {
                "run_id": {"type": "string"},
                "session_id": {"type": "string"},
                "status": {
                    "type": "string",
                    "enum": ["completed", "failed", "aborted"],
                },
                "duration_seconds": {"type": "number"},
                "steps": {"type": "array"},
                "feedback": {"type": "object"},
            },
            "required": ["run_id", "session_id", "status", "steps", "feedback"],
        },
        "handler": handle_report_result,
    },
    "get_run": {
        "description": (
            "Read back the status, progress, and (if finished) feedback for a "
            "run."
        ),
        "schema": {
            "type": "object",
            "properties": {"run_id": {"type": "string"}},
            "required": ["run_id"],
        },
        "handler": handle_get_run,
    },
    "list_features": {
        "description": (
            "List the user's saved features. Each feature's _id is the "
            "feature_id you pass to start_run."
        ),
        "schema": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Optional case-insensitive title filter.",
                }
            },
            "required": [],
        },
        "handler": handle_list_features,
    },
}


# ---------- protocol ----------


def handle(msg: dict[str, Any]) -> None:
    method = msg.get("method")
    msg_id = msg.get("id")

    if method in ("notifications/initialized", "notifications/cancelled"):
        return

    if method == "initialize":
        send(
            {
                "jsonrpc": "2.0",
                "id": msg_id,
                "result": {
                    "protocolVersion": PROTOCOL_VERSION,
                    "capabilities": {"tools": {}},
                    "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION},
                },
            }
        )
        return

    if method == "tools/list":
        send(
            {
                "jsonrpc": "2.0",
                "id": msg_id,
                "result": {
                    "tools": [
                        {
                            "name": name,
                            "description": spec["description"],
                            "inputSchema": spec["schema"],
                        }
                        for name, spec in TOOLS.items()
                    ]
                },
            }
        )
        return

    if method == "tools/call":
        params = msg.get("params") or {}
        name = params.get("name")
        spec = TOOLS.get(name)
        if spec is None:
            send(
                {
                    "jsonrpc": "2.0",
                    "id": msg_id,
                    "error": {"code": -32601, "message": f"Unknown tool: {name}"},
                }
            )
            return
        result = spec["handler"](params.get("arguments") or {})
        send({"jsonrpc": "2.0", "id": msg_id, "result": result})
        return

    if msg_id is not None:
        send(
            {
                "jsonrpc": "2.0",
                "id": msg_id,
                "error": {"code": -32601, "message": f"Method not found: {method}"},
            }
        )


def main() -> int:
    log(f"server starting; backend={BACKEND_BASE}")
    while True:
        try:
            msg = recv()
        except json.JSONDecodeError as exc:
            log(f"invalid JSON on stdin: {exc}")
            continue
        if msg is None:
            log("stdin closed; exiting")
            return 0
        try:
            handle(msg)
        except Exception as exc:
            log(f"handler error: {exc!r}")
            msg_id = msg.get("id")
            if msg_id is not None:
                send(
                    {
                        "jsonrpc": "2.0",
                        "id": msg_id,
                        "error": {"code": -32603, "message": str(exc)},
                    }
                )


if __name__ == "__main__":
    sys.exit(main())
