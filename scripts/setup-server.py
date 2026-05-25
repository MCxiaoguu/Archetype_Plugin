#!/usr/bin/env python3
"""archetype-setup MCP server — Auth0 device-flow login.

Exposes one MCP tool, ``login``, which:

1. Reads any cached access token from ``${CLAUDE_PLUGIN_DATA}/auth.json``.
2. Validates it via ``POST /api/oauth/validate-token``. If still valid,
   returns "already connected".
3. Otherwise runs the Auth0 device-authorization flow:
   a. ``POST /api/oauth/device/code`` to mint a verification URL and code.
   b. MCP elicitation modal shows the URL + code to the user.
   c. After the user approves in browser and accepts the modal, polls
      ``POST /api/oauth/device/token`` at the backend-given interval.
4. Saves the new access token to ``auth.json`` with mode ``0600``.

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
SERVER_VERSION = "0.2.0"
TOOL_NAME = "login"

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


def backend_post(
    path: str, body: dict[str, Any], auth_token: str | None = None
) -> tuple[int, dict[str, Any]]:
    """POST JSON to the Archetype backend. Returns (status, parsed-body)."""
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        f"{BACKEND_BASE}{path}",
        data=data,
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": USER_AGENT,
        },
        method="POST",
    )
    if auth_token:
        req.add_header("Authorization", f"Bearer {auth_token}")

    def _parse(raw: str) -> dict[str, Any]:
        if not raw:
            return {}
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            return {"error": "invalid_response_body", "message": raw[:200]}

    try:
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
            return resp.status, _parse(resp.read().decode())
    except urllib.error.HTTPError as exc:
        return exc.code, _parse(exc.read().decode())
    except urllib.error.URLError as exc:
        return 0, {"error": "network_error", "message": str(exc.reason)}
    except Exception as exc:  # pragma: no cover — defensive
        return 0, {"error": "unexpected_error", "message": repr(exc)}


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
                            "name": TOOL_NAME,
                            "description": (
                                "Connect this Claude Code session to your Archetype account. "
                                "Validates any cached token first; if missing or expired, runs the "
                                "Auth0 device-authorization flow and saves the new access token to "
                                "the plugin's data directory."
                            ),
                            "inputSchema": {
                                "type": "object",
                                "properties": {},
                                "required": [],
                            },
                        }
                    ]
                },
            }
        )
        return

    if method == "tools/call":
        params = msg.get("params") or {}
        name = params.get("name")
        if name != TOOL_NAME:
            send(
                {
                    "jsonrpc": "2.0",
                    "id": msg_id,
                    "error": {"code": -32601, "message": f"Unknown tool: {name}"},
                }
            )
            return
        result = handle_login()
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
