#!/usr/bin/env python3
"""Tests for the plugin's browser plumbing: the lazy browser proxy
(browser-server.py), the actor permission hook (permission-hook.py) and the
swarm runner's shadow plugin and worker command (study_runner.py).

The proxy runs against a fake MCP child (no npm, no browser), so the suite
is fast and offline. The real server is proven separately (see
docs/REFERENCE.md, "Browsers").

Run:  python3 scripts/test_browsers.py
"""

from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
PROXY = HERE / "browser-server.py"
PERMISSION = HERE / "permission-hook.py"

FAKE_CHILD = r'''
import json, os, sys
log = os.environ["FAKE_LOG"]
with open(log, "a") as fh:
    fh.write(json.dumps({"argv": sys.argv[1:]}) + "\n")
def send(m):
    sys.stdout.write(json.dumps(m) + "\n"); sys.stdout.flush()
for line in sys.stdin:
    m = json.loads(line)
    with open(log, "a") as fh:
        fh.write(json.dumps({"got": m.get("method") or "response", "id": m.get("id")}) + "\n")
    method = m.get("method")
    if method == "initialize":
        send({"jsonrpc": "2.0", "id": m["id"], "result": {"protocolVersion": "2025-06-18",
              "capabilities": {"tools": {}}, "serverInfo": {"name": "fake", "version": "1"}}})
    elif method == "tools/call":
        name = m["params"]["name"]
        if name == "crash":
            sys.exit(3)
        if name == "ask_roots":
            send({"jsonrpc": "2.0", "id": "roots-1", "method": "roots/list", "params": {}})
            answer = json.loads(sys.stdin.readline())
            send({"jsonrpc": "2.0", "id": m["id"], "result": {"content": [{"type": "text",
                  "text": "roots answered: " + json.dumps(answer.get("result"))}]}})
            continue
        send({"jsonrpc": "2.0", "id": m["id"], "result": {"content": [{"type": "text", "text": "did " + name}]}})
    elif method == "tools/list":
        send({"jsonrpc": "2.0", "id": m["id"], "result": {"tools": [{"name": "live_tool"}]}})
'''


class Fail(AssertionError):
    pass


def expect(cond: bool, msg: str) -> None:
    if not cond:
        raise Fail(msg)


class Proxy:
    def __init__(self, tmp: Path, name: str = "archetype-browser-2", headed: bool = False) -> None:
        self.log = tmp / "child.log"
        fake = tmp / "fake_child.py"
        fake.write_text(FAKE_CHILD)
        env = dict(os.environ, CLAUDE_PLUGIN_DATA=str(tmp / "data"), FAKE_LOG=str(self.log),
                   ARCHETYPE_BROWSER_COMMAND=json.dumps([sys.executable, str(fake)]))
        args = [sys.executable, str(PROXY), name] + (["--headed"] if headed else [])
        self.proc = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                     stderr=subprocess.DEVNULL, text=True, bufsize=1, env=env, cwd=tmp)
        self.next_id = 0

    def write(self, msg: dict) -> None:
        assert self.proc.stdin
        self.proc.stdin.write(json.dumps(msg) + "\n")
        self.proc.stdin.flush()

    def read(self, timeout: float = 15) -> dict:
        box: list = []
        t = threading.Thread(target=lambda: box.append(self.proc.stdout.readline()), daemon=True)
        t.start()
        t.join(timeout)
        expect(bool(box and box[0]), "proxy answered in time")
        return json.loads(box[0])

    def rpc(self, method: str, params: dict | None = None) -> dict:
        self.next_id += 1
        self.write({"jsonrpc": "2.0", "id": self.next_id, "method": method, "params": params or {}})
        while True:
            msg = self.read()
            if msg.get("id") == self.next_id and "method" not in msg:
                return msg

    def child_events(self) -> list[dict]:
        if not self.log.exists():
            return []
        return [json.loads(line) for line in self.log.read_text().splitlines()]

    def close(self) -> int:
        try:
            self.proc.stdin.close()
        except Exception:
            pass
        return self.proc.wait(timeout=20)


