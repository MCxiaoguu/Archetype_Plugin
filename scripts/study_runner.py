#!/usr/bin/env python3
"""Swarm runner: execute a study's queued runs as unattended `claude -p`
workers, up to --parallel at a time (plan 5.6 mode 3).

Each worker is a fresh Claude Code session that claims one run:

    claude -p "/archetype:validation --run <run_id> browser=archetype-browser-<slot> (headless, unattended)"
        --plugin-dir <shadow copy of this plugin> --dangerously-skip-permissions
        --output-format stream-json --verbose --no-chrome --no-session-persistence [--model M]

with the parent's Claude Code markers removed from its environment. Worker
k drives archetype-browser-k, so parallel workers never share a browser
folder. Output per worker:

    <data>/studies/<study_id>/<run_id>/stream.jsonl   the session's event stream
    <data>/studies/<study_id>/<run_id>/stderr.log
    <data>/studies/<study_id>/runner.json             progress, read by study_status

A plugin loaded with --plugin-dir gets its own data folder, which would not
hold the user's login. The shadow copy wraps every server and hook command
so CLAUDE_PLUGIN_DATA points at the real one (the pattern of Farside's
harness): workers share auth.json.

When the queue is empty the runner asks the backend for the next wave
(POST /api/studies/<id>/runs/next) and runs it, until the backend answers
done. A file named `stop` in the study folder stops new workers from
starting. Stdlib only.

Usage: study_runner.py --study ID --data-dir DIR --backend URL [--runs a,b]
                       [--parallel 2] [--model M] [--timeout-min 30]
                       [--no-next-wave] [--dry-run]
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
SHADOW_PARTS = (".claude-plugin", "agents", "skills", "scripts", "hooks", "browser", ".mcp.json")
MAX_PARALLEL = 4  # one plugin browser server per worker: archetype-browser-1 to -4
NEXT_WAVE_WAIT = float(os.environ.get("ARCHETYPE_RUNNER_WAVE_WAIT", "30"))
NEXT_WAVE_TRIES = 20
_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


def log(msg: str) -> None:
    print(f"[study-runner] {time.strftime('%H:%M:%S')} {msg}", flush=True)


def clean_child_env(base: dict[str, str], extra: dict[str, str]) -> dict[str, str]:
    """Nested sessions inherit markers that change their behavior: drop them."""
    marker = re.compile(r"^(CLAUDECODE|CLAUDE_CODE_.*|CLAUDE_(PID|AGENT_SDK_VERSION|EFFORT|PLUGIN_DATA|PLUGIN_ROOT))$")
    env = {k: v for k, v in base.items() if not marker.match(k)}
    env.update(extra)
    return env


def shadow_plugin(plugin_dir: Path, shadow_dir: Path, data_dir: Path) -> Path:
    """A copy of the plugin whose servers and hooks use ``data_dir``."""
    if shadow_dir.exists():
        shutil.rmtree(shadow_dir)
    shadow_dir.mkdir(parents=True)
    for part in SHADOW_PARTS:
        src = plugin_dir / part
        if src.is_dir():
            shutil.copytree(src, shadow_dir / part, ignore=shutil.ignore_patterns("__pycache__"))
        elif src.is_file():
            shutil.copy2(src, shadow_dir / part)

    def wrap(servers: Any) -> None:
        for server in (servers or {}).values():
            if isinstance(server, dict) and server.get("command"):
                server["args"] = [f"CLAUDE_PLUGIN_DATA={data_dir}", server["command"], *server.get("args", [])]
                server["command"] = "env"

    manifest_file = shadow_dir / ".claude-plugin" / "plugin.json"
    manifest = json.loads(manifest_file.read_text())
    wrap(manifest.get("mcpServers"))
    manifest_file.write_text(json.dumps(manifest, indent=2) + "\n")
    mcp_file = shadow_dir / ".mcp.json"
    if mcp_file.exists():
        mcp = json.loads(mcp_file.read_text())
        wrap(mcp.get("mcpServers"))
        mcp_file.write_text(json.dumps(mcp, indent=2) + "\n")
    hooks_file = shadow_dir / "hooks" / "hooks.json"
    if hooks_file.exists():
        hooks = json.loads(hooks_file.read_text())
        quoted = "'" + str(data_dir).replace("'", "'\\''") + "'"
        for groups in (hooks.get("hooks") or {}).values():
            for group in groups:
                for hook in group.get("hooks", []):
                    if hook.get("type") == "command" and hook.get("command"):
                        hook["command"] = f"CLAUDE_PLUGIN_DATA={quoted} {hook['command']}"
        hooks_file.write_text(json.dumps(hooks, indent=2) + "\n")
    return shadow_dir


def worker_prompt(run_id: str, slot: int) -> str:
    return f"/archetype:validation --run {run_id} browser=archetype-browser-{slot} (headless, unattended)"


def claude_args(claude: str, prompt: str, plugin_dir: Path, model: str | None) -> list[str]:
    # No --strict-mcp-config: it would drop the plugin's own servers.
    args = [claude, "-p", prompt, "--plugin-dir", str(plugin_dir), "--dangerously-skip-permissions",
            "--output-format", "stream-json", "--verbose", "--no-chrome", "--no-session-persistence"]
    return args + (["--model", model] if model else [])


class Runner:
    def __init__(self, opts: argparse.Namespace) -> None:
        self.opts = opts
        self.data_dir = Path(opts.data_dir).resolve()
        self.folder = self.data_dir / "studies" / opts.study
        self.folder.mkdir(parents=True, exist_ok=True)
        self.status_file = self.folder / "runner.json"
        self.lock = threading.Lock()
        self.queue: list[str] = []
        self.free_slots = list(range(1, max(1, min(opts.parallel, MAX_PARALLEL)) + 1))
        self.children: dict[str, subprocess.Popen] = {}
        self.status: dict[str, Any] = {
            "study_id": opts.study, "state": "starting", "pid": os.getpid(),
            "parallel": len(self.free_slots), "started_at": time.time(), "waves": [], "workers": {},
        }
        self.shadow: Path | None = None

    # ---- status ----

    def save(self) -> None:
        with self.lock:
            tmp = self.status_file.with_suffix(".tmp")
            tmp.write_text(json.dumps(self.status, indent=2) + "\n")
            tmp.replace(self.status_file)

    def worker(self, run_id: str, **fields: Any) -> None:
        with self.lock:
            self.status["workers"].setdefault(run_id, {}).update(fields)
        self.save()

    # ---- backend ----

    def token(self) -> str | None:
        try:
            return json.loads((self.data_dir / "auth.json").read_text()).get("access_token")
        except (OSError, ValueError):
            return None

    def post(self, path: str) -> tuple[int, dict[str, Any]]:
        token = self.token()
        req = urllib.request.Request(
            f"{self.opts.backend.rstrip('/')}{path}", data=b"{}", method="POST",
            headers={"Content-Type": "application/json", "Accept": "application/json",
                     "User-Agent": "archetype-claude-plugin/study-runner",
                     **({"Authorization": f"Bearer {token}"} if token else {})},
        )
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                return resp.status, json.loads(resp.read().decode() or "{}")
        except urllib.error.HTTPError as exc:
            try:
                return exc.code, json.loads(exc.read().decode() or "{}")
            except ValueError:
                return exc.code, {}
        except Exception as exc:
            return 0, {"error": "network_error", "message": str(exc)}

    def next_wave(self) -> list[str] | None:
        """Run ids of the next wave, or None when the study has no more."""
        for _ in range(NEXT_WAVE_TRIES):
            status, body = self.post(f"/api/studies/{self.opts.study}/runs/next")
            if status == 409 or status == 0:
                log(f"next wave not ready ({body.get('message') or status}); waiting {NEXT_WAVE_WAIT:g} s")
                time.sleep(NEXT_WAVE_WAIT)
                continue
            if not (200 <= status < 300):
                log(f"next wave failed: {status} {body.get('message') or body.get('error')}")
                return None
            if body.get("done"):
                log(f"no more waves: {body.get('reason') or 'done'}")
                return None
            runs = [r.get("runId") for r in body.get("runs") or [] if isinstance(r, dict)]
            self.status["waves"].append({"wave": body.get("wave"), "runs": runs})
            return [r for r in runs if isinstance(r, str) and _ID.match(r)]
        return None

    # ---- workers ----

    def run_one(self, run_id: str, slot: int) -> None:
        run_dir = self.folder / run_id
        (run_dir / "cwd").mkdir(parents=True, exist_ok=True)
        prompt = worker_prompt(run_id, slot)
        assert self.shadow is not None
        args = claude_args(self.opts.claude, prompt, self.shadow, self.opts.model)
        env = clean_child_env(dict(os.environ), {"ARCHETYPE_BACKEND_URL": self.opts.backend})
        self.worker(run_id, state="running", slot=slot, browser=f"archetype-browser-{slot}",
                    started_at=time.time(), stream=str(run_dir / "stream.jsonl"))
        log(f"run {run_id} on archetype-browser-{slot}")
        timed_out = False
        try:
            with (run_dir / "stream.jsonl").open("w") as out, (run_dir / "stderr.log").open("w") as err:
                child = subprocess.Popen(args, cwd=run_dir / "cwd", env=env, stdout=out, stderr=err,
                                         stdin=subprocess.DEVNULL, start_new_session=True)
                with self.lock:
                    self.children[run_id] = child
                try:
                    code = child.wait(timeout=self.opts.timeout_min * 60)
                except subprocess.TimeoutExpired:
                    timed_out = True
                    self.kill(child)
                    code = child.wait()
        except OSError as exc:
            log(f"could not start claude for {run_id}: {exc}")
            code = None
        finally:
            with self.lock:
                self.children.pop(run_id, None)
        state = "timed_out" if timed_out else "finished" if code == 0 else "failed"
        self.worker(run_id, state=state, exit_code=code, finished_at=time.time(),
                    stream_events=self._count_lines(run_dir / "stream.jsonl"))
        log(f"run {run_id} {state} (exit {code})")

    @staticmethod
    def _count_lines(path: Path) -> int:
        try:
            return sum(1 for line in path.read_text().splitlines() if line.strip())
        except OSError:
            return 0

    @staticmethod
    def kill(child: subprocess.Popen) -> None:
        for sig in (signal.SIGTERM, signal.SIGKILL):
            try:
                os.killpg(child.pid, sig)
            except (OSError, ProcessLookupError):
                return
            try:
                child.wait(timeout=10)
                return
            except subprocess.TimeoutExpired:
                continue

    def drain(self) -> None:
        threads: list[threading.Thread] = []
        while self.queue or threads:
            threads = [t for t in threads if t.is_alive()]
            stop = (self.folder / "stop").exists()
            while self.queue and self.free_slots and not stop:
                run_id = self.queue.pop(0)
                slot = self.free_slots.pop(0)

                def go(rid: str = run_id, s: int = slot) -> None:
                    try:
                        self.run_one(rid, s)
                    finally:
                        with self.lock:
                            self.free_slots.append(s)
                            self.free_slots.sort()

                thread = threading.Thread(target=go, daemon=True)
                thread.start()
                threads.append(thread)
            if stop and self.queue:
                log(f"stop file found: {len(self.queue)} queued run(s) not started")
                for rid in self.queue:
                    self.worker(rid, state="not_started")
                self.queue.clear()
            time.sleep(0.2)

    def run(self) -> int:
        runs = [r for r in (self.opts.runs or "").split(",") if r]
        bad = [r for r in runs if not _ID.match(r)]
        if bad:
            log(f"not run ids: {bad}")
            return 2
        self.shadow = shadow_plugin(ROOT, self.folder / "plugin", self.data_dir)
        self.status["waves"].append({"wave": "current", "runs": runs})
        for rid in runs:
            self.worker(rid, state="queued")
        if self.opts.dry_run:
            for i, rid in enumerate(runs):
                slot = i % len(self.free_slots) + 1
                print(" ".join(claude_args(self.opts.claude, worker_prompt(rid, slot), self.shadow, self.opts.model)))
            self.status["state"] = "dry_run"
            self.save()
            return 0
        self.status["state"] = "running"
        self.save()

        def on_signal(signum: int, _frame: Any) -> None:
            log(f"signal {signum}: stopping workers")
            (self.folder / "stop").write_text("signal\n")
            with self.lock:
                children = list(self.children.values())
            for child in children:
                self.kill(child)

        signal.signal(signal.SIGTERM, on_signal)
        signal.signal(signal.SIGINT, on_signal)
        self.queue = list(runs)
        while True:
            self.drain()
            if self.opts.no_next_wave or (self.folder / "stop").exists():
                break
            more = self.next_wave()
            if not more:
                break
            for rid in more:
                self.worker(rid, state="queued")
            self.queue = list(more)
        workers = self.status["workers"].values()
        self.status["state"] = "finished"
        self.status["finished_at"] = time.time()
        self.status["summary"] = {s: sum(1 for w in workers if w.get("state") == s)
                                  for s in ("finished", "failed", "timed_out", "not_started")}
        self.save()
        log(f"done: {self.status['summary']}")
        return 0


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--study", required=True)
    parser.add_argument("--data-dir", default=os.environ.get("CLAUDE_PLUGIN_DATA"))
    parser.add_argument("--backend", default=os.environ.get("ARCHETYPE_BACKEND_URL", "https://api.syntheticarchetype.com"))
    parser.add_argument("--runs", default="", help="comma separated run ids of the current wave")
    parser.add_argument("--parallel", type=int, default=2)
    parser.add_argument("--model")
    parser.add_argument("--timeout-min", type=float, default=30)
    parser.add_argument("--claude", default=os.environ.get("ARCHETYPE_CLAUDE_BIN", "claude"))
    parser.add_argument("--no-next-wave", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    opts = parser.parse_args(argv)
    if not _ID.match(opts.study):
        parser.error("--study must be a study id")
    if not opts.data_dir:
        parser.error("--data-dir (or CLAUDE_PLUGIN_DATA) is required: it holds auth.json")
    return Runner(opts).run()


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
