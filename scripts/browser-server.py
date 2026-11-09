#!/usr/bin/env python3
"""One of the plugin's own isolated browsers: a lazy stdio proxy in front of
a pinned Playwright MCP server.

Claude Code starts every plugin MCP server at session start. Six idle
Playwright MCP servers cost about 1.2 GB (npm exec plus node, about 208 MB
each, measured on 2026-11-03), so this proxy answers the MCP handshake and
tools/list itself, from the tool list pinned in browser/tools.json, and
starts the real server only on the first tool call. Idle cost is one small
Python process. After ``idle_stop_minutes`` without a tool call the real
server is stopped again (which also finalizes any open video).

The real server runs as (addendum D3):

    npx -y @playwright/mcp@0.0.84 [--headless] --isolated --no-webmcp
        --viewport-size 1280x900 --user-agent "<pinned desktop Chrome>"
        --config <data>/browser/<name>/config.json
        --output-dir <data>/browser/<name>
        --init-script browser/figma-proto-init.js

The config is browser/playwright.config.json with recordVideo.dir set to
<data>/browser/<name>/videos: an absolute path is required, because a
relative one resolves against the session's working directory (the user's
project), and without one Playwright keeps videos in a temporary folder it
deletes.

Usage:  browser-server.py <name> [--headed]
        browser-server.py <name> --capture-tools   (refresh browser/tools.json)

Stdlib only. ARCHETYPE_BROWSER_COMMAND (a JSON list) replaces the npx
command, for tests.
"""

from __future__ import annotations

import json
import os
import queue
import re
import signal
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))
import browser_engine  # noqa: E402  (stdlib sibling: Chrome, else bundled Chromium)
PINNED = json.loads((ROOT / "browser" / "pinned.json").read_text())
TOOLS_FILE = ROOT / "browser" / "tools.json"
CONFIG_TEMPLATE = ROOT / "browser" / "playwright.config.json"
# Makes Figma prototypes readable and clickable; a no-op on every other site.
INIT_SCRIPT = ROOT / "browser" / "figma-proto-init.js"
HANDSHAKE_ID = "archetype-browser-init"
START_TIMEOUT = float(os.environ.get("ARCHETYPE_BROWSER_START_TIMEOUT", "180"))
# How long Playwright gets to close the browser (and write the videos) after
# its stdin closes, before its process group is terminated, then killed.
STOP_TIMEOUT = float(os.environ.get("ARCHETYPE_BROWSER_STOP_TIMEOUT", "15"))
IDLE_STOP = float(os.environ.get("ARCHETYPE_BROWSER_IDLE_MINUTES", PINNED.get("idle_stop_minutes", 15))) * 60


def log(msg: str) -> None:
    sys.stderr.write(f"[archetype-browser] {msg}\n")
    sys.stderr.flush()


def data_dir() -> Path:
    plugin_data = os.environ.get("CLAUDE_PLUGIN_DATA")
    return Path(plugin_data) if plugin_data else Path(tempfile.gettempdir()) / "archetype-plugin-data"


def prepare(name: str) -> tuple[Path, Path]:
    """Write this server's config with an absolute video folder."""
    out = data_dir() / "browser" / name
    videos = out / "videos"
    videos.mkdir(parents=True, exist_ok=True)
    config = json.loads(CONFIG_TEMPLATE.read_text())
    record = config.setdefault("browser", {}).setdefault("contextOptions", {}).setdefault("recordVideo", {})
    record["dir"] = str(videos)
    config_path = out / "config.json"
    config_path.write_text(json.dumps(config, indent=2) + "\n")
    return out, config_path


def child_command(name: str, headed: bool, engine: dict[str, Any] | None = None) -> list[str]:
    out, config_path = prepare(name)
    override = os.environ.get("ARCHETYPE_BROWSER_COMMAND")
    prefix = json.loads(override) if override else ["npx", "-y", PINNED["package"]]
    args = [] if headed else ["--headless"]
    args += list((engine or {}).get("args") or [])
    args += [
        "--isolated", "--no-webmcp",
        "--viewport-size", PINNED["viewport"],
        "--user-agent", PINNED["user_agent"],
        "--config", str(config_path),
        "--output-dir", str(out),
        "--init-script", str(INIT_SCRIPT),
    ]
    return prefix + args