def handshake(proxy: Proxy) -> dict:
    hello = proxy.rpc("initialize", {"protocolVersion": "2025-06-18", "capabilities": {"roots": {}},
                                     "clientInfo": {"name": "test", "version": "0"}})
    proxy.write({"jsonrpc": "2.0", "method": "notifications/initialized"})
    return hello


def case_proxy_is_lazy(tmp: Path) -> None:
    proxy = Proxy(tmp)
    try:
        discover = proxy.rpc("server/discover")
        expect(discover.get("error", {}).get("code") == -32601, f"discover answered locally: {discover}")
        hello = handshake(proxy)
        expect("archetype-browser-2" in hello["result"]["serverInfo"]["name"], f"named after the server: {hello}")
        tools = proxy.rpc("tools/list")["result"]["tools"]
        pinned = json.loads((ROOT / "browser" / "tools.json").read_text())["tools"]
        expect(len(tools) == len(pinned) and any(t["name"] == "browser_close" for t in tools),
               "tool list comes from the pinned file")
        expect(proxy.rpc("ping").get("result") == {}, "ping answered locally")
        expect(proxy.rpc("resources/list").get("error", {}).get("code") == -32601, "other requests: method not found")
        expect(proxy.child_events() == [], "no browser server started by the handshake")
    finally:
        proxy.close()


def case_proxy_starts_on_first_call(tmp: Path) -> None:
    proxy = Proxy(tmp)
    try:
        handshake(proxy)
        answer = proxy.rpc("tools/call", {"name": "browser_navigate", "arguments": {"url": "https://example.com"}})
        expect(answer["result"]["content"][0]["text"] == "did browser_navigate", f"forwarded: {answer}")
        events = proxy.child_events()
        argv = events[0]["argv"]
        got = [e.get("got") for e in events[1:]]
        expect(got[:3] == ["initialize", "notifications/initialized", "tools/call"],
               f"handshake replayed before the call: {got}")
        expect("--headless" in argv and "--isolated" in argv and "--no-webmcp" in argv, f"flags: {argv}")
        pinned = json.loads((ROOT / "browser" / "pinned.json").read_text())
        expect(argv[argv.index("--user-agent") + 1] == pinned["user_agent"], "pinned user agent")
        expect("Headless" not in pinned["user_agent"], "the user agent does not say headless")
        expect(argv[argv.index("--viewport-size") + 1] == "1280x900", "viewport")
        out_dir = tmp / "data" / "browser" / "archetype-browser-2"
        expect(argv[argv.index("--output-dir") + 1] == str(out_dir), "output dir under plugin data")
        config = json.loads(Path(argv[argv.index("--config") + 1]).read_text())
        video_dir = config["browser"]["contextOptions"]["recordVideo"]["dir"]
        expect(video_dir == str(out_dir / "videos") and Path(video_dir).is_dir(), f"absolute video folder: {video_dir}")
        second = proxy.rpc("tools/call", {"name": "browser_click", "arguments": {}})
        expect(second["result"]["content"][0]["text"] == "did browser_click", "second call reuses the server")
        expect(sum(1 for e in proxy.child_events() if "argv" in e) == 1, "one browser server per proxy")
        live = proxy.rpc("tools/list")["result"]["tools"]
        expect(live == [{"name": "live_tool"}], "once running, tools/list is the live server's")
    finally:
        proxy.close()


def case_proxy_routes_server_requests(tmp: Path) -> None:
    proxy = Proxy(tmp)
    try:
        handshake(proxy)
        proxy.next_id += 1
        call_id = proxy.next_id
        proxy.write({"jsonrpc": "2.0", "id": call_id, "method": "tools/call", "params": {"name": "ask_roots"}})
        request = proxy.read()
        expect(request.get("method") == "roots/list", f"the server's request reaches the client: {request}")
        proxy.write({"jsonrpc": "2.0", "id": request["id"], "result": {"roots": [{"uri": "file:///tmp"}]}})
        answer = proxy.read()
        expect(answer.get("id") == call_id and "file:///tmp" in answer["result"]["content"][0]["text"],
               f"the client's answer reaches the server: {answer}")
    finally:
        proxy.close()


