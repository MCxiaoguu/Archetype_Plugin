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
starting; SIGTERM or SIGINT (Ctrl-C) stops the running workers too and
leaves no file behind. Stdlib only.

Orphans never hold up a study: when a worker exits (or times out) after
claiming its run while the run is still running on the backend, and when a
worker has logged no step for --stall-min minutes after claiming, the
runner stops it and reports the run as aborted with the reason (the report
lists it as excluded, the next wave proceeds). A run is aborted only when
this runner's own worker claimed it (its start_run answer in the stream):
a run another actor claimed is left alone, and a run no one claimed stays
queued for the next worker. --max-runs caps how many workers this runner
starts: a next wave larger than what is left runs its highest priority
runs (archetypes whose outcome disagreed with the baseline first) and the
rest, while still queued, are aborted with a budget reason. The exit code
is 1 when anything went wrong (a worker failed, timed out or stalled, a
run was aborted or left queued, the next wave never came), else 0.

Watch mode (--watch) serves studies other clients started, such as the
Figma plugin: it polls GET /api/studies?execution=remote&status=running,
runs every queued run of each study (oldest first) with the same workers,
waves and orphan handling, then polls again. --once makes one pass and
exits (for cron or CI; 1 when the pass had a problem). A file named `stop`
in <data>/studies stops it between studies; a study whose own folder has
a `stop` file is skipped; SIGTERM or SIGINT stops it at once.

Usage: study_runner.py --watch --data-dir DIR --backend URL [--once]
                       [--poll-sec 20] [worker options below]
       study_runner.py --study ID --data-dir DIR --backend URL [--runs a,b]
                       [--parallel 2] [--model M] [--timeout-min 30]
                       [--stall-min 20] [--max-runs N]
                       [--no-next-wave] [--dry-run]
"""

from __future__ import annotations

import argparse
import http.client
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
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
SHADOW_PARTS = (".claude-plugin", "agents", "skills", "scripts", "hooks", "browser", ".mcp.json")
MAX_PARALLEL = 4  # one plugin browser server per worker: archetype-browser-1 to -4
NEXT_WAVE_WAIT = float(os.environ.get("ARCHETYPE_RUNNER_WAVE_WAIT", "30"))
NEXT_WAVE_TRIES = 20
WATCH_EVERY = float(os.environ.get("ARCHETYPE_RUNNER_WATCH_S", "30"))
_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


def log(msg: str) -> None:
    print(f"[study-runner] {time.strftime('%H:%M:%S')} {msg}", flush=True)


def is_safe_url(url: str) -> bool:
    """True for https URLs, or plain http only on the loopback interface:
    the rule of core-server.py's _is_safe_url, so the runner never sends the
    bearer token in cleartext either."""
    try:
        parts = urllib.parse.urlsplit(url)
    except ValueError:
        return False
    if parts.scheme == "https" and parts.hostname:
        return True
    return parts.scheme == "http" and parts.hostname in ("127.0.0.1", "localhost", "::1")


INSECURE_BODY = {
    "error": "insecure_backend",
    "message": "the backend URL must use https (http is allowed only for localhost).",
}


def read_token(data_dir: Path) -> str | None:
    try:
        return json.loads((Path(data_dir) / "auth.json").read_text()).get("access_token")
    except (OSError, ValueError):
        return None


def backend_call(backend: str, data_dir: Path, method: str, path: str,
                 body: dict[str, Any] | None = None, timeout: float = 60) -> tuple[int, dict[str, Any]]:
    """One JSON call to the backend with the user's token. (0, error body)
    when the call never got an answer, or when the token would go to a
    backend that is not https."""
    token = read_token(data_dir)
    if token and not is_safe_url(backend):
        log(f"refusing to send credentials to non-https backend {backend}")
        return 0, dict(INSECURE_BODY)
    if body is None and method == "POST":
        body = {}
    req = urllib.request.Request(
        f"{backend.rstrip('/')}{path}", method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Content-Type": "application/json", "Accept": "application/json",
                 "User-Agent": "archetype-claude-plugin/study-runner",
                 **({"Authorization": f"Bearer {token}"} if token else {})},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, json.loads(resp.read().decode() or "{}")
    except urllib.error.HTTPError as exc:
        try:
            return exc.code, json.loads(exc.read().decode() or "{}")
        except ValueError:
            return exc.code, {}
    except ValueError as exc:
        return 0, {"error": "bad_response", "message": f"the backend answered with no JSON: {exc}"}
    except (OSError, http.client.HTTPException) as exc:
        return 0, {"error": "network_error", "message": str(exc)}


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


def prioritized(wave: dict[str, Any]) -> list[str]:
    """A next wave's run ids, highest priority first: archetypes whose
    outcome disagreed with the baseline majority, then frustration, then
    steps or abandonment; the backend's interleaved order within a rank."""
    def rank(reason: str) -> int:
        reason = reason or ""
        if "complete" in reason:
            return 0
        if "frustration" in reason:
            return 1
        return 2
    ranks = {str(r.get("archetypeId")): rank(str(r.get("reason"))) for r in wave.get("reasons") or []
             if isinstance(r, dict)}
    runs = [r for r in wave.get("runs") or [] if isinstance(r, dict) and r.get("runId")]
    order = sorted(range(len(runs)), key=lambda i: (ranks.get(str(runs[i].get("archetypeId")), 3), i))
    return [runs[i]["runId"] for i in order]