class Proxy:
    def __init__(self, name: str, headed: bool) -> None:
        self.name = name
        self.headed = headed
        self.out_lock = threading.Lock()
        self.child: subprocess.Popen | None = None
        self.child_lock = threading.Lock()
        self.init_params: dict[str, Any] | None = None
        self.client_initialized = False
        self.pending: set[Any] = set()
        self.handshake: "queue.Queue[dict]" = queue.Queue()
        self.last_call = time.monotonic()
        self.server_hello: dict[str, Any] = {}
        self.start_error: str | None = None
        cached = {}
        try:
            cached = json.loads(TOOLS_FILE.read_text())
        except (OSError, ValueError):
            log("no pinned tool list; the real server starts at the first tools/list")
        self.cached = cached if isinstance(cached, dict) and cached.get("tools") else None

    # ---- output ----

    def send(self, msg: dict[str, Any]) -> None:
        line = json.dumps(msg) + "\n"
        with self.out_lock:
            sys.stdout.write(line)
            sys.stdout.flush()

    def reply(self, msg_id: Any, result: dict[str, Any]) -> None:
        self.send({"jsonrpc": "2.0", "id": msg_id, "result": result})

    def error(self, msg_id: Any, message: str) -> None:
        self.send({"jsonrpc": "2.0", "id": msg_id, "error": {"code": -32603, "message": message}})

    # ---- the real server ----

    def _write_child(self, msg: dict[str, Any]) -> bool:
        child = self.child
        if child is None or child.stdin is None:
            return False
        try:
            child.stdin.write(json.dumps(msg) + "\n")
            child.stdin.flush()
            return True
        except (OSError, ValueError):
            return False

    def _read_child(self, child: subprocess.Popen) -> None:
        assert child.stdout is not None
        for line in child.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                continue
            if msg.get("id") == HANDSHAKE_ID and "method" not in msg:
                self.handshake.put(msg)
                continue
            if "method" not in msg and msg.get("id") is not None:
                self.pending.discard(msg.get("id"))
            self.send(msg)
        # The real server went away: answer what it never will.
        with self.child_lock:
            if self.child is child:
                self.child = None
        for msg_id in list(self.pending):
            self.pending.discard(msg_id)
            self.error(msg_id, f"{self.name}: the browser server stopped; call the tool again to restart it")

    def ensure_child(self) -> bool:
        with self.child_lock:
            if self.child is not None and self.child.poll() is None:
                return True
            engine = browser_engine.pick()
            if engine.get("error"):
                self.start_error = engine["error"]
                log(engine["error"])
                return False
            self.start_error = None
            cmd = child_command(self.name, self.headed, engine)
            log(f"starting {' '.join(cmd[:4])} ... for {self.name} on {engine['label']}")
            try:
                child = subprocess.Popen(
                    cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=sys.stderr,
                    text=True, bufsize=1, start_new_session=True,
                )
            except OSError as exc:
                log(f"could not start the browser server: {exc}")
                return False
            self.child = child
            while not self.handshake.empty():
                self.handshake.get_nowait()
            threading.Thread(target=self._read_child, args=(child,), daemon=True).start()
            params = self.init_params or {
                "protocolVersion": "2025-06-18", "capabilities": {},
                "clientInfo": {"name": "archetype-browser", "version": "1"},
            }
            self._write_child({"jsonrpc": "2.0", "id": HANDSHAKE_ID, "method": "initialize", "params": params})
            try:
                answer = self.handshake.get(timeout=START_TIMEOUT)
            except queue.Empty:
                log(f"the browser server did not answer initialize within {START_TIMEOUT:g} s")
                self._stop_locked()
                return False
            if "error" in answer:
                log(f"initialize failed: {answer['error']}")
                self._stop_locked()
                return False
            self.server_hello = answer.get("result") or {}
            if self.client_initialized:
                self._write_child({"jsonrpc": "2.0", "method": "notifications/initialized"})
            return True

    def _stop_locked(self) -> None:
        child, self.child = self.child, None
        if child is None:
            return
        try:
            if child.stdin:
                child.stdin.close()  # Playwright closes the browser: videos are written out
        except OSError:
            pass  # it is already gone: the wait below returns at once
        try:
            child.wait(timeout=STOP_TIMEOUT)
            return
        except subprocess.TimeoutExpired:
            pass
        # npx, node and Chrome share the group start_new_session gave them.
        for sig, wait in ((signal.SIGTERM, 5), (signal.SIGKILL, 5)):
            log(f"{self.name}: the browser server did not stop; sending {sig.name} to its process group")
            try:
                os.killpg(child.pid, sig)
            except ProcessLookupError:
                return  # no process left in the group: it is gone and reaped
            except OSError as exc:
                log(f"{self.name}: could not signal the browser server: {exc}")
                child.kill()
            try:
                child.wait(timeout=wait)
                return
            except subprocess.TimeoutExpired:
                continue
        log(f"{self.name}: the browser server (pid {child.pid}) is still running after SIGKILL")

    def stop(self) -> None:
        with self.child_lock:
            self._stop_locked()

    def idle_watch(self) -> None:
        while True:
            time.sleep(min(60, max(IDLE_STOP / 4, 1)))
            if self.child is not None and not self.pending and time.monotonic() - self.last_call > IDLE_STOP:
                log(f"{self.name}: idle for {IDLE_STOP / 60:g} min, stopping the browser server")
                self.stop()

    # ---- client messages ----

    def forward(self, msg: dict[str, Any]) -> None:
        msg_id = msg.get("id")
        if not self.ensure_child():
            if msg_id is not None:
                self.error(msg_id, f"{self.name}: {self.start_error}" if self.start_error else
                           f"{self.name}: the Playwright browser could not start "
                           "(Node 18 or newer and network access to npm are needed)")
            return
        if msg_id is not None and "method" in msg:
            self.pending.add(msg_id)
        if not self._write_child(msg) and msg_id is not None:
            self.pending.discard(msg_id)
            self.error(msg_id, f"{self.name}: the browser server is not answering")

    def handle(self, msg: dict[str, Any]) -> None:
        method, msg_id = msg.get("method"), msg.get("id")
        trace = os.environ.get("ARCHETYPE_BROWSER_TRACE")
        if trace:
            try:
                with open(trace, "a") as fh:
                    fh.write(f"{time.time():.3f} {self.name} {method or 'response'} running={self.child is not None}\n")
            except OSError:
                pass
        if method is None:
            # A client answer to a request the real server made (roots/list).
            if self.child is not None:
                self._write_child(msg)
            return
        if method == "initialize":
            self.init_params = msg.get("params") or {}
            if self.cached:
                info = dict(self.cached.get("serverInfo") or {"name": "Playwright"})
                info["name"] = f"{info.get('name', 'Playwright')} ({self.name})"
                self.reply(msg_id, {
                    "protocolVersion": self.init_params.get("protocolVersion") or "2025-06-18",
                    "capabilities": self.cached.get("capabilities") or {"tools": {}},
                    "serverInfo": info,
                })
            else:
                self.forward(msg)
            return
        if method == "notifications/initialized":
            self.client_initialized = True
            if self.child is not None:
                self._write_child(msg)
            return
        if method == "ping" and self.child is None:
            self.reply(msg_id, {})
            return
        if method == "tools/list" and self.child is None and self.cached:
            self.reply(msg_id, {"tools": self.cached["tools"]})
            return
        if method.startswith("notifications/"):
            if self.child is not None:
                self._write_child(msg)
            return
        if method != "tools/call" and self.child is None and self.cached:
            # The pinned server offers tools only, and answers anything else
            # (server/discover, resources/list, prompts/list...) this way.
            self.send({"jsonrpc": "2.0", "id": msg_id,
                       "error": {"code": -32601, "message": "Method not found"}})
            return
        self.last_call = time.monotonic()
        self.forward(msg)

    def run(self) -> int:
        threading.Thread(target=self.idle_watch, daemon=True).start()
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(msg, dict):
                # Tool calls go through a thread: starting the real server can
                # take a while and must not hold up pings or cancellations.
                if msg.get("method") == "tools/call" and self.child is None:
                    threading.Thread(target=self.handle, args=(msg,), daemon=True).start()
                else:
                    self.handle(msg)
        self.stop()
        return 0