def case_proxy_survives_a_crash(tmp: Path) -> None:
    proxy = Proxy(tmp)
    try:
        handshake(proxy)
        crashed = proxy.rpc("tools/call", {"name": "crash", "arguments": {}})
        expect("error" in crashed and "stopped" in crashed["error"]["message"], f"pending call answered: {crashed}")
        again = proxy.rpc("tools/call", {"name": "browser_navigate", "arguments": {}})
        expect(again["result"]["content"][0]["text"] == "did browser_navigate", "the next call restarts it")
        expect(sum(1 for e in proxy.child_events() if "argv" in e) == 2, "restarted once")
    finally:
        expect(proxy.close() == 0, "clean exit when the client goes away")


def case_watch_server_is_headed(tmp: Path) -> None:
    proxy = Proxy(tmp, name="archetype-watch-1", headed=True)
    try:
        handshake(proxy)
        proxy.rpc("tools/call", {"name": "browser_navigate", "arguments": {}})
        argv = proxy.child_events()[0]["argv"]
        expect("--headless" not in argv and "--isolated" in argv, f"headed but isolated: {argv}")
    finally:
        proxy.close()


def case_mcp_json_declares_six_servers(_tmp: Path) -> None:
    servers = json.loads((ROOT / ".mcp.json").read_text())["mcpServers"]
    expected = [f"archetype-browser-{i}" for i in range(1, 5)] + ["archetype-watch-1", "archetype-watch-2"]
    expect(sorted(servers) == sorted(expected), f"six servers: {sorted(servers)}")
    for name, spec in servers.items():
        expect(spec["args"][0] == "${CLAUDE_PLUGIN_ROOT}/scripts/browser-server.py" and spec["args"][1] == name,
               f"{name} runs the proxy under its own name")
        expect(("--headed" in spec["args"]) == name.startswith("archetype-watch"), f"{name} headed only for watch")
    pinned = json.loads((ROOT / "browser" / "pinned.json").read_text())
    expect(pinned["package"] == "@playwright/mcp@0.0.84", "pinned package")


def permission(event: dict) -> dict | None:
    out = subprocess.run([sys.executable, str(PERMISSION)], input=json.dumps(event), capture_output=True,
                         text=True, timeout=10)
    expect(out.returncode == 0, "exit 0")
    return json.loads(out.stdout) if out.stdout.strip() else None


def case_permission_hook(_tmp: Path) -> None:
    actor = "archetype:feature-validator-headless"
    allowed = [
        ("mcp__plugin_archetype_archetype-browser-3__browser_click", actor),
        ("mcp__plugin_archetype_archetype-watch-1__browser_snapshot", "archetype:feature-validator"),
        ("mcp__plugin_archetype_core__log_step", actor),
        ("mcp__plugin_archetype_core__start_run", "feature-validator-headless"),
    ]
    not_allowed = [
        ("mcp__plugin_archetype_archetype-browser-3__browser_click", None),
        ("mcp__plugin_archetype_archetype-browser-3__browser_click", "general-purpose"),
        ("mcp__plugin_archetype_archetype-browser-3__browser_run_code_unsafe", actor),
        ("mcp__plugin_archetype_archetype-browser-3__browser_evaluate", actor),
        ("mcp__plugin_archetype_archetype-browser-3__browser_file_upload", actor),
        ("mcp__plugin_archetype_core__logout", actor),
        ("mcp__plugin_archetype_core__dispatch_study", actor),
        ("mcp__plugin_other_archetype-browser-1__browser_click", actor),
        ("mcp__playwright__browser_click", actor),
        ("Bash", actor),
    ]
    for tool, agent in allowed:
        event = {"hook_event_name": "PreToolUse", "tool_name": tool, "tool_input": {}}
        if agent:
            event["agent_type"] = agent
        answer = permission(event)
        expect(answer is not None and answer["hookSpecificOutput"]["permissionDecision"] == "allow",
               f"{tool} for {agent} is allowed: {answer}")
        expect(answer["hookSpecificOutput"]["hookEventName"] == "PreToolUse", "event named")
    for tool, agent in not_allowed:
        event = {"hook_event_name": "PreToolUse", "tool_name": tool, "tool_input": {}}
        if agent:
            event["agent_type"] = agent
        expect(permission(event) is None, f"{tool} for {agent} gets no answer (normal prompt)")
    for raw in ("", "nope", "[]"):
        out = subprocess.run([sys.executable, str(PERMISSION)], input=raw, capture_output=True, text=True, timeout=10)
        expect(out.returncode == 0 and not out.stdout, f"garbage {raw!r}: silent exit 0")