def log_steps(stream: Path) -> int:
    """How many log_step calls a worker's stream shows so far."""
    try:
        text = stream.read_text(errors="replace")
    except OSError:
        return 0
    return len(re.findall(r'"name":\s*"mcp__plugin_archetype_core__log_step"', text))


START_RUN = "mcp__plugin_archetype_core__start_run"


def live_runner(folder: Path) -> int | None:
    """The pid of another runner process still serving this study folder
    (its runner.json says starting or running and the pid is alive), as
    core-server's dispatch_study checks. Two runners in one folder would
    overwrite each other's runner.json and shadow plugin."""
    try:
        status = json.loads((folder / "runner.json").read_text())
    except (OSError, ValueError):
        return None
    pid = status.get("pid") if isinstance(status, dict) else None
    if status.get("state") not in ("starting", "running") or not isinstance(pid, int) or pid == os.getpid():
        return None
    try:
        os.kill(pid, 0)
    except OSError:
        return None
    return pid


def _text(content: Any) -> str:
    """The text of a tool_result's content (a string or a list of blocks)."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(_text(b.get("text") if isinstance(b, dict) else b) for b in content)
    return ""


def claim_outcome(stream: Path, run_id: str) -> str:
    """How this worker's own claim of ``run_id`` went, from its stream:
    "won" when start_run handed it the run's briefing (which ends with
    ``runId: <id>``), "lost" when start_run answered with an error (another
    actor holds the run, it already ran, or the claim timed out), "pending"
    when the call has no answer yet, "none" when it never asked."""
    try:
        lines = stream.read_text(errors="replace").splitlines()
    except OSError:
        return "none"
    briefing = re.compile(rf"\brunId:\s*{re.escape(run_id)}(?![A-Za-z0-9_-])")
    asked: set[str] = set()
    outcome = "none"
    for line in lines:
        try:
            event = json.loads(line)
        except ValueError:
            continue
        message = event.get("message") if isinstance(event, dict) else None
        content = message.get("content") if isinstance(message, dict) else None
        for block in content if isinstance(content, list) else []:
            if not isinstance(block, dict):
                continue
            args = block.get("input")
            if (block.get("type") == "tool_use" and block.get("name") == START_RUN
                    and isinstance(args, dict) and args.get("run_id") == run_id):
                asked.add(str(block.get("id")))
                outcome = "pending"
            elif block.get("type") == "tool_result" and str(block.get("tool_use_id")) in asked:
                if block.get("is_error") is not True and briefing.search(_text(block.get("content"))):
                    return "won"
                outcome = "lost"
    return outcome


class Runner:
    def __init__(self, opts: argparse.Namespace, stop: threading.Event | None = None) -> None:
        self.opts = opts
        # Set by SIGTERM or SIGINT; the watcher shares it, so a signal during
        # a study pass stops the watcher too.
        self.stop_event = stop or threading.Event()
        self.data_dir = Path(opts.data_dir).resolve()
        self.folder = self.data_dir / "studies" / opts.study
        self.folder.mkdir(parents=True, exist_ok=True)
        self.status_file = self.folder / "runner.json"
        # Reentrant: the signal handler takes it on the main thread, which
        # may already hold it (saving runner.json) when the signal lands.
        self.lock = threading.RLock()
        self.queue: list[str] = []
        self.free_slots = list(range(1, opts.parallel + 1))
        self.children: dict[str, subprocess.Popen] = {}
        self.status: dict[str, Any] = {
            "study_id": opts.study, "state": "starting", "pid": os.getpid(),
            "parallel": len(self.free_slots), "started_at": time.time(), "waves": [], "workers": {},
        }
        self.shadow: Path | None = None
        self.started = 0
        self.stalled: set[str] = set()
        # What went wrong in this pass (the exit code is 1 when any did).
        self.problems: list[str] = []
        # Runs whose worker exited before claiming: still queued, so the
        # current wave cannot finish in this pass.
        self.left_queued: set[str] = set()

    def stop_requested(self) -> bool:
        return self.stop_event.is_set() or (self.folder / "stop").exists()

    def problem(self, msg: str) -> None:
        log(msg)
        with self.lock:
            self.problems.append(msg)

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

    def request(self, method: str, path: str, body: dict[str, Any] | None = None,
                timeout: float = 60) -> tuple[int, dict[str, Any]]:
        return backend_call(self.opts.backend, self.data_dir, method, path, body, timeout)

    def run_row(self, run_id: str) -> dict[str, Any] | None:
        """The run's row in the study's run list (live status, sessionId), or
        None, logged as a problem, when the backend cannot say."""
        status, body = self.request("GET", f"/api/studies/{self.opts.study}/runs")
        if status != 200:
            self.problem(f"run {run_id}: could not read the study's runs "
                         f"({status} {body.get('message') or body.get('error')})")
            return None
        row = next((r for r in body.get("runs") or [] if isinstance(r, dict) and r.get("runId") == run_id), None)
        if row is None:
            self.problem(f"run {run_id}: not in the study's run list")
        return row

    def abort(self, run_id: str, reason: str, row: dict[str, Any], open_states: tuple[str, ...]) -> bool:
        """Report a run the runner gave up on as aborted, with the reason, so
        the wave can finish. Only a run in ``open_states``: a worker's own
        claimed run while it is running, a run skipped by the budget while
        it is queued. Anything else belongs to another actor or is done."""
        if row.get("status") not in open_states:
            return False
        if not row.get("sessionId"):
            self.problem(f"run {run_id} is {row.get('status')} but its row has no sessionId: not aborted ({reason})")
            return False
        status, body = self.request("POST", f"/api/plugin/runs/{run_id}/results", {
            "status": "aborted", "steps": [], "sessionId": row["sessionId"], "abortReason": reason,
            "feedback": {"verdict": "fail", "summary": f"Aborted by the swarm runner: {reason}."},
        })
        if not 200 <= status < 300:
            self.problem(f"run {run_id}: aborting it ({reason}) failed: {status} "
                         f"{body.get('message') or body.get('error')}")
            return False
        log(f"run {run_id} aborted ({reason})")
        self.worker(run_id, aborted=reason)
        return True

    def next_wave(self) -> list[str] | None:
        """Run ids of the next wave, or None when the study has no more (or
        the backend would not say: a problem)."""
        for _ in range(NEXT_WAVE_TRIES):
            if self.stop_requested():
                self.problem("stopped while waiting for the next wave; the study is not finished")
                return None
            status, body = self.request("POST", f"/api/studies/{self.opts.study}/runs/next", timeout=120)
            if status == 409 or status == 0:
                log(f"next wave not ready ({body.get('message') or status}); waiting {NEXT_WAVE_WAIT:g} s")
                self.stop_event.wait(NEXT_WAVE_WAIT)
                continue
            if not (200 <= status < 300):
                self.problem(f"next wave failed: {status} {body.get('message') or body.get('error')}")
                return None
            if body.get("done"):
                log(f"no more waves: {body.get('reason') or 'done'}")
                return None
            runs = prioritized(body)
            self.status["waves"].append({"wave": body.get("wave"), "runs": runs})
            return [r for r in runs if isinstance(r, str) and _ID.match(r)]
        self.problem(f"the next wave was not ready after {NEXT_WAVE_TRIES} tries; the study is not finished")
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
                if self.stop_event.is_set():
                    self.kill(child)  # the signal came while this worker was starting
                code = self.watch(run_id, child, run_dir / "stream.jsonl")
                timed_out = code == "timeout"
                if timed_out:
                    code = child.returncode
        except OSError as exc:
            log(f"could not start claude for {run_id}: {exc}")
            code = None
        finally:
            with self.lock:
                self.children.pop(run_id, None)
        stalled = run_id in self.stalled
        state = "stalled" if stalled else "timed_out" if timed_out else "finished" if code == 0 else "failed"
        claim = claim_outcome(run_dir / "stream.jsonl", run_id)
        self.worker(run_id, state=state, claim=claim, exit_code=code, finished_at=time.time(),
                    stream_events=self._count_lines(run_dir / "stream.jsonl"))
        log(f"run {run_id} {state} (exit {code}, claim {claim})")
        if state != "finished":
            self.problem(f"run {run_id}: worker {state} (exit {code})")
        row = self.run_row(run_id)
        if row is None:
            return
        if claim == "won":
            # A worker that is gone while the run it claimed is still open
            # would hold the next wave forever: report the run as aborted,
            # with why.
            reason = (f"claimed but no step for {self.opts.stall_min:g} minutes" if stalled
                      else f"worker timed out after {self.opts.timeout_min:g} minutes" if timed_out
                      else "the runner was stopped before the worker reported" if self.stop_event.is_set()
                      else "worker exited without reporting")
            if self.abort(run_id, reason, row, ("running",)):
                self.problem(f"run {run_id}: aborted ({reason})")
        elif row.get("status") == "queued":
            # Never claimed by anyone: leave it queued for the next worker
            # (a later dispatch, or the next --watch pass).
            self.left_queued.add(run_id)
            self.problem(f"run {run_id}: its worker exited before claiming it; the run stays queued")
        elif row.get("status") == "running":
            # Another actor's claim: never abort a run this runner does not hold.
            log(f"run {run_id} is running under another actor (claim {claim}); left alone")

    def watch(self, run_id: str, child: subprocess.Popen, stream: Path) -> Any:
        """Wait for a worker; stop it when it times out or stalls after its claim."""
        started = time.monotonic()
        last_steps, last_change = -1, time.monotonic()
        while True:
            try:
                return child.wait(timeout=min(WATCH_EVERY, max(self.opts.timeout_min * 60 - (time.monotonic() - started), 0.1)))
            except subprocess.TimeoutExpired:
                pass
            now = time.monotonic()
            if now - started >= self.opts.timeout_min * 60:
                self.kill(child)
                child.wait()
                return "timeout"
            steps = log_steps(stream)
            if steps != last_steps:
                last_steps, last_change = steps, now
            elif claim_outcome(stream, run_id) == "won" and now - last_change >= self.opts.stall_min * 60:
                log(f"run {run_id}: no step for {self.opts.stall_min:g} min after the claim; stopping its worker")
                self.stalled.add(run_id)
                self.kill(child)
                child.wait()
                return child.returncode

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
            stop = self.stop_requested()
            while self.queue and self.free_slots and not stop:
                run_id = self.queue.pop(0)
                if self.opts.max_runs and self.started >= self.opts.max_runs:
                    self.worker(run_id, state="not_started")
                    row = self.run_row(run_id)
                    if row is not None and not self.abort(
                            run_id, f"not run: the run budget of {self.opts.max_runs} was spent", row, ("queued",)):
                        log(f"run {run_id} is {row.get('status')}, not queued: left to whoever holds it")
                    continue
                self.started += 1
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
                log(f"stopping: {len(self.queue)} queued run(s) not started")
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
        if (self.folder / "stop").exists():
            log(f"{self.folder / 'stop'} exists: no worker will start (delete it to run the study)")
        self.status["state"] = "running"
        self.save()

        def on_signal(signum: int, _frame: Any) -> None:
            # In memory, never a stop file: a file would outlive this process
            # and keep every later runner from serving the study.
            log(f"signal {signum}: stopping workers")
            self.stop_event.set()
            with self.lock:
                children = list(self.children.values())
            for child in children:
                self.kill(child)

        previous = {sig: signal.signal(sig, on_signal) for sig in (signal.SIGTERM, signal.SIGINT)}
        try:
            self.serve(runs)
        finally:
            for sig, handler in previous.items():
                signal.signal(sig, handler)
        workers = self.status["workers"].values()
        self.status["state"] = "finished"
        self.status["finished_at"] = time.time()
        self.status["summary"] = {s: sum(1 for w in workers if w.get("state") == s)
                                  for s in ("finished", "failed", "timed_out", "stalled", "not_started")}
        self.status["summary"]["aborted"] = sum(1 for w in workers if w.get("aborted"))
        self.status["problems"] = list(self.problems)
        self.save()
        log(f"done: {self.status['summary']}")
        for msg in self.problems:
            log(f"problem: {msg}")
        return 1 if self.problems else 0

    def serve(self, runs: list[str]) -> None:
        """Run the current wave, then each next wave, until done or stopped."""
        self.queue = list(runs)
        while True:
            self.drain()
            if self.opts.no_next_wave or self.stop_requested():
                break
            if self.left_queued:
                self.problem(f"{len(self.left_queued)} run(s) of this wave were never claimed and are still "
                             "queued, so the next wave cannot start: dispatch the study again to run them")
                break
            more = self.next_wave()
            if not more:
                break
            for rid in more:
                self.worker(rid, state="queued")
            self.queue = list(more)


def queued_work(opts: argparse.Namespace) -> tuple[list[tuple[str, list[str]]], bool]:
    """Remote studies with queued runs, oldest first: ([(study_id, [run
    ids])], whether every listing answered)."""
    status, body = backend_call(opts.backend, Path(opts.data_dir), "GET",
                                "/api/studies?execution=remote&status=running&limit=50")
    if status != 200:
        log(f"listing remote studies failed: {status} {body.get('message') or body.get('error')}")
        return [], False
    work, ok = [], True
    for study in reversed(body.get("studies") or []):
        study_id = study.get("studyId") if isinstance(study, dict) else None
        if not isinstance(study_id, str) or not _ID.match(study_id):
            continue
        code, runs = backend_call(opts.backend, Path(opts.data_dir), "GET", f"/api/studies/{study_id}/runs")
        if code != 200:
            log(f"study {study_id}: listing its runs failed: {code} {runs.get('message') or runs.get('error')}")
            ok = False
            continue
        queued = [r["runId"] for r in runs.get("runs") or []
                  if isinstance(r, dict) and r.get("status") == "queued" and _ID.match(str(r.get("runId")))]
        if queued:
            work.append((study_id, queued))
    return work, ok


def watch(opts: argparse.Namespace) -> int:
    """Serve remote studies until stopped (or one pass with --once). Exit 1
    when a --once pass had a problem."""
    studies = Path(opts.data_dir) / "studies"
    stop_file = studies / "stop"
    studies.mkdir(parents=True, exist_ok=True)
    poll = float(os.environ.get("ARCHETYPE_WATCH_POLL_S") or opts.poll_sec)
    stop = threading.Event()

    def on_signal(signum: int, _frame: Any) -> None:
        log(f"signal {signum}: stopping the watch")
        stop.set()

    previous = {sig: signal.signal(sig, on_signal) for sig in (signal.SIGTERM, signal.SIGINT)}
    served, failed, skipped = 0, False, set()
    log(f"watching {opts.backend} for remote studies (poll every {poll:g} s)")
    if stop_file.exists():
        log(f"{stop_file} exists: not serving (delete it to start)")
    try:
        while not stop.is_set() and not stop_file.exists():
            work, listed = queued_work(opts)
            pass_failed = not listed
            for study_id, runs in work:
                if stop.is_set() or stop_file.exists():
                    break
                if (studies / study_id / "stop").exists():
                    if study_id not in skipped:
                        log(f"study {study_id}: skipped while {studies / study_id / 'stop'} exists")
                        skipped.add(study_id)
                    continue
                other = live_runner(studies / study_id)
                if other:
                    log(f"study {study_id}: runner pid {other} on this machine is serving it; left to it")
                    continue
                log(f"study {study_id}: {len(runs)} queued run(s)")
                study_opts = argparse.Namespace(**{**vars(opts), "study": study_id, "runs": ",".join(runs)})
                pass_failed |= Runner(study_opts, stop).run() != 0
                served += 1
            failed |= pass_failed
            if opts.once:
                break
            if not work or pass_failed:
                stop.wait(poll)  # also after a failed pass: never a tight loop of failing workers
    finally:
        for sig, handler in previous.items():
            signal.signal(sig, handler)
    log(f"watch stopped after {served} study pass(es)")
    return 1 if opts.once and failed else 0


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--study")
    parser.add_argument("--watch", action="store_true", help="serve every remote study's queued runs")
    parser.add_argument("--once", action="store_true", help="with --watch: one pass, then exit")
    parser.add_argument("--poll-sec", type=float, default=20, help="with --watch: seconds between polls")
    parser.add_argument("--data-dir", default=os.environ.get("CLAUDE_PLUGIN_DATA"))
    parser.add_argument("--backend", default=os.environ.get("ARCHETYPE_BACKEND_URL", "https://api.syntheticarchetype.com"))
    parser.add_argument("--runs", default="", help="comma separated run ids of the current wave")
    parser.add_argument("--parallel", type=int, default=2)
    parser.add_argument("--model")
    parser.add_argument("--timeout-min", type=float, default=30)
    parser.add_argument("--stall-min", type=float, default=20,
                        help="stop a worker that logged no step for this long after claiming its run")
    parser.add_argument("--max-runs", type=int, default=0, help="start at most this many workers (0: no cap)")
    parser.add_argument("--claude", default=os.environ.get("ARCHETYPE_CLAUDE_BIN", "claude"))
    parser.add_argument("--no-next-wave", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    opts = parser.parse_args(argv)
    if not opts.data_dir:
        parser.error("--data-dir (or CLAUDE_PLUGIN_DATA) is required: it holds auth.json")
    if not is_safe_url(opts.backend):
        parser.error(f"--backend {opts.backend} must use https (http is allowed only for localhost): "
                     "the runner and its workers send the login token to it")
    if not 1 <= opts.parallel <= MAX_PARALLEL:
        parser.error(f"--parallel must be 1 to {MAX_PARALLEL}: each worker drives its own plugin browser")
    if opts.max_runs < 0:
        parser.error("--max-runs must be 0 (no cap) or more")
    for flag, value in (("--timeout-min", opts.timeout_min), ("--stall-min", opts.stall_min)):
        if not value > 0:
            parser.error(f"{flag} must be more than 0 minutes")
    if opts.watch:
        if opts.study or opts.runs:
            parser.error("--watch finds its own studies: leave out --study and --runs")
        return watch(opts)
    if not opts.study or not _ID.match(opts.study):
        parser.error("--study must be a study id (or use --watch)")
    other = live_runner(Path(opts.data_dir).resolve() / "studies" / opts.study)
    if other:
        log(f"runner pid {other} is already serving study {opts.study}; follow it with study_status "
            "(or create the stop file in its study folder) instead of starting another")
        return 2
    return Runner(opts).run()


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
