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
    def __init__(self, tmp: Path, name: str = "archetype-browser-2", headed: bool = False,
                 env_extra: dict | None = None) -> None:
        self.log = tmp / "child.log"
        fake = tmp / "fake_child.py"
        fake.write_text(FAKE_CHILD)
        env = dict(os.environ, CLAUDE_PLUGIN_DATA=str(tmp / "data"), FAKE_LOG=str(self.log),
                   ARCHETYPE_BROWSER_COMMAND=json.dumps([sys.executable, str(fake)]))
        env.update(env_extra or {})
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
        init = Path(argv[argv.index("--init-script") + 1])
        expect(init.is_absolute() and init.name == "figma-proto-init.js" and init.exists(), f"prototype init script: {init}")
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


STUBBORN_CHILD = r'''
import json, os, signal, sys, time
signal.signal(signal.SIGTERM, signal.SIG_IGN)
with open(os.environ["FAKE_LOG"], "a") as fh:
    fh.write(json.dumps({"pid": os.getpid()}) + "\n")
for line in sys.stdin:
    m = json.loads(line)
    if m.get("method") == "initialize":
        sys.stdout.write(json.dumps({"jsonrpc": "2.0", "id": m["id"], "result": {"protocolVersion": "2025-06-18",
                         "capabilities": {"tools": {}}, "serverInfo": {"name": "stubborn", "version": "1"}}}) + "\n")
    elif m.get("method") == "tools/call":
        sys.stdout.write(json.dumps({"jsonrpc": "2.0", "id": m["id"], "result": {"content": []}}) + "\n")
    sys.stdout.flush()
while True:  # a browser that hangs on close: ignores the closed stdin and SIGTERM
    time.sleep(1)
'''


def case_proxy_never_leaves_a_hung_browser_behind(tmp: Path) -> None:
    stubborn = tmp / "stubborn.py"
    stubborn.write_text(STUBBORN_CHILD)
    proxy = Proxy(tmp, env_extra={"ARCHETYPE_BROWSER_COMMAND": json.dumps([sys.executable, str(stubborn)]),
                                  "ARCHETYPE_BROWSER_STOP_TIMEOUT": "1"})
    handshake(proxy)
    proxy.rpc("tools/call", {"name": "browser_navigate", "arguments": {}})
    pid = proxy.child_events()[0]["pid"]
    try:
        expect(proxy.close() == 0, "the proxy exits")
        deadline = time.monotonic() + 10
        alive = True
        while alive and time.monotonic() < deadline:
            try:
                os.kill(pid, 0)
                time.sleep(0.2)
            except ProcessLookupError:
                alive = False
        expect(not alive, "a browser server that ignores the closed stdin and SIGTERM is killed, not orphaned")
    finally:
        try:
            os.kill(pid, 9)
        except OSError:
            pass


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


def fake_browsers(tmp: Path, chrome: bool, revisions: tuple[int, ...]) -> dict:
    """Environment pointing browser_engine at a fake Chrome and a fake cache."""
    chrome_path = tmp / "Google Chrome"
    if chrome:
        chrome_path.write_text("")
    cache = tmp / "ms-playwright"
    for rev in revisions:
        binary = cache / f"chromium-{rev}" / "chrome-linux64" / "chrome"
        binary.parent.mkdir(parents=True)
        binary.write_text("#!/bin/sh\n")
        binary.chmod(0o755)
    (cache / "chromium_headless_shell-9999").mkdir(parents=True, exist_ok=True)  # not a full Chromium
    return {"ARCHETYPE_CHROME_PATHS": str(chrome_path), "PLAYWRIGHT_BROWSERS_PATH": str(cache)}


def pick_with(env: dict) -> dict:
    saved = {k: os.environ.get(k) for k in env}
    os.environ.update(env)
    try:
        sys.path.insert(0, str(ROOT / "scripts"))
        import browser_engine
        return browser_engine.pick()
    finally:
        for k, v in saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


