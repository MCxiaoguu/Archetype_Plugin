#!/usr/bin/env python3
"""The two actor agents must differ only in how they talk to their browser.

agents/feature-validator.md is the source of truth for the actor loop.
agents/feature-validator-headless.md runs the same loop on Playwright. This
check fails when a change lands in one procedure and not the other.

Run:  python3 scripts/test_agents_in_sync.py
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

AGENTS = Path(__file__).resolve().parent.parent / "agents"

# The only parts of the procedure allowed to differ: the browser preflight
# (step 2) and the sentence that opens the site (start of step 5).
BROWSER_SPECIFIC = (
    re.compile(r"^2\. \*\*Prove the browser works.*?(?=^3\. )", re.M | re.S),
    re.compile(r"^5\. \*\*Open the site\.\*\* .*$", re.M),
)


def shared_procedure(path: Path) -> str:
    text = path.read_text()
    start = text.index("## Operating procedure")
    body = text[start:]
    for pattern in BROWSER_SPECIFIC:
        body, count = pattern.subn("<browser specific>\n", body, count=1)
        if count != 1:
            raise SystemExit(f"FAIL  {path.name}: expected browser-specific block not found")
    return body


# What every actor must carry for protocol 2 (plan 5.2, 5.7).
REQUIRED_TOOLS = (
    "mcp__plugin_archetype_core__start_run",
    "mcp__plugin_archetype_core__log_step",
    "mcp__plugin_archetype_core__report_result",
)
PER_STEP_MUSTS = ("log_step", "Trust gates", "Giving up", "abandoned", "visible_text_excerpt", "trust_refused")


def frontmatter(path: Path) -> dict[str, str]:
    text = path.read_text()
    if not text.startswith("---\n"):
        raise SystemExit(f"FAIL  {path.name}: no frontmatter")
    block = text[4:text.index("\n---", 4)]
    out = {}
    for line in block.splitlines():
        key, _, value = line.partition(":")
        out[key.strip()] = value.strip()
    return out


def check_protocol_v2(path: Path) -> list[str]:
    """Problems with an agent's protocol v2 wiring, empty when it is fine."""
    problems = []
    meta = frontmatter(path)
    tools = [t.strip() for t in meta.get("tools", "").split(",")]
    for tool in REQUIRED_TOOLS:
        if tool not in tools:
            problems.append(f"tools: is missing {tool}")
    if meta.get("maxTurns") != "120":
        problems.append(f"maxTurns should be 120, got {meta.get('maxTurns')!r}")
    text = path.read_text()
    if "## Per-step protocol" not in text:
        problems.append("no '## Per-step protocol' section")
    else:
        section = text[text.index("## Per-step protocol"):]
        section = section[: section.index("\n## ", 4)] if "\n## " in section[4:] else section
        for must in PER_STEP_MUSTS:
            if must not in section:
                problems.append(f"per-step protocol does not mention {must!r}")
    if "browser_close" not in text:
        problems.append("never says to close the browser (the video is written on close)")
    return problems


def main() -> int:
    for name in ("feature-validator.md", "feature-validator-headless.md"):
        problems = check_protocol_v2(AGENTS / name)
        if problems:
            print(f"FAIL  {name}: " + "; ".join(problems))
            return 1
    print("PASS  both actors carry log_step, maxTurns 120 and the per-step protocol")
    meta = frontmatter(AGENTS / "feature-validator-headless.md")
    tools = [t.strip() for t in meta.get("tools", "").split(",")]
    denied = meta.get("disallowedTools", "")
    servers = [f"archetype-browser-{i}" for i in range(1, 5)] + [f"archetype-watch-{i}" for i in range(1, 3)]
    for server in servers:
        if f"mcp__plugin_archetype_{server}__*" not in tools:
            print(f"FAIL  feature-validator-headless: tools: does not allowlist {server}")
            return 1
        if f"mcp__plugin_archetype_{server}__browser_run_code_unsafe" not in denied:
            print(f"FAIL  feature-validator-headless: {server} may run arbitrary code")
            return 1
    print("PASS  the headless actor can drive each plugin browser, minus the code running tools")
    chrome = shared_procedure(AGENTS / "feature-validator.md")
    headless = shared_procedure(AGENTS / "feature-validator-headless.md")
    if chrome == headless:
        print("PASS  actor procedures are in sync")
        return 0
    a, b = chrome.splitlines(), headless.splitlines()
    for i, (x, y) in enumerate(zip(a, b), start=1):
        if x != y:
            print(f"FAIL  procedures diverge at shared line {i}:\n  chrome:   {x}\n  headless: {y}")
            return 1
    print(f"FAIL  procedures differ in length ({len(a)} vs {len(b)} lines)")
    return 1


if __name__ == "__main__":
    sys.exit(main())
