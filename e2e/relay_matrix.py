"""Defect x archetype matrix for a Relay study, graded against GROUND_TRUTH.md.

The answer key (demo-apps/relay/GROUND_TRUTH.md) lists every planted defect
as a table row `| D<n> | defect | where |`. This module reads those rows (id,
short title, the pages the defect lives on, the terms it quotes) and grades
each run of a study:

- found:   a finding the actor reported, or its own words on quitting,
           matches the defect's signature;
- noticed: only the step narration matches it (seen, not reported);
- reached: the run visited a page the defect lives on, without either;
- not reached.

A signature is a list of alternatives; an alternative is a list of term
groups that must all match (any term of a group, case insensitive). The
built in SIGNATURES cover D1 to D9 in plain words, because actors describe
defects in their own words ("asks for a card despite the no card promise"),
not in the answer key's. A defect the answer key adds later and SIGNATURES
does not know is graded by the code spans and quoted strings of its own row.

Stdlib only. Used by relay_study.py; tested by test_relay_matrix.py.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any, Iterable

LEVELS = ("found", "noticed", "reached", "not reached")
# Run statuses that are a persona outcome. aborted (the worker died, or the
# run budget skipped it), queued and running (never ran, still running) are
# not, and grading them would add "not reached" cells nobody earned.
GRADED = ("completed", "abandoned", "failed")

SIGNATURES: dict[str, list[list[list[str]]]] = {
    # Card required although the landing page promises no card.
    "D1": [[["card", "cvc", "payment detail", "billing detail"],
            ["no credit card", "no card", "free forever", "free plan", "despite", "even though", "although",
             "promise", "contradict", "bait", "required", "requires", "mandatory", "asks for", "ask for",
             "demands", "refuse"]]],
    # RELAY_TOKEN is never provisioned anywhere.
    "D2": [[["relay_token", "api token", "api key", "token"],
            ["where", "never", "nowhere", "no step", "not explain", "doesn't explain", "does not explain",
             "missing", "not shown", "no way", "can't find", "cannot find", "could not find", "couldn't find",
             "provision", "undiscoverable", "not displayed", "isn't shown", "is not shown", "no token"]]],
    # Docs install @relay/sdk, onboarding installs relay-sdk.
    "D3": [[["relay-sdk"]],
           [["package"], ["mismatch", "inconsisten", "differ", "two different", "conflict", "wrong name"]]],
    # Dead end empty dashboard.
    "D4": [[["no events yet"]],
           [["dashboard"], ["empty", "dead end", "dead-end", "no guidance", "no next step", "nothing to do",
                            "no way forward", "no call to action", "no calls to action", "no setup", "blank"]]],
    # Docs search always returns nothing.
    "D5": [[["search"], ["no results", "no result", "returns nothing", "found nothing", "nothing found",
                         "doesn't work", "does not work", "broken", "fake", "always empty", "zero results"]]],
    # $29 on pricing, $39 on the onboarding banner.
    "D6": [[["$29", "29/seat", "29 per seat", "29 a seat"], ["$39", "39/seat", "39 per seat", "39 a seat"]],
           [["price", "pricing"], ["inconsisten", "mismatch", "two different", "contradict", "disagree"]]],
    # Annual pricing only through a dead Book a demo form.
    "D7": [[["book a demo", "talk to sales", "demo form", "demo request"],
            ["annual", "nothing happen", "dead", "goes nowhere", "no calendar", "no price", "no follow",
             "just a thank", "only a thank", "we'll be in touch", "we will be in touch"]]],
    # Alert threshold only accepts >N/Nm, silently.
    "D8": [[["threshold", "alert rule"], ["format", "silent", "nothing happen", "no error", "no feedback",
                                         "no hint", "placeholder", "did not save", "didn't save", "not saved"]]],
    # Email is the only alert channel despite Slack and PagerDuty promises.
    "D9": [[["slack", "pagerduty", "webhook"], ["only email", "email only", "only option", "only offers",
                                               "only channel", "missing", "not available", "no slack"]]],
}

_ROW = re.compile(r"^\|\s*(D\d+)\s*\|(.+?)\|(.+?)\|\s*$")
_CODE = re.compile(r"`([^`]{3,})`")
_QUOTE = re.compile(r"\"([^\"]{4,})\"")
_PAGE = re.compile(r"\b([a-z][a-z0-9_-]*\.html)\b")


def _first_clause(text: str) -> str:
    """Text up to the first sentence or clause break outside quotes and brackets."""
    depth, quoted = 0, False
    for i, ch in enumerate(text):
        if ch == '"':
            quoted = not quoted
        elif ch in "([{":
            depth += 1
        elif ch in ")]}":
            depth = max(depth - 1, 0)
        elif ch in ".:;," and not quoted and depth == 0 and (i + 1 == len(text) or text[i + 1] == " "):
            return text[:i].strip()
    return text.strip()


def parse_ground_truth(text: str) -> list[dict[str, Any]]:
    """Every defect row: {id, title, defect, where, pages, terms}."""
    defects: dict[str, dict[str, Any]] = {}
    for line in text.splitlines():
        m = _ROW.match(line.strip())
        if not m:
            continue
        did, defect, where = m.group(1), m.group(2).strip(), m.group(3).strip()
        plain = re.sub(r"\*\*|`", "", defect)
        title = _first_clause(plain)
        pages = sorted(set(_PAGE.findall(where)))
        terms = [t.strip().lower() for t in _CODE.findall(defect) + _QUOTE.findall(defect) if t.strip()]
        defects[did] = {"id": did, "title": title[:120], "defect": defect, "where": where,
                        "pages": pages, "terms": terms}
    return sorted(defects.values(), key=lambda d: int(d["id"][1:]))


def signature(defect: dict[str, Any]) -> list[list[list[str]]]:
    known = SIGNATURES.get(defect["id"])
    if known:
        return known
    return [[[t]] for t in defect.get("terms") or []]


def matches(text: str, sig: list[list[list[str]]]) -> bool:
    low = (text or "").lower()
    return any(all(any(term in low for term in group) for group in alt) for alt in sig)


def _page_paths(url: Any) -> set[str]:
    """The page a step's URL names (a bare origin is index.html); none for a
    step that has no URL."""
    if not isinstance(url, str) or not url.strip():
        return set()
    path = re.sub(r"^[a-z]+://[^/]+", "", url.strip()).split("?")[0].split("#")[0]
    names = {path.rsplit("/", 1)[-1] or "index.html"}
    return {n if n.endswith(".html") else f"{n}.html" for n in names}


def grade_run(defects: list[dict[str, Any]], run: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """{defect id: {level, evidence}} for one run report (GET /api/plugin/runs/<id>/report)."""
    outcome = run.get("outcome") or {}
    reported = [("finding", f"{f.get('description') or ''} {((f.get('evidence') or {}).get('quote')) or ''}")
                for f in run.get("findings") or [] if isinstance(f, dict)]
    if outcome.get("inTheirWords"):
        reported.append(("in their words", str(outcome["inTheirWords"])))
    steps = [s for s in run.get("steps") or [] if isinstance(s, dict)]
    visited: set[str] = set()
    for s in steps:
        visited |= _page_paths(s.get("url"))
    out: dict[str, dict[str, Any]] = {}
    for d in defects:
        sig = signature(d)
        hit = next(((kind, text) for kind, text in reported if matches(text, sig)), None)
        if hit:
            out[d["id"]] = {"level": "found", "evidence": f"{hit[0]}: {hit[1].strip()[:200]}"}
            continue
        seen = next((s for s in steps if matches(str(s.get("narration") or ""), sig)), None)
        if seen:
            out[d["id"]] = {"level": "noticed", "evidence": f"step {seen.get('seq')}: {str(seen.get('narration'))[:200]}"}
            continue
        pages = set(d["pages"])
        if pages & visited:
            out[d["id"]] = {"level": "reached", "evidence": ", ".join(sorted(pages & visited))}
        else:
            out[d["id"]] = {"level": "not reached", "evidence": None}
    return out


def build_matrix(defects: list[dict[str, Any]], runs: Iterable[dict[str, Any]]) -> dict[str, Any]:
    """runs: [{runId, archetypeName, role, status, report}] in study order
    (rows of GET /api/studies/<id>/runs with each run's report)."""
    archetypes: list[str] = []
    per_run = []
    for r in runs:
        if r.get("status") not in GRADED or (r.get("report") or {}).get("status") == "aborted":
            continue
        name = r.get("archetypeName") or "?"
        if name not in archetypes:
            archetypes.append(name)
        per_run.append({"runId": r.get("runId"), "archetypeName": name, "role": r.get("role"),
                        "status": (r.get("report") or {}).get("status"),
                        "grades": grade_run(defects, r.get("report") or {})})
    cells: dict[str, dict[str, Any]] = {}
    for d in defects:
        for name in archetypes:
            mine = [p["grades"][d["id"]]["level"] for p in per_run if p["archetypeName"] == name]
            counts = {lvl: mine.count(lvl) for lvl in LEVELS}
            best = next((lvl for lvl in LEVELS if counts[lvl]), "not reached")
            cells[f"{d['id']}|{name}"] = {"best": best, "n": len(mine), **counts}
    found_by = {d["id"]: [n for n in archetypes if cells[f"{d['id']}|{n}"]["found"]] for d in defects}
    return {"defects": [{k: d[k] for k in ("id", "title", "pages")} for d in defects],
            "archetypes": archetypes, "cells": cells, "runs": per_run, "foundBy": found_by}


def cell_text(cell: dict[str, Any]) -> str:
    n = cell["n"]
    if cell["found"]:
        return f"**found** {cell['found']} of {n}"
    if cell["noticed"]:
        return f"noticed {cell['noticed']} of {n}"
    if cell["reached"]:
        return f"reached, missed ({cell['reached']} of {n})"
    return "not reached"


def render_markdown(matrix: dict[str, Any]) -> str:
    names = matrix["archetypes"]
    lines = ["| Planted defect | " + " | ".join(names) + " |", "|---|" + "---|" * len(names)]
    for d in matrix["defects"]:
        row = [cell_text(matrix["cells"][f"{d['id']}|{n}"]) for n in names]
        lines.append(f"| {d['id']} {d['title'][:70]} | " + " | ".join(row) + " |")
    found = [did for did, who in matrix["foundBy"].items() if who]
    lines.append("")
    lines.append(f"Defects found by at least one archetype: {len(found)} of {len(matrix['defects'])}"
                 + (f" ({', '.join(found)})" if found else "") + ".")
    for n in names:
        mine = [d["id"] for d in matrix["defects"] if matrix["cells"][f"{d['id']}|{n}"]["found"]]
        lines.append(f"- {n}: found {len(mine)} ({', '.join(mine) or 'none'})")
    return "\n".join(lines)


def load_ground_truth(path: Path) -> list[dict[str, Any]]:
    return parse_ground_truth(Path(path).read_text())


def _found_counts(matrix: dict[str, Any]) -> dict[str, tuple[int, int]]:
    """Defect id to (runs that found it, runs graded)."""
    out: dict[str, tuple[int, int]] = {}
    for d in matrix["defects"]:
        found = n = 0
        for name in matrix["archetypes"]:
            cell = matrix["cells"].get(f"{d['id']}|{name}") or {}
            found += cell.get("found", 0)
            n += cell.get("n", 0)
        out[d["id"]] = (found, n)
    return out


def render_comparison(earlier: dict[str, Any], later: dict[str, Any]) -> str:
    """Per defect: runs that found it in each study, and what changed."""
    a, b = _found_counts(earlier), _found_counts(later)
    lines = [f"Compared with study {earlier.get('studyId') or 'earlier'}:", "",
             f"| Defect | {earlier.get('studyId', 'earlier')[:8]} found | {later.get('studyId', 'this')[:8]} found | Change |",
             "|---|---|---|---|"]
    for d in later["defects"]:
        fa, na = a.get(d["id"], (0, 0))
        fb, nb = b.get(d["id"], (0, 0))
        change = ("newly found" if fb and not fa else "no longer found" if fa and not fb
                  else "found in both" if fa and fb else "found in neither")
        lines.append(f"| {d['id']} {d['title'][:50]} | {fa} of {na} runs | {fb} of {nb} runs | {change} |")
    new = [d["id"] for d in later["defects"] if b.get(d["id"], (0, 0))[0] and not a.get(d["id"], (0, 0))[0]]
    lines.append("")
    lines.append(f"Newly found: {', '.join(new) or 'none'}.")
    return "\n".join(lines)