def case_engine_order(tmp: Path) -> None:
    (tmp / "a").mkdir(); (tmp / "b").mkdir(); (tmp / "c").mkdir()
    chrome = pick_with(fake_browsers(tmp / "a", chrome=True, revisions=(1200,)))
    expect(chrome["engine"] == "chrome" and chrome["args"] == ["--browser", "chrome"], f"Chrome first: {chrome}")
    bundled = pick_with(fake_browsers(tmp / "b", chrome=False, revisions=(1200, 1300)))
    expect(bundled["engine"] == "chromium" and bundled["label"] == "bundled chromium 1300", f"newest Chromium: {bundled}")
    expect(bundled["args"][:3] == ["--browser", "chromium", "--executable-path"]
           and bundled["args"][3].endswith("chromium-1300/chrome-linux64/chrome"), f"its binary: {bundled}")
    none = pick_with(fake_browsers(tmp / "c", chrome=False, revisions=()))
    expect("npx playwright install chromium" in none.get("error", ""), f"install hint: {none}")


def case_proxy_falls_back_to_bundled_chromium(tmp: Path) -> None:
    proxy = Proxy(tmp, env_extra=fake_browsers(tmp, chrome=False, revisions=(1248,)))
    try:
        handshake(proxy)
        answer = proxy.rpc("tools/call", {"name": "browser_navigate", "arguments": {"url": "https://example.com"}})
        expect(answer["result"]["content"][0]["text"] == "did browser_navigate", f"forwarded: {answer}")
        argv = proxy.child_events()[0]["argv"]
        expect(argv[argv.index("--browser") + 1] == "chromium", f"chromium engine: {argv}")
        expect(argv[argv.index("--executable-path") + 1].endswith("chromium-1248/chrome-linux64/chrome"), "bundled binary")
    finally:
        proxy.close()


def case_proxy_without_a_browser_says_how_to_install(tmp: Path) -> None:
    proxy = Proxy(tmp, env_extra=fake_browsers(tmp, chrome=False, revisions=()))
    try:
        handshake(proxy)
        answer = proxy.rpc("tools/call", {"name": "browser_navigate", "arguments": {"url": "https://example.com"}})
        message = answer.get("error", {}).get("message", "")
        expect("archetype-browser-2: No browser" in message and "npx playwright install chromium" in message,
               f"clear error: {answer}")
        expect(proxy.child_events() == [], "no server started without a browser")
    finally:
        proxy.close()


def case_recorded_config_names_the_engine(tmp: Path) -> None:
    env = dict(os.environ, **fake_browsers(tmp, chrome=False, revisions=(1248,)))
    code = ("import importlib.util,json,sys; s=importlib.util.spec_from_file_location('c', sys.argv[1]); "
            "m=importlib.util.module_from_spec(s); s.loader.exec_module(m); "
            "print(json.dumps(m.browser_config('archetype-browser-3')))")
    out = subprocess.run([sys.executable, "-c", code, str(ROOT / "scripts" / "core-server.py")],
                         capture_output=True, text=True, env=env, timeout=30)
    config = json.loads(out.stdout.strip().splitlines()[-1])
    expect("bundled chromium 1248" in config["version"] and config["engine"] == "playwright", f"version names it: {config}")


# ---- swarm runner against a stub backend ----

RUNNER_WORKER = r"""#!/usr/bin/env python3
import json, os, sys, time, urllib.error, urllib.request
prompt = sys.argv[sys.argv.index("-p") + 1]
run_id = prompt.split("--run ")[1].split()[0]
plan = json.load(open(os.environ["RUNNER_PLAN"])).get(run_id, "report")
base = os.environ["ARCHETYPE_BACKEND_URL"]
calls = []
def emit(event):
    print(json.dumps(event), flush=True)
def call(name, args=None):
    calls.append(name)
    tool_id = f"toolu_{len(calls)}"
    emit({"type": "assistant", "message": {"content": [{"type": "tool_use", "id": tool_id, "name": name,
                                                        "input": args or {}}]}})
    return tool_id
def answer(tool_id, text, error=False):
    emit({"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": tool_id,
                                                   "is_error": error, "content": [{"type": "text", "text": text}]}]}})
if plan == "exit":
    sys.exit(0)
claim = call("mcp__plugin_archetype_core__start_run", {"run_id": run_id, "browser": "archetype-browser-1"})
try:
    urllib.request.urlopen(urllib.request.Request(f"{base}/claim/{run_id}", data=b"{}", method="POST"))
except urllib.error.HTTPError:
    answer(claim, f"Run {run_id} cannot be claimed: it is running, not queued. Another actor owns it.", error=True)
    sys.exit(0)
answer(claim, f"YOUR PERSONA\n...\nrunId: {run_id}\nsessionId: s-{run_id}")
if plan == "claim-exit":
    sys.exit(0)
if plan in ("stall", "slow"):
    call("mcp__plugin_archetype_core__log_step")
    time.sleep(60)
call("mcp__plugin_archetype_core__log_step")
urllib.request.urlopen(urllib.request.Request(f"{base}/done/{run_id}", data=b"{}", method="POST"))
"""


