#!/usr/bin/env python3
"""Tests for e2e/relay_matrix.py against the real Relay answer key.

Run: python3 e2e/test_relay_matrix.py   (stdlib only, prints ALL PASS)
"""
from __future__ import annotations

import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import relay_matrix as rm  # noqa: E402

GROUND_TRUTH = HERE.parent / "demo-apps" / "relay" / "GROUND_TRUTH.md"


def run(findings=(), narration=(), urls=(), words=None):
    steps = [{"seq": i + 1, "narration": n, "url": u}
             for i, (n, u) in enumerate(zip(list(narration) + [""] * len(urls), list(urls) + [""] * len(narration)))]
    return {"findings": [{"description": f} for f in findings], "steps": steps,
            "outcome": {"inTheirWords": words} if words else {}}


def case_parses_every_defect_row():
    defects = rm.load_ground_truth(GROUND_TRUTH)
    assert [d["id"] for d in defects] == [f"D{i}" for i in range(1, 10)], [d["id"] for d in defects]
    by = {d["id"]: d for d in defects}
    assert by["D1"]["pages"] == ["index.html", "signup.html"], by["D1"]["pages"]
    assert "docs.html" in by["D2"]["pages"] and "onboarding.html" in by["D3"]["pages"]
    assert by["D4"]["pages"] == ["dashboard.html"]
    assert "relay-sdk" in by["D3"]["terms"] and "@relay/sdk" in by["D3"]["terms"]
    assert by["D1"]["title"].startswith("Landing promises"), by["D1"]["title"]
    assert all(rm.signature(d) for d in defects), "every defect has a signature"


def case_demo_script_quotes_are_found():
    defects = rm.load_ground_truth(GROUND_TRUTH)
    faulkner = run(findings=[
        "Signup asks for a card despite the 'no credit card required' promise; reads as bait-and-switch",
        "No token is displayed anywhere: not during onboarding, not in Settings, yet the docs init with RELAY_TOKEN",
        "Onboarding installs relay-sdk but requires @relay/sdk, which would produce a require error",
        "The dashboard is a dead end: no calls to action, no links back to setup",
        "Docs search returns No results found even though an Uptime checks guide exists",
        "Onboarding banner says Pro is $39/seat/mo but pricing says $29/seat/mo",
    ], urls=["http://x/index.html", "http://x/signup.html", "http://x/pricing.html"])
    grades = rm.grade_run(defects, faulkner)
    for did in ("D1", "D2", "D3", "D4", "D5", "D6"):
        assert grades[did]["level"] == "found", (did, grades[did])
    assert grades["D7"]["level"] == "reached", grades["D7"]
    assert grades["D8"]["level"] == "not reached", grades["D8"]
    assert grades["D9"]["level"] == "reached", "D9's promise lives on the landing and pricing pages too"


def case_noticed_reached_and_words():
    defects = rm.load_ground_truth(GROUND_TRUTH)
    zwick = run(narration=["They promised no credit card and now want my card number. Not doing this."],
                urls=["http://127.0.0.1:8331/", "http://127.0.0.1:8331/signup.html"])
    g = rm.grade_run(defects, zwick)
    assert g["D1"]["level"] == "noticed", g["D1"]
    assert g["D5"]["level"] == "not reached" and g["D4"]["level"] == "not reached"
    quit_words = run(urls=["http://x/signup.html"], words="The homepage said no credit card, then signup demanded one.")
    assert rm.grade_run(defects, quit_words)["D1"]["level"] == "found"
    landing = rm.grade_run(defects, run(urls=["http://x/"]))
    assert landing["D1"]["level"] == "reached", "the bare root is index.html"


def case_matrix_and_markdown():
    defects = rm.load_ground_truth(GROUND_TRUTH)
    runs = [
        {"runId": "a", "archetypeName": "Baseline", "role": "baseline", "status": "completed",
         "report": run(findings=["Card required although the page said free forever"], urls=["http://x/signup.html"])},
        {"runId": "b", "archetypeName": "Baseline", "role": "baseline", "status": "abandoned",
         "report": run(urls=["http://x/signup.html"])},
        {"runId": "c", "archetypeName": "Low trust", "role": "variant", "status": "failed", "report": run(urls=["http://x/"])},
    ]
    runs.append({"runId": "d", "archetypeName": "Low trust", "status": "aborted", "report": run()})
    runs.append({"runId": "e", "archetypeName": "Low trust", "status": "queued", "report": run()})
    runs.append({"runId": "f", "archetypeName": "Stress", "status": "running", "report": run()})
    m = rm.build_matrix(defects, runs)
    assert m["archetypes"] == ["Baseline", "Low trust"], m["archetypes"]
    assert m["cells"]["D1|Low trust"]["n"] == 1, "aborted runs and runs that never ran are not graded"
    assert m["cells"]["D1|Baseline"]["found"] == 1 and m["cells"]["D1|Baseline"]["n"] == 2
    assert m["cells"]["D1|Low trust"]["best"] == "reached"
    md = rm.render_markdown(m)
    assert "| D1 Landing promises" in md and "**found** 1 of 2" in md and "reached, missed (1 of 1)" in md, md
    assert "Defects found by at least one archetype: 1 of 9 (D1)." in md, md


def case_unknown_defect_uses_its_own_terms():
    text = "| D10 | Footer shows `Copyright 2019` on every page. | `index.html` footer |\n"
    (d,) = rm.parse_ground_truth(text)
    assert rm.signature(d) == [[["copyright 2019"]]]
    assert rm.grade_run([d], run(findings=["The footer still says Copyright 2019"]))["D10"]["level"] == "found"


