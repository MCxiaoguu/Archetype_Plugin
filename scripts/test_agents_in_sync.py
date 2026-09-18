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


def main() -> int:
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