class StubStudy:
    """GET /runs, POST /runs/next, results; workers claim and finish through /claim and /done."""

    def __init__(self, runs: list[str], wave2: dict | None = None) -> None:
        from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

        self.status = {r: "queued" for r in runs}
        self.aborts: dict[str, str] = {}
        self.wave2 = wave2
        self.studies = ["s1"]
        self.listings: list[str] = []
        stub = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def reply(self, code, body):
                data = json.dumps(body).encode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_GET(self):
                if self.path.startswith("/api/studies?"):
                    stub.listings.append(self.path)
                    return self.reply(200, {"studies": [{"studyId": s, "execution": "remote"} for s in stub.studies]})
                rows = [{"runId": r, "status": st, "sessionId": f"s-{r}"} for r, st in stub.status.items()]
                self.reply(200, {"runs": rows})

            def do_POST(self):
                length = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(length) or b"{}")
                parts = self.path.strip("/").split("/")
                if parts[0] == "claim":
                    if stub.status.get(parts[1]) != "queued":
                        return self.reply(409, {"error": "already_claimed", "message": "not queued"})
                    stub.status[parts[1]] = "running"
                    return self.reply(200, {})
                if parts[0] == "done":
                    stub.status[parts[1]] = "completed"
                    return self.reply(200, {})
                if self.path.endswith("/runs/next"):
                    if stub.wave2 and not any(r in stub.status for r in stub.wave2["runs_ids"]):
                        for r in stub.wave2["runs_ids"]:
                            stub.status[r] = "queued"
                        for r in stub.wave2.get("taken", []):
                            stub.status[r] = "running"  # claimed by another actor right away
                        return self.reply(201, stub.wave2["body"])
                    return self.reply(200, {"done": True, "reason": "no more"})
                if self.path.endswith("/results"):
                    run_id = parts[-2]
                    assert body["sessionId"] == f"s-{run_id}" and body["status"] == "aborted"
                    stub.status[run_id] = "aborted"
                    stub.aborts[run_id] = body["abortReason"]
                    return self.reply(200, {})
                return self.reply(404, {})

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"

    def close(self) -> None:
        self.server.shutdown()


def run_runner(tmp: Path, stub: StubStudy, runs: list[str], plan: dict, *extra: str, code: int = 0) -> dict:
    worker = tmp / "claude"
    worker.write_text(RUNNER_WORKER)
    worker.chmod(0o755)
    (tmp / "plan.json").write_text(json.dumps(plan))
    data = tmp / "data"
    data.mkdir(exist_ok=True)
    (data / "auth.json").write_text(json.dumps({"access_token": "t"}))
    env = dict(os.environ, RUNNER_PLAN=str(tmp / "plan.json"), ARCHETYPE_RUNNER_WATCH_S="0.2",
               ARCHETYPE_RUNNER_WAVE_WAIT="0.1")
    args = [sys.executable, str(HERE / "study_runner.py"), "--study", "s1", "--data-dir", str(data),
            "--backend", stub.url, "--runs", ",".join(runs), "--parallel", "2", "--claude", str(worker), *extra]
    out = subprocess.run(args, env=env, capture_output=True, text=True, timeout=120)
    expect(out.returncode == code, f"runner exit {out.returncode}, not {code}: {out.stdout[-600:]} {out.stderr[-600:]}")
    return json.loads((data / "studies" / "s1" / "runner.json").read_text())