def case_comparison_names_new_finds():
    defects = rm.load_ground_truth(GROUND_TRUTH)
    first = rm.build_matrix(defects, [{"runId": "a", "archetypeName": "B", "status": "completed", "report": run(findings=["Card required despite no card promise"], urls=["http://x/signup.html"])}])
    first["studyId"] = "aaaaaaaa1"
    second = rm.build_matrix(defects, [{"runId": "b", "archetypeName": "B", "status": "completed", "report": run(findings=[
        "The dashboard says No events yet and nothing else"], urls=["http://x/dashboard.html"])}])
    second["studyId"] = "bbbbbbbb2"
    text = rm.render_comparison(first, second)
    assert "| D1 Landing promises" in text and "1 of 1 runs | 0 of 1 runs | no longer found |" in text, text
    assert "| D4 Dashboard empty state is a dead end | 0 of 1 runs | 1 of 1 runs | newly found |" in text, text
    assert "Newly found: D4." in text


def case_a_step_without_a_url_reaches_no_page():
    defects = rm.load_ground_truth(GROUND_TRUTH)
    report = {"findings": [], "outcome": {},
              "steps": [{"seq": 1, "narration": "Looking around", "url": None}, {"seq": 2, "narration": "", "url": ""}]}
    grades = rm.grade_run(defects, report)
    assert all(g["level"] == "not reached" for g in grades.values()), \
        {k: v for k, v in grades.items() if v["level"] != "not reached"}
    root = rm.grade_run(defects, {"steps": [{"seq": 1, "url": "http://127.0.0.1:8322"}]})
    assert root["D1"]["level"] == "reached", "a bare origin is the landing page"


def case_grade_fails_loudly_when_the_backend_does():
    import argparse
    import contextlib
    import io
    import tempfile
    sys.path.insert(0, str(HERE.parent / "scripts"))
    import relay_study as rs
    answers = {
        "/api/studies/s1/report": (200, {"status": "complete"}),
        "/api/studies/s1/runs": (200, {"runs": [
            {"runId": "a", "archetypeName": "Baseline", "status": "completed"},
            {"runId": "b", "archetypeName": "Low trust", "status": "completed"}]}),
        "/api/plugin/runs/a/report": (200, run(findings=["Card required despite the no card promise"],
                                               urls=["http://x/signup.html"])),
        "/api/plugin/runs/b/report": (500, {"error": "internal_error", "message": "boom"}),
    }
    rs.api = lambda backend, path, data_dir, timeout=300: answers[path]
    opts = argparse.Namespace(backend="http://127.0.0.1:1", compare=None)
    with tempfile.TemporaryDirectory() as tmp, contextlib.redirect_stdout(io.StringIO()):
        matrix, problems = rs.grade(opts, Path(tmp), Path(tmp), "s1")
        assert [r["runId"] for r in matrix["runs"]] == ["a"], "a run whose report failed is not graded as not reached"
        assert any("run b" in p and "500" in p for p in problems), problems
        answers["/api/studies/s1/runs"] = (401, {"error": "unauthorized", "message": "no"})
        matrix, problems = rs.grade(opts, Path(tmp), Path(tmp), "s1")
        assert any("401" in p for p in problems) and any("no run" in p for p in problems), problems


def case_session_survives_a_backend_blip():
    import argparse
    import contextlib
    import io
    import tempfile
    import time
    import urllib.error
    sys.path.insert(0, str(HERE.parent / "scripts"))
    import relay_study as rs
    calls = []

    def flaky(backend, path, data_dir, timeout=300):
        calls.append(path)
        if len(calls) == 1:
            raise urllib.error.URLError("connection refused")
        return 200, {"runs": []}

    rs.api = flaky
    real_sleep = time.sleep
    with tempfile.TemporaryDirectory() as tmp, contextlib.redirect_stdout(io.StringIO()):
        out = Path(tmp)
        claude = out / "claude"
        claude.write_text("#!/usr/bin/env python3\nimport time\nprint('studyId for tool calls: abcdefgh1', flush=True)\n"
                          "time.sleep(1.5)\n")
        claude.chmod(0o755)
        data = out / "plugin-data"
        data.mkdir()
        opts = argparse.Namespace(study=None, preconditions="", factors="a", parallel=1, model="m", max_runs=4,
                                  outer_model="m", claude=str(claude), backend="http://127.0.0.1:1", timeout_min=5)
        rs.time.sleep = lambda s: real_sleep(min(s, 0.2))
        try:
            sid = rs.run_session(opts, out, data, "http://127.0.0.1:8322")
        finally:
            rs.time.sleep = real_sleep
    assert sid == "abcdefgh1", sid
    assert len(calls) >= 2, f"the session was followed after the blip: {calls}"


CASES = [case_session_survives_a_backend_blip, case_a_step_without_a_url_reaches_no_page, case_grade_fails_loudly_when_the_backend_does,case_comparison_names_new_finds, case_parses_every_defect_row, case_demo_script_quotes_are_found, case_noticed_reached_and_words,
         case_matrix_and_markdown, case_unknown_defect_uses_its_own_terms]


def main() -> int:
    failed = 0
    for case in CASES:
        try:
            case()
            print(f"PASS  {case.__name__}")
        except AssertionError as exc:
            failed += 1
            print(f"FAIL  {case.__name__}: {exc}")
    print("-" * 60)
    print(f"{failed} FAILED" if failed else f"ALL PASS ({len(CASES)}/{len(CASES)})")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
