#!/usr/bin/env python3
"""H2: a behavioral study of the Relay demo app with the real plugin and a
real backend, graded automatically against demo-apps/relay/GROUND_TRUTH.md.

What it does:

1. Serves a fresh copy of demo-apps/relay (no data.json from earlier runs).
2. Makes a plugin data folder with a fake JWT shaped auth.json (for a
   backend in DEV_MODE, where every bearer token is the dev user) and a
   shadow copy of this plugin whose servers and hooks use that folder, so
   the user's real login is never read or written.
3. Runs the study in one unattended Claude Code session:
       claude -p "/archetype:study <goal> url=... icp=... success=...
                  factors=... archetypes=5 parallel=4 model=sonnet unattended"
   The study skill creates the study, factors and archetypes, dispatches
   the swarm runner (one `claude -p` actor per run, each on its own
   isolated headless browser, next waves included) and prints the report.
   With --study ID the session resumes that study instead (study=<id>).
4. Reads the study report and every run's report from the backend and
   prints the defect x archetype matrix (e2e/relay_matrix.py), which
   replaces the hand compiled matrix in demo-apps/relay/DEMO_SCRIPT.md.

Usage:
  python3 e2e/relay_study.py --out /tmp/relay-study [--backend http://127.0.0.1:5011]
        [--relay-port 8322] [--parallel 4] [--model sonnet] [--outer-model sonnet]
        [--factors patience,trust_willingness_to_share,reading_behavior]
        [--study ID] [--grade-only] [--max-runs 16] [--timeout-min 150]

--grade-only --study ID skips the session and grades an existing study.
Costs: one orchestrating session plus one actor session per run on the
Claude plan of the logged in `claude` CLI (wave 1 of `confirm` with 5
archetypes is 7 runs; wave 2 adds up to 8). --max-runs stops the session
(and the runner, through its stop file) once that many runs exist.
Stdlib only.
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(ROOT / "scripts"))
import relay_matrix  # noqa: E402

GOAL = "Sign up for Relay and get to the point where you could send your first event"
ICP = ("Backend engineers evaluating API monitoring: staff and senior backend engineers at 20 to 200 "
       "person startups who try new developer tools themselves, often late at night after an outage")
SUCCESS = "The Relay dashboard is reached after signing up"
FACTORS = "patience,trust_willingness_to_share,reading_behavior"


def log(msg: str) -> None:
    print(f"[relay-study] {time.strftime('%H:%M:%S')} {msg}", flush=True)


def fake_auth(data_dir: Path) -> None:
    path = data_dir / "auth.json"
    if path.exists():
        return
    b64 = lambda o: base64.urlsafe_b64encode(json.dumps(o).encode()).decode().rstrip("=")
    now = int(time.time())
    token = ".".join([b64({"alg": "none", "typ": "JWT"}),
                      b64({"sub": "auth0|relay-study", "iat": now, "exp": now + 30 * 86400}), os.urandom(16).hex()])
    path.write_text(json.dumps({"access_token": token, "token_type": "Bearer", "expires_in": 30 * 86400,
                                "id_token": token, "saved_at": now}))


def api(backend: str, path: str, data_dir: Path, timeout: float = 300) -> tuple[int, Any]:
    token = json.loads((data_dir / "auth.json").read_text())["access_token"]
    req = urllib.request.Request(backend.rstrip("/") + path, headers={"Authorization": f"Bearer {token}",
                                                                       "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, json.loads(resp.read().decode() or "{}")
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read().decode() or "{}")


def serve_relay(out: Path, port: int) -> subprocess.Popen | None:
    url = f"http://127.0.0.1:{port}/"
    try:
        urllib.request.urlopen(url, timeout=2)
        log(f"Relay already answers on {url}; using it as is")
        return None
    except Exception:
        pass
    app = out / "relay"
    if app.exists():
        shutil.rmtree(app)
    shutil.copytree(ROOT / "demo-apps" / "relay", app, ignore=shutil.ignore_patterns("data.json"))
    proc = subprocess.Popen([sys.executable, "server.py"], cwd=app, env=dict(os.environ, RELAY_PORT=str(port)),
                            stdout=(out / "relay.log").open("w"), stderr=subprocess.STDOUT)
    for _ in range(50):
        try:
            urllib.request.urlopen(url, timeout=1)
            log(f"Relay serves a fresh copy on {url}")
            return proc
        except Exception:
            time.sleep(0.2)
    raise SystemExit("Relay did not start")


def study_ids(data_dir: Path) -> set[str]:
    folder = data_dir / "studies"
    return {p.name for p in folder.iterdir()} if folder.is_dir() else set()


def study_id_from_stream(stream: Path) -> str | None:
    if not stream.exists():
        return None
    found = re.findall(r"studyId for tool calls: ([A-Za-z0-9_-]{8,64})", stream.read_text(errors="replace"))
    return found[-1] if found else None


def run_session(opts: argparse.Namespace, out: Path, data_dir: Path, relay_url: str) -> str | None:
    import study_runner  # the plugin's own shadow and env helpers

    shadow = study_runner.shadow_plugin(ROOT, out / "plugin", data_dir)
    if opts.study:
        prompt = (f"/archetype:study study={opts.study} unattended parallel={opts.parallel} model={opts.model} "
                  f"max_runs={opts.max_runs}")
    else:
        pre = f' preconditions="{opts.preconditions}"' if opts.preconditions else ""
        prompt = (f'/archetype:study "{GOAL}" url={relay_url} icp="{ICP}" success="{SUCCESS}"{pre} '
                  f"factors={opts.factors} archetypes=5 repeats=confirm mode=ofat_stress "
                  f"parallel={opts.parallel} model={opts.model} max_runs={opts.max_runs} unattended")
    args = [opts.claude, "-p", prompt, "--plugin-dir", str(shadow), "--dangerously-skip-permissions",
            "--output-format", "stream-json", "--verbose", "--no-chrome", "--no-session-persistence",
            "--model", opts.outer_model]
    env = study_runner.clean_child_env(dict(os.environ), {"ARCHETYPE_BACKEND_URL": opts.backend})
    stream = out / "session.jsonl"
    (out / "session.prompt.txt").write_text(prompt + "\n")
    before = study_ids(data_dir)
    log(f"session: {prompt}")
    started = time.monotonic()
    cwd = out / "cwd"
    cwd.mkdir(exist_ok=True)
    with stream.open("a") as fh, (out / "session.stderr.log").open("a") as err:
        child = subprocess.Popen(args, cwd=cwd, env=env, stdout=fh, stderr=err, stdin=subprocess.DEVNULL,
                                 start_new_session=True)
        sid = opts.study
        try:
            while child.poll() is None:
                time.sleep(15)
                sid = sid or study_id_from_stream(stream) or next(iter(study_ids(data_dir) - before), None)
                if sid and opts.max_runs:
                    try:
                        code, listing = api(opts.backend, f"/api/studies/{sid}/runs", data_dir, timeout=30)
                    except (urllib.error.URLError, OSError, ValueError) as exc:
                        # One missed check of the run count; the session goes on.
                        log(f"could not count the study's runs ({exc}); checking again in 15 s")
                        code, listing = 0, {}
                    if code not in (0, 200):
                        log(f"could not count the study's runs (HTTP {code}); checking again in 15 s")
                    ran = sum(1 for r in listing.get("runs") or []
                              if r.get("status") not in ("queued", "aborted") or r.get("claimedAt"))
                    if ran > opts.max_runs:
                        log(f"{ran} runs started, over --max-runs {opts.max_runs}: stopping")
                        (data_dir / "studies" / sid / "stop").write_text("max runs\n")
                        os.killpg(child.pid, signal.SIGTERM)
                if time.monotonic() - started > opts.timeout_min * 60:
                    log("session timed out: stopping it")
                    try:
                        os.killpg(child.pid, signal.SIGTERM)
                    except OSError:
                        pass
        except BaseException:
            # Never leave the session (and its runner and workers) running
            # unwatched behind a crashed harness.
            try:
                os.killpg(child.pid, signal.SIGTERM)
            except OSError:
                pass
            raise
    log(f"session ended (exit {child.returncode}) after {(time.monotonic() - started) / 60:.1f} min")
    return sid or study_id_from_stream(stream) or next(iter(study_ids(data_dir) - before), None)


def grade(opts: argparse.Namespace, out: Path, data_dir: Path, sid: str) -> tuple[dict[str, Any], list[str]]:
    """The matrix, and what kept it from being complete: a report the
    backend did not hand over is a problem, never a run graded "not
    reached"."""
    problems = []
    code, report = api(opts.backend, f"/api/studies/{sid}/report", data_dir)
    (out / "study_report.json").write_text(json.dumps(report, indent=2))
    if code != 200:
        problems.append(f"study report: HTTP {code} {report.get('message') or report.get('error')}")
    code_l, listing = api(opts.backend, f"/api/studies/{sid}/runs", data_dir)
    if code_l != 200:
        problems.append(f"study runs: HTTP {code_l} {listing.get('message') or listing.get('error')}")
        listing = {}
    runs = []
    for r in listing.get("runs") or []:
        rc, run_report = api(opts.backend, f"/api/plugin/runs/{r['runId']}/report", data_dir)
        (out / "runs").mkdir(exist_ok=True)
        (out / "runs" / f"{r['runId']}.json").write_text(json.dumps(run_report, indent=2))
        if rc != 200:
            problems.append(f"run {r['runId']} report: HTTP {rc} {run_report.get('message') or run_report.get('error')}")
            continue
        runs.append(dict(r, report=run_report))
    defects = relay_matrix.load_ground_truth(ROOT / "demo-apps" / "relay" / "GROUND_TRUTH.md")
    matrix = relay_matrix.build_matrix(defects, runs)
    if not matrix["runs"]:
        problems.append("no run of the study has a persona outcome to grade")
    matrix["studyId"] = sid
    (out / "matrix.json").write_text(json.dumps(matrix, indent=2))
    md = relay_matrix.render_markdown(matrix)
    if opts.compare:
        earlier = json.loads(Path(opts.compare).read_text())
        md += "\n\n" + relay_matrix.render_comparison(earlier, matrix)
    (out / "matrix.md").write_text(md + "\n")
    print(f"\nStudy {sid}: report {code}, {len(matrix['runs'])} graded run(s) of {len(listing.get('runs') or [])}\n")
    print(md)
    for msg in problems:
        log(f"grading problem: {msg}")
    return matrix, problems


