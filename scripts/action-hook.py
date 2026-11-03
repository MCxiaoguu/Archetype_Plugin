#!/usr/bin/env python3
"""PostToolUse / PostToolUseFailure hook: the raw record of what an actor did.

Beside the actor's own step log (log_step), this keeps ground truth: every
browser tool call, as Claude Code saw it, appended to
${CLAUDE_PLUGIN_DATA}/runs/<run_id>.actions.jsonl. report_result uploads the
file as rawActions, and the study report flags narrated steps no tool call
backs (plan 5.4).

Which run a call belongs to: MCP tool calls carry no agent id, but hooks
do. So this hook also watches the core server's start_run: its answer
carries the runId, and the hook records it for the calling agent in
runs/active-<agent>.json. Browser calls from that agent are then filed
under that run; report_result clears the mapping.

Typed text is never stored: text and values are replaced by their length.
The hook is stdlib only and never fails the session: every surprise is
swallowed and the exit code is always 0.
"""

from __future__ import annotations

import json
import os
import re
import sys
import time
from pathlib import Path
from typing import Any

CORE_PREFIX = "mcp__plugin_archetype_core__"
BROWSER_TOOL = re.compile(
    r"^(mcp__playwright__|mcp__claude-in-chrome__|"
    r"mcp__plugin_archetype_archetype-(?:browser|watch)-\d+__)"
)
RUN_ID = re.compile(r"\brunId:\s*([A-Za-z0-9_-]{1,64})")
SESSION_ID = re.compile(r"\bsessionId:\s*([A-Za-z0-9_.:-]{1,128})")

# Inputs that carry what the persona typed or uploaded: kept as a length.
SECRET_KEYS = {"text", "value", "values", "password", "secret", "token", "paths", "files"}
# Inputs that are code: kept short, for the shape of the call only.
CODE_KEYS = {"function", "code", "script", "expression"}
KEEP_CHARS = 300
CODE_CHARS = 120


def agent_key(event: dict[str, Any]) -> str:
    agent = event.get("agent_id")
    if isinstance(agent, str) and agent:
        return re.sub(r"[^A-Za-z0-9_-]", "-", agent)[:80]
    session = str(event.get("session_id") or "unknown")
    return "main-" + re.sub(r"[^A-Za-z0-9_-]", "-", session)[:80]


def redact(value: Any, key: str = "", depth: int = 0) -> Any:
    """The tool input with typed text removed and long strings cut."""
    if depth > 4:
        return "<nested>"
    lowered = key.lower()
    if lowered in SECRET_KEYS:
        if isinstance(value, str):
            return f"<redacted {len(value)} chars>"
        if isinstance(value, list):
            return f"<redacted {len(value)} items>"
        return "<redacted>"
    if isinstance(value, dict):
        return {str(k): redact(v, str(k), depth + 1) for k, v in list(value.items())[:30]}
    if isinstance(value, list):
        return [redact(v, key, depth + 1) for v in value[:30]]
    if isinstance(value, str):
        limit = CODE_CHARS if lowered in CODE_KEYS else KEEP_CHARS
        return value if len(value) <= limit else value[:limit] + "..."
    return value


def response_text(response: Any) -> str:
    """The text of a tool response, whatever shape Claude Code hands over."""
    if isinstance(response, str):
        return response
    if isinstance(response, dict):
        if isinstance(response.get("content"), list):
            return response_text(response["content"])
        if isinstance(response.get("text"), str):
            return response["text"]
        return json.dumps(response)[:20000]
    if isinstance(response, list):
        return "\n".join(response_text(item) for item in response)
    return ""


def response_failed(event: dict[str, Any]) -> tuple[bool, str | None]:
    if event.get("hook_event_name") == "PostToolUseFailure":
        error = event.get("error") or event.get("tool_response") or "tool call failed"
        return True, response_text(error)[:300] if not isinstance(error, str) else error[:300]
    response = event.get("tool_response")
    if isinstance(response, dict) and response.get("isError"):
        return True, response_text(response)[:300]
    text = response_text(response)
    if text.lstrip().startswith("### Error"):
        return True, text.strip()[:300]
    return False, None


def handle(event: dict[str, Any], runs_dir: Path) -> None:
    tool = str(event.get("tool_name") or "")
    key = agent_key(event)
    active_file = runs_dir / f"active-{key}.json"

    if tool == CORE_PREFIX + "start_run":
        failed, _ = response_failed(event)
        match = RUN_ID.search(response_text(event.get("tool_response")))
        if failed or not match:
            return
        session = SESSION_ID.search(response_text(event.get("tool_response")))
        runs_dir.mkdir(parents=True, exist_ok=True)
        active_file.write_text(json.dumps({
            "run_id": match.group(1),
            "session_id": session.group(1) if session else None,
            "since": time.time(),
        }))
        return

    if tool == CORE_PREFIX + "report_result":
        failed, _ = response_failed(event)
        if not failed:
            active_file.unlink(missing_ok=True)
        return

    if not BROWSER_TOOL.match(tool):
        return
    try:
        run_id = json.loads(active_file.read_text()).get("run_id")
    except (OSError, ValueError):
        return  # a browser call outside a run (preflight): nothing to file
    if not isinstance(run_id, str) or not re.match(r"^[A-Za-z0-9_-]{1,64}$", run_id):
        return
    failed, error = response_failed(event)
    record = {
        "ts": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()) + f".{int(time.time() * 1000) % 1000:03d}Z",
        "agent_id": event.get("agent_id"),
        "tool_name": tool,
        "tool_input": redact(event.get("tool_input") or {}),
        "result_ok": not failed,
        "error": error,
    }
    if event.get("tool_use_id"):
        record["tool_use_id"] = event["tool_use_id"]
    if isinstance(event.get("duration_ms"), (int, float)):
        record["duration_ms"] = event["duration_ms"]
    with (runs_dir / f"{run_id}.actions.jsonl").open("a") as fh:
        fh.write(json.dumps(record) + "\n")


def main() -> None:
    plugin_data = os.environ.get("CLAUDE_PLUGIN_DATA")
    if not plugin_data:
        return
    event = json.loads(sys.stdin.read() or "{}")
    if isinstance(event, dict):
        handle(event, Path(plugin_data) / "runs")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
    sys.exit(0)