def load_runner():
    spec = importlib.util.spec_from_file_location("study_runner", HERE / "study_runner.py")
    module = importlib.util.module_from_spec(spec)
    assert spec.loader
    spec.loader.exec_module(module)
    return module


def case_runner_shadow_and_command(tmp: Path) -> None:
    runner = load_runner()
    data = tmp / "plugin data"
    shadow = runner.shadow_plugin(ROOT, tmp / "shadow", data)
    manifest = json.loads((shadow / ".claude-plugin" / "plugin.json").read_text())
    core = manifest["mcpServers"]["core"]
    expect(core["command"] == "env" and core["args"][0] == f"CLAUDE_PLUGIN_DATA={data}" and core["args"][1] == "python3",
           f"core server pinned to the real data dir: {core}")
    browsers = json.loads((shadow / ".mcp.json").read_text())["mcpServers"]
    expect(all(s["command"] == "env" for s in browsers.values()), "browser servers wrapped too")
    hooks = json.loads((shadow / "hooks" / "hooks.json").read_text())["hooks"]
    commands = [h["command"] for groups in hooks.values() for g in groups for h in g["hooks"]]
    expect(all(c.startswith(f"CLAUDE_PLUGIN_DATA='{data}' ") for c in commands), f"hooks wrapped: {commands[:1]}")
    expect((shadow / "scripts" / "core-server.py").exists() and (shadow / "browser" / "tools.json").exists(), "copied")
    expect(not (shadow / "demo-apps").exists() and not (shadow / ".git").exists(), "only the plugin parts")
    env = runner.clean_child_env({"CLAUDECODE": "1", "CLAUDE_CODE_ENTRYPOINT": "cli", "CLAUDE_PLUGIN_DATA": "x",
                                  "CLAUDE_PID": "9", "PATH": "/bin", "HOME": "/h"}, {"ARCHETYPE_BACKEND_URL": "http://b"})
    expect(env == {"PATH": "/bin", "HOME": "/h", "ARCHETYPE_BACKEND_URL": "http://b"}, f"markers dropped: {env}")
    args = runner.claude_args("claude", runner.worker_prompt("r-1", 3), shadow, "sonnet")
    expect(args[:3] == ["claude", "-p", "/archetype:validation --run r-1 browser=archetype-browser-3 (headless, unattended)"],
           f"prompt: {args[:3]}")
    for flag in ("--dangerously-skip-permissions", "--no-chrome", "--no-session-persistence", "--verbose"):
        expect(flag in args, f"{flag} set")
    expect(args[args.index("--output-format") + 1] == "stream-json" and args[-2:] == ["--model", "sonnet"], "stream and model")
    expect("--strict-mcp-config" not in args, "never strict MCP config (it drops the plugin servers)")


CASES = [
    ("proxy answers the handshake and tools/list without starting a browser", case_proxy_is_lazy),
    ("proxy starts the pinned server on the first call, video folder absolute", case_proxy_starts_on_first_call),
    ("proxy routes the server's own requests through the client", case_proxy_routes_server_requests),
    ("proxy answers a call the crashed server never will, then restarts", case_proxy_survives_a_crash),
    ("watch servers are headed and still isolated", case_watch_server_is_headed),
    (".mcp.json declares the six servers on the proxy", case_mcp_json_declares_six_servers),
    ("permission hook allows only actor browser and run tools", case_permission_hook),
    ("runner shadow plugin, scrubbed env and worker command", case_runner_shadow_and_command),
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
            except Exception as exc:
                failures += 1
                print(f"FAIL  {label}\n        unexpected: {exc!r}")
    print("-" * 60)
    if failures:
        print(f"{failures} FAILED ({len(CASES) - failures}/{len(CASES)} passed)")
        return 1
    print(f"ALL PASS ({len(CASES)}/{len(CASES)})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
