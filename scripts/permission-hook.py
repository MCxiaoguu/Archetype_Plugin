#!/usr/bin/env python3
"""PreToolUse hook: let the plugin's actors use their own tools without a
prompt per call.

A plugin's settings.json can only set `agent` and `subagentStatusLine`, so
permission rules cannot ship with the plugin. Background subagents surface
every permission prompt in the main session, which for four parallel
actors means dozens of prompts per minute. This hook answers "allow" for
exactly:

- the browser tools of the plugin's own isolated servers
  (archetype-browser-N, archetype-watch-N), minus the ones that run code,
  read the network or upload local files, and
- the core run tools an actor needs (start_run, log_step, report_result,
  get_run, list_features),

and only when the caller is one of the plugin's actor agents. Everything
else gets no answer from this hook and goes through the normal permission
flow; deny and ask rules the user set still win (Claude Code evaluates them
regardless of a hook's allow). Stdlib only; it never fails the session.
"""

from __future__ import annotations

import json
import re
import sys

# This plugin's actors only: "archetype:<agent>" (or the bare name), never
# another plugin's agent that happens to share the name.
ACTOR_TYPE = re.compile(r"^(archetype:)?feature-validator(-headless)?$")
BROWSER_TOOL = re.compile(r"^mcp__plugin_archetype_archetype-(?:browser|watch)-\d+__(browser_[a-z_]+)$")
NOT_AUTO = {
    "browser_run_code_unsafe", "browser_evaluate", "browser_file_upload",
    "browser_network_requests", "browser_network_request", "browser_drop",
}
CORE_TOOL = re.compile(r"^mcp__plugin_archetype_core__(start_run|log_step|report_result|get_run|list_features)$")


def decision(event: dict) -> dict | None:
    if not ACTOR_TYPE.search(str(event.get("agent_type") or "")):
        return None
    tool = str(event.get("tool_name") or "")
    browser = BROWSER_TOOL.match(tool)
    if browser and browser.group(1) in NOT_AUTO:
        return None
    if not (browser or CORE_TOOL.match(tool)):
        return None
    return {
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "allow",
            "permissionDecisionReason": "Archetype actor using its own isolated browser or run tools",
        }
    }


def main() -> None:
    event = json.loads(sys.stdin.read() or "{}")
    if isinstance(event, dict):
        answer = decision(event)
        if answer:
            print(json.dumps(answer))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
    sys.exit(0)