def main(argv: list[str]) -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("--out", required=True)
    p.add_argument("--backend", default=os.environ.get("ARCHETYPE_BACKEND_URL", "http://127.0.0.1:5011"))
    p.add_argument("--relay-port", type=int, default=8322,
                   help="Relay's own port: its docs show localhost:8322, and another port reads as a docs defect")
    p.add_argument("--parallel", type=int, default=4)
    p.add_argument("--model", default="sonnet", help="actor workers")
    p.add_argument("--outer-model", default="sonnet", help="the orchestrating session")
    p.add_argument("--factors", default=FACTORS)
    p.add_argument("--study")
    p.add_argument("--preconditions", default="", help="context every tester arrives with (quoted)")
    p.add_argument("--compare", help="matrix.json of an earlier study to compare against")
    p.add_argument("--grade-only", action="store_true")
    p.add_argument("--max-runs", type=int, default=16)
    p.add_argument("--timeout-min", type=float, default=150)
    p.add_argument("--claude", default=os.environ.get("ARCHETYPE_CLAUDE_BIN", "claude"))
    opts = p.parse_args(argv)
    out = Path(opts.out).resolve()
    out.mkdir(parents=True, exist_ok=True)
    data_dir = out / "plugin-data"
    data_dir.mkdir(exist_ok=True)
    fake_auth(data_dir)
    if opts.grade_only:
        if not opts.study:
            p.error("--grade-only needs --study")
        _, problems = grade(opts, out, data_dir, opts.study)
        return 1 if problems else 0
    relay = serve_relay(out, opts.relay_port)
    started = time.time()
    try:
        sid = run_session(opts, out, data_dir, f"http://127.0.0.1:{opts.relay_port}")
    finally:
        if relay:
            relay.terminate()
    if not sid:
        log("no study id found in the session output")
        return 1
    (out / "study_id").write_text(sid + "\n")
    (out / "wall_clock.json").write_text(json.dumps({"started": started, "ended": time.time(),
                                                     "minutes": round((time.time() - started) / 60, 1)}))
    _, problems = grade(opts, out, data_dir, sid)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