def case_runner_aborts_orphans(tmp: Path) -> None:
    stub = StubStudy(["r-ok", "r-gone", "r-stall"])
    try:
        started = time.monotonic()
        status = run_runner(tmp, stub, ["r-ok", "r-gone", "r-stall"], {"r-gone": "claim-exit", "r-stall": "stall"},
                            "--stall-min", "0.05", code=1)
        expect(time.monotonic() - started < 30, "the stalled worker did not hold the study")
        expect(stub.status == {"r-ok": "completed", "r-gone": "aborted", "r-stall": "aborted"}, f"statuses: {stub.status}")
        expect(stub.aborts == {"r-gone": "worker exited without reporting",
                               "r-stall": "claimed but no step for 0.05 minutes"}, f"reasons: {stub.aborts}")
        expect(status["workers"]["r-stall"]["state"] == "stalled", f"stalled state: {status['workers']['r-stall']}")
        expect(status["workers"]["r-ok"]["claim"] == "won", f"claim recorded: {status['workers']['r-ok']}")
        expect(status["summary"]["aborted"] == 2, f"summary: {status['summary']}")
    finally:
        stub.close()


def case_runner_aborts_only_runs_its_workers_claimed(tmp: Path) -> None:
    stub = StubStudy(["r-ok", "r-taken", "r-early"])
    stub.status["r-taken"] = "running"  # another runner's worker claimed it a moment ago
    try:
        status = run_runner(tmp, stub, ["r-ok", "r-taken", "r-early"], {"r-early": "exit"}, code=1)
        expect(stub.aborts == {}, f"no run aborted: {stub.aborts}")
        expect(stub.status == {"r-ok": "completed", "r-taken": "running", "r-early": "queued"},
               f"the other actor's run is still running, the unclaimed one still queued: {stub.status}")
        workers = status["workers"]
        expect(workers["r-taken"]["claim"] == "lost" and workers["r-early"]["claim"] == "none",
               f"claims: {workers['r-taken']} {workers['r-early']}")
        expect(any("r-early" in p for p in status["problems"]) and not any("r-taken" in p for p in status["problems"]),
               f"the unclaimed run is a problem, the lost claim is not: {status['problems']}")
    finally:
        stub.close()


def case_runner_budget_runs_the_highest_priority_wave_two_runs(tmp: Path) -> None:
    wave2 = {"runs_ids": ["w2-steps", "w2-out-a", "w2-frus", "w2-out-b"], "body": {
        "wave": 2,
        "runs": [{"runId": "w2-steps", "archetypeId": "A"}, {"runId": "w2-out-a", "archetypeId": "B"},
                 {"runId": "w2-frus", "archetypeId": "C"}, {"runId": "w2-out-b", "archetypeId": "B"}],
        "reasons": [{"archetypeId": "A", "reason": "14 steps vs baseline median 10"},
                    {"archetypeId": "B", "reason": "did not complete while the baseline majority completed"},
                    {"archetypeId": "C", "reason": "frustration 35 vs baseline median 10"}]},
        "taken": ["w2-steps"]}
    stub = StubStudy(["w1-a", "w1-b"], wave2=wave2)
    try:
        status = run_runner(tmp, stub, ["w1-a", "w1-b"], {}, "--max-runs", "4")
        ran = sorted(r for r, w in status["workers"].items() if w.get("state") == "finished")
        expect(ran == ["w1-a", "w1-b", "w2-out-a", "w2-out-b"], f"outcome disagreements first: {ran}")
        expect(stub.aborts == {"w2-frus": "not run: the run budget of 4 was spent"}, f"budget: {stub.aborts}")
        expect(stub.status["w2-steps"] == "running", "a run another actor claimed is never aborted for the budget")
    finally:
        stub.close()


