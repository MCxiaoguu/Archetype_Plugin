#!/usr/bin/env python3
"""Tests for scripts/action-hook.py: the raw browser action record.

Each case runs the hook as Claude Code does (JSON on stdin, plugin data in
the environment) and checks what landed under runs/.

Run:  python3 scripts/test_action_hook.py
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

HOOK = Path(__file__).resolve().parent / "action-hook.py"
CORE = "mcp__plugin_archetype_core__"
BROWSER = "mcp__plugin_archetype_archetype-browser-3__"


def run_hook(event, data_dir: Path | None, raw: str | None = None) -> subprocess.CompletedProcess:
    env = {k: v for k, v in os.environ.items() if k != "CLAUDE_PLUGIN_DATA"}
    if data_dir is not None:
        env["CLAUDE_PLUGIN_DATA"] = str(data_dir)
    return subprocess.run(
        [sys.executable, str(HOOK)], input=raw if raw is not None else json.dumps(event),
        capture_output=True, text=True, env=env, timeout=20,
    )


def started(agent: str, run_id: str, session: str = "s1") -> dict:
    text = f"brief...\n\nrunId: {run_id}\nsessionId: plugin-{run_id}\n\nPROTOCOL 2"
    return {"hook_event_name": "PostToolUse", "session_id": session, "agent_id": agent,
            "agent_type": "archetype:feature-validator-headless", "tool_name": CORE + "start_run",
            "tool_input": {"run_id": run_id}, "tool_response": [{"type": "text", "text": text}]}


def browser_call(agent: str, tool: str, tool_input: dict, response=None, event="PostToolUse", **extra) -> dict:
    out = {"hook_event_name": event, "session_id": "s1", "agent_id": agent, "tool_name": tool,
           "tool_input": tool_input, "tool_use_id": "toolu_1", "duration_ms": 42,
           "tool_response": response if response is not None else [{"type": "text", "text": "### Page\n- ok"}]}
    out.update(extra)
    return out


def actions(data_dir: Path, run_id: str) -> list[dict]:
    path = data_dir / "runs" / f"{run_id}.actions.jsonl"
    return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []


class Fail(AssertionError):
    pass


def expect(cond: bool, msg: str) -> None:
    if not cond:
        raise Fail(msg)


def case_writes_after_start_run(d: Path) -> None:
    expect(run_hook(started("agent-a", "run111"), d).returncode == 0, "exit 0")
    active = json.loads((d / "runs" / "active-agent-a.json").read_text())
    expect(active["run_id"] == "run111" and active["session_id"] == "plugin-run111", f"mapping saved: {active}")
    run_hook(browser_call("agent-a", BROWSER + "browser_navigate", {"url": "http://localhost:8321/"}), d)
    run_hook(browser_call("agent-a", BROWSER + "browser_click", {"element": "Start", "ref": "e5"}), d)
    got = actions(d, "run111")
    expect(len(got) == 2, f"two actions recorded, got {len(got)}")
    first = got[0]
    expect(first["tool_name"] == BROWSER + "browser_navigate" and first["tool_input"]["url"] == "http://localhost:8321/",
           f"tool and url kept: {first}")
    expect(first["result_ok"] is True and first["error"] is None, "success recorded")
    expect(first["agent_id"] == "agent-a" and first["tool_use_id"] == "toolu_1" and first["duration_ms"] == 42, "ids kept")
    expect(first["ts"].endswith("Z") and "T" in first["ts"], "timestamp")
    expect(got[1]["tool_input"] == {"element": "Start", "ref": "e5"}, "click target kept")


def case_redacts_typed_text(d: Path) -> None:
    run_hook(started("agent-a", "run222"), d)
    run_hook(browser_call("agent-a", BROWSER + "browser_type", {"ref": "e9", "text": "hunter2-secret", "submit": True}), d)
    run_hook(browser_call("agent-a", BROWSER + "browser_fill_form", {"fields": [
        {"name": "Email", "type": "textbox", "ref": "e1", "value": "me@private.example"},
        {"name": "Card", "type": "textbox", "ref": "e2", "value": "4242424242424242"}]}), d)
    run_hook(browser_call("agent-a", "mcp__claude-in-chrome__computer", {"action": "type", "text": "my phone 555"}), d)
    run_hook(browser_call("agent-a", "mcp__claude-in-chrome__form_input", {"ref": "r1", "value": "Jane Doe"}), d)
    run_hook(browser_call("agent-a", BROWSER + "browser_file_upload", {"paths": ["/Users/me/passport.pdf"]}), d)
    run_hook(browser_call("agent-a", BROWSER + "browser_evaluate", {"function": "() => " + "x" * 500}), d)
    raw = (d / "runs" / "run222.actions.jsonl").read_text()
    for secret in ("hunter2", "me@private.example", "4242424242424242", "555", "Jane Doe", "passport"):
        expect(secret not in raw, f"{secret!r} must not be stored")
    got = actions(d, "run222")
    expect(got[0]["tool_input"]["text"] == "<redacted 14 chars>" and got[0]["tool_input"]["ref"] == "e9",
           f"length kept, target kept: {got[0]['tool_input']}")
    expect(got[1]["tool_input"]["fields"][0]["name"] == "Email", "field names kept")
    expect(got[2]["tool_input"]["action"] == "type", "chrome action kept")
    expect(len(got[5]["tool_input"]["function"]) < 140, "code is cut short")


def case_records_failures(d: Path) -> None:
    run_hook(started("agent-a", "run333"), d)
    run_hook(browser_call("agent-a", BROWSER + "browser_click", {"ref": "e404"},
                          event="PostToolUseFailure", error="Ref e404 not found in the current page snapshot"), d)
    run_hook(browser_call("agent-a", BROWSER + "browser_click", {"ref": "e2"},
                          response=[{"type": "text", "text": "### Error\nstrict mode violation"}]), d)
    run_hook(browser_call("agent-a", BROWSER + "browser_click", {"ref": "e3"},
                          response={"isError": True, "content": [{"type": "text", "text": "Timeout 5000ms"}]}), d)
    got = actions(d, "run333")
    expect([a["result_ok"] for a in got] == [False, False, False], f"three failures, got {got}")
    expect("e404 not found" in got[0]["error"] and "strict mode" in got[1]["error"] and "Timeout" in got[2]["error"],
           "errors kept")


def case_maps_tool_names(d: Path) -> None:
    run_hook(started("agent-b", "run444"), d)
    names = [
        "mcp__plugin_archetype_archetype-browser-1__browser_snapshot",
        "mcp__plugin_archetype_archetype-watch-2__browser_click",
        "mcp__playwright__browser_navigate",
        "mcp__claude-in-chrome__read_page",
    ]
    ignored = ["Bash", "mcp__plugin_archetype_core__get_run", "mcp__other__browser_click",
               "mcp__plugin_other_archetype-browser-1__browser_click"]
    for name in names + ignored:
        run_hook(browser_call("agent-b", name, {}), d)
    got = [a["tool_name"] for a in actions(d, "run444")]
    expect(got == names, f"only browser tools are recorded, got {got}")


def case_agents_and_report(d: Path) -> None:
    run_hook(started("agent-a", "run555"), d)
    run_hook(started("agent-b", "run666"), d)
    run_hook(browser_call("agent-a", BROWSER + "browser_click", {"ref": "a"}), d)
    run_hook(browser_call("agent-b", BROWSER + "browser_click", {"ref": "b"}), d)
    expect([a["tool_input"]["ref"] for a in actions(d, "run555")] == ["a"], "agent a files under its run")
    expect([a["tool_input"]["ref"] for a in actions(d, "run666")] == ["b"], "agent b files under its run")
    done = {"hook_event_name": "PostToolUse", "session_id": "s1", "agent_id": "agent-a",
            "tool_name": CORE + "report_result", "tool_input": {}, "tool_response": [{"type": "text", "text": "Results stored."}]}
    run_hook(done, d)
    expect(not (d / "runs" / "active-agent-a.json").exists(), "report clears the mapping")
    run_hook(browser_call("agent-a", BROWSER + "browser_click", {"ref": "late"}), d)
    expect(len(actions(d, "run555")) == 1, "calls after the report are not filed")
    main = started("", "run777", session="sess-x")
    del main["agent_id"]
    run_hook(main, d)
    expect((d / "runs" / "active-main-sess-x.json").exists(), "the main session is keyed by session id")
    failed_start = started("agent-c", "run888")
    failed_start["tool_response"] = {"isError": True, "content": [{"type": "text", "text": "runId: run888 cannot be claimed"}]}
    run_hook(failed_start, d)
    expect(not (d / "runs" / "active-agent-c.json").exists(), "a failed start_run maps nothing")


def case_never_fails(d: Path) -> None:
    for raw in ("not json", "", "[1,2]", json.dumps({"tool_name": None})):
        result = run_hook(None, d, raw=raw)
        expect(result.returncode == 0 and not result.stdout, f"garbage input exits 0 silently: {raw!r}")
    expect(run_hook(started("a", "run999"), None).returncode == 0, "no plugin data: exit 0")
    blocked = d / "blocked"
    blocked.write_text("a file where a folder should be")
    expect(run_hook(started("a", "run999"), blocked).returncode == 0, "unwritable data dir: exit 0")
    expect(run_hook(browser_call("nobody", BROWSER + "browser_click", {}), d).returncode == 0, "no run yet: exit 0")


CASES = [
    ("writes each browser call under the run start_run announced", case_writes_after_start_run),
    ("redacts typed text, values and uploads", case_redacts_typed_text),
    ("records failed calls with their error", case_records_failures),
    ("maps plugin, Playwright and Chrome tool names; ignores others", case_maps_tool_names),
    ("keeps parallel agents apart; report clears the mapping", case_agents_and_report),
    ("never fails the session", case_never_fails),
]


def main() -> int:
    failures = 0
    for label, fn in CASES:
        with tempfile.TemporaryDirectory() as tmp:
            try:
                fn(Path(tmp))
                print(f"PASS  {label}")
            except Fail as exc:
                failures += 1
                print(f"FAIL  {label}\n        {exc}")
    print("-" * 60)
    if failures:
        print(f"{failures} FAILED ({len(CASES) - failures}/{len(CASES)} passed)")
        return 1
    print(f"ALL PASS ({len(CASES)}/{len(CASES)})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