def capture_tools(name: str) -> int:
    """Start the real server once and pin its handshake and tool list."""
    proxy = Proxy(name, headed=False)
    proxy.cached = None
    if not proxy.ensure_child():
        return 1
    answer_box: "queue.Queue[dict]" = queue.Queue()
    original = proxy.send
    proxy.send = lambda msg: answer_box.put(msg)  # type: ignore[method-assign]
    proxy.pending.add("tools")
    proxy._write_child({"jsonrpc": "2.0", "id": "tools", "method": "tools/list"})
    tools = answer_box.get(timeout=60)
    proxy.send = original  # type: ignore[method-assign]
    hello = proxy.server_hello
    proxy.stop()
    TOOLS_FILE.write_text(json.dumps({
        "package": PINNED["package"],
        "serverInfo": hello.get("serverInfo"),
        "capabilities": hello.get("capabilities"),
        "tools": tools["result"]["tools"],
    }, indent=1) + "\n")
    print(f"pinned {len(tools['result']['tools'])} tools to {TOOLS_FILE}")
    return 0


def main(argv: list[str]) -> int:
    names = [a for a in argv if not a.startswith("--")]
    if len(names) != 1 or not re.match(r"^[a-z0-9-]{1,40}$", names[0]):
        log("usage: browser-server.py <name> [--headed] [--capture-tools]")
        return 2
    if "--capture-tools" in argv:
        return capture_tools(names[0])
    return Proxy(names[0], headed="--headed" in argv).run()


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