def start_watcher(tmp: Path, stub: StubStudy, plan: dict) -> tuple[subprocess.Popen, Path]:
    """A --watch service (no --once) against the stub, polling every 0.2 s."""
    worker = tmp / "claude"
    worker.write_text(RUNNER_WORKER)
    worker.chmod(0o755)
    (tmp / "plan.json").write_text(json.dumps(plan))
    data = tmp / "data"
    data.mkdir(exist_ok=True)
    (data / "auth.json").write_text(json.dumps({"access_token": "t"}))
    env = dict(os.environ, RUNNER_PLAN=str(tmp / "plan.json"), ARCHETYPE_RUNNER_WATCH_S="0.2",
               ARCHETYPE_RUNNER_WAVE_WAIT="0.1", ARCHETYPE_WATCH_POLL_S="0.2")
    args = [sys.executable, str(HERE / "study_runner.py"), "--watch", "--data-dir", str(data),
            "--backend", stub.url, "--parallel", "2", "--claude", str(worker)]
    proc = subprocess.Popen(args, env=env, stdout=(tmp / "watch.log").open("w"), stderr=subprocess.STDOUT)
    return proc, data


def wait_for(cond, timeout: float, what: str) -> None:
    deadline = time.monotonic() + timeout
    while not cond():
        expect(time.monotonic() < deadline, f"timed out waiting for {what}")
        time.sleep(0.1)


def case_runner_watch_stops_on_ctrl_c_and_serves_again(tmp: Path) -> None:
    import signal as sig
    stub = StubStudy(["q-1"])
    proc, data = start_watcher(tmp, stub, {})
    try:
        wait_for(lambda: stub.status["q-1"] == "completed", 60, "the first run")
        seen = len(stub.listings)
        wait_for(lambda: len(stub.listings) >= seen + 2, 30, "the watcher to poll again")
        proc.send_signal(sig.SIGINT)
        try:
            code = proc.wait(timeout=15)
        except subprocess.TimeoutExpired:
            raise Fail("Ctrl-C did not stop the watcher once it had served a study: "
                       + (tmp / "watch.log").read_text()[-600:])
        expect(code == 0, f"clean stop: exit {code}")
        expect(not (data / "studies" / "s1" / "stop").exists(), "a signal leaves no stop file behind")
        stub.status["q-2"] = "queued"
        env = dict(os.environ, RUNNER_PLAN=str(tmp / "plan.json"), ARCHETYPE_RUNNER_WATCH_S="0.2",
                   ARCHETYPE_RUNNER_WAVE_WAIT="0.1")
        out = subprocess.run([sys.executable, str(HERE / "study_runner.py"), "--watch", "--once", "--data-dir",
                              str(data), "--backend", stub.url, "--claude", str(tmp / "claude")],
                             env=env, capture_output=True, text=True, timeout=120)
        expect(out.returncode == 0 and stub.status["q-2"] == "completed",
               f"a restarted watcher serves the study again: {stub.status} {out.stdout[-600:]}")
    finally:
        if proc.poll() is None:
            proc.kill()
        stub.close()


def case_runner_watch_sigterm_stops_its_live_worker(tmp: Path) -> None:
    import signal as sig
    stub = StubStudy(["w-slow"])
    proc, data = start_watcher(tmp, stub, {"w-slow": "slow"})
    try:
        stream = data / "studies" / "s1" / "w-slow" / "stream.jsonl"
        wait_for(lambda: stream.exists() and "log_step" in stream.read_text(), 60, "the worker's first step")
        proc.send_signal(sig.SIGTERM)
        try:
            code = proc.wait(timeout=30)
        except subprocess.TimeoutExpired:
            raise Fail("SIGTERM did not stop the watcher: " + (tmp / "watch.log").read_text()[-600:])
        expect(code == 0, f"clean stop: exit {code}")
        expect(stub.aborts == {"w-slow": "the runner was stopped before the worker reported"},
               f"its claimed run is aborted with the reason: {stub.aborts}")
        expect(not (data / "studies" / "s1" / "stop").exists(), "no stop file left behind")
    finally:
        if proc.poll() is None:
            proc.kill()
        stub.close()


def case_runner_leaves_a_study_to_its_live_runner(tmp: Path) -> None:
    stub = StubStudy(["q-a"])
    try:
        worker = tmp / "claude"
        worker.write_text(RUNNER_WORKER)
        worker.chmod(0o755)
        (tmp / "plan.json").write_text("{}")
        data = tmp / "data"
        (data / "studies" / "s1").mkdir(parents=True)
        (data / "auth.json").write_text(json.dumps({"access_token": "t"}))
        # A dispatch_study runner (this test process stands in for it) is serving s1 on this machine.
        live = {"study_id": "s1", "state": "running", "pid": os.getpid(), "workers": {"q-a": {"state": "running"}}}
        (data / "studies" / "s1" / "runner.json").write_text(json.dumps(live))
        env = dict(os.environ, RUNNER_PLAN=str(tmp / "plan.json"), ARCHETYPE_RUNNER_WATCH_S="0.2")
        common = ["--data-dir", str(data), "--backend", stub.url, "--claude", str(worker)]
        out = subprocess.run([sys.executable, str(HERE / "study_runner.py"), "--watch", "--once", *common],
                             env=env, capture_output=True, text=True, timeout=60)
        expect(out.returncode == 0 and stub.status["q-a"] == "queued", f"watch leaves it alone: {stub.status} {out.stdout[-400:]}")
        expect(json.loads((data / "studies" / "s1" / "runner.json").read_text()) == live, "its runner.json untouched")
        expect(not (data / "studies" / "s1" / "plugin").exists(), "its shadow plugin untouched")
        out = subprocess.run([sys.executable, str(HERE / "study_runner.py"), "--study", "s1", "--runs", "q-a", *common],
                             env=env, capture_output=True, text=True, timeout=60)
        expect(out.returncode == 2 and str(os.getpid()) in out.stdout + out.stderr and stub.status["q-a"] == "queued",
               f"a second runner refuses: {out.returncode} {out.stdout[-300:]} {out.stderr[-300:]}")
    finally:
        stub.close()


def case_runner_sends_the_token_only_over_https(tmp: Path) -> None:
    runner = load_runner()
    spec = importlib.util.spec_from_file_location("core_server", HERE / "core-server.py")
    core = importlib.util.module_from_spec(spec)
    assert spec.loader
    spec.loader.exec_module(core)
    for url in ("https://api.syntheticarchetype.com", "http://127.0.0.1:5001", "http://localhost:5001",
                "http://[::1]:5001", "http://api.example.com", "http://10.0.0.5:5001", "https://",
                "file:///etc/passwd", "javascript:alert(1)", "ftp://api.example.com", ""):
        expect(runner.is_safe_url(url) == core._is_safe_url(url), f"same rule as the core server for {url!r}")
    data = tmp / "data"
    data.mkdir()
    (data / "auth.json").write_text(json.dumps({"access_token": "secret-token"}))
    sent: list = []

    class Answer:
        status = 200

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def read(self):
            return b'{"ok": true}'

    def fake_urlopen(req, timeout=None):
        sent.append(req)
        return Answer()

    runner.urllib.request.urlopen = fake_urlopen
    status, body = runner.backend_call("http://api.example.com", data, "GET", "/api/studies")
    expect(status == 0 and body.get("error") == "insecure_backend" and not sent,
           f"no request to a cleartext remote backend: {status} {body} {len(sent)}")
    for url in ("https://api.example.com", "http://127.0.0.1:5001"):
        status, body = runner.backend_call(url, data, "POST", "/api/studies/s1/runs/next")
        expect(status == 200 and body == {"ok": True}, f"{url}: {status} {body}")
        expect(sent[-1].get_header("Authorization") == "Bearer secret-token", f"{url} gets the token")
        expect(sent[-1].data == b"{}" and sent[-1].get_method() == "POST", "a POST sends an empty object")
    out = subprocess.run([sys.executable, str(HERE / "study_runner.py"), "--study", "s1", "--data-dir", str(data),
                          "--backend", "http://api.example.com", "--runs", "r-1", "--dry-run"],
                         capture_output=True, text=True, timeout=30)
    expect(out.returncode == 2 and "https" in out.stderr, f"refuses a cleartext backend up front: {out.stderr[-300:]}")
    expect(not (data / "studies" / "s1").exists(), "nothing prepared for it")


def case_runner_watch_serves_remote_studies(tmp: Path) -> None:
    stub = StubStudy(["q-a", "q-b"])
    stub.status["done-1"] = "completed"
    try:
        worker = tmp / "claude"
        worker.write_text(RUNNER_WORKER)
        worker.chmod(0o755)
        (tmp / "plan.json").write_text("{}")
        data = tmp / "data"
        data.mkdir(exist_ok=True)
        (data / "auth.json").write_text(json.dumps({"access_token": "t"}))
        env = dict(os.environ, RUNNER_PLAN=str(tmp / "plan.json"), ARCHETYPE_RUNNER_WATCH_S="0.2",
                   ARCHETYPE_RUNNER_WAVE_WAIT="0.1")
        args = [sys.executable, str(HERE / "study_runner.py"), "--watch", "--once", "--data-dir", str(data),
                "--backend", stub.url, "--parallel", "2", "--claude", str(worker)]
        out = subprocess.run(args, env=env, capture_output=True, text=True, timeout=120)
        expect(out.returncode == 0, f"watch exit {out.returncode}: {out.stderr[-600:]}")
        expect(stub.listings and "execution=remote" in stub.listings[0] and "status=running" in stub.listings[0],
               f"asks only for remote running studies: {stub.listings}")
        expect(stub.status == {"q-a": "completed", "q-b": "completed", "done-1": "completed"},
               f"queued runs served, finished ones left alone: {stub.status}")
        status = json.loads((data / "studies" / "s1" / "runner.json").read_text())
        expect(sorted(status["workers"]) == ["q-a", "q-b"], f"only queued runs got workers: {sorted(status['workers'])}")
        bad = subprocess.run([sys.executable, str(HERE / "study_runner.py"), "--watch", "--study", "s1",
                              "--data-dir", str(data)], capture_output=True, text=True, timeout=30)
        expect(bad.returncode != 0 and "--watch finds its own studies" in bad.stderr, "watch refuses --study")
    finally:
        stub.close()


CASES = [
    ("proxy answers the handshake and tools/list without starting a browser", case_proxy_is_lazy),
    ("proxy starts the pinned server on the first call, video folder absolute", case_proxy_starts_on_first_call),
    ("proxy routes the server's own requests through the client", case_proxy_routes_server_requests),
    ("proxy answers a call the crashed server never will, then restarts", case_proxy_survives_a_crash),
    ("watch servers are headed and still isolated", case_watch_server_is_headed),
    ("proxy kills a browser server that hangs on close", case_proxy_never_leaves_a_hung_browser_behind),
    (".mcp.json declares the six servers on the proxy", case_mcp_json_declares_six_servers),
    ("permission hook allows only actor browser and run tools", case_permission_hook),
    ("runner shadow plugin, scrubbed env and worker command", case_runner_shadow_and_command),
    ("engine: Chrome, else the newest bundled Chromium, else an install hint", case_engine_order),
    ("proxy launches the bundled Chromium when Chrome is missing", case_proxy_falls_back_to_bundled_chromium),
    ("proxy without any browser answers with the install command", case_proxy_without_a_browser_says_how_to_install),
    ("the recorded browser config names the engine that runs", case_recorded_config_names_the_engine),
    ("runner aborts runs whose worker exited or stalled, with the reason", case_runner_aborts_orphans),
    ("runner aborts only the runs its own workers claimed", case_runner_aborts_only_runs_its_workers_claimed),
    ("runner budget runs the highest priority wave 2 runs, the rest not run", case_runner_budget_runs_the_highest_priority_wave_two_runs),
    ("runner --watch serves every queued run of remote studies", case_runner_watch_serves_remote_studies),
    ("runner sends the token only to an https or loopback backend", case_runner_sends_the_token_only_over_https),
    ("runner --watch stops on Ctrl-C after a study and serves it again later", case_runner_watch_stops_on_ctrl_c_and_serves_again),
    ("runner --watch on SIGTERM stops its live worker and aborts that run", case_runner_watch_sigterm_stops_its_live_worker),
    ("runner leaves a study to the live runner already serving it here", case_runner_leaves_a_study_to_its_live_runner),
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
