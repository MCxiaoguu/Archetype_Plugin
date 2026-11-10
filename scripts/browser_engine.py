"""Which browser the plugin's Playwright servers launch.

Playwright MCP drives the installed Google Chrome by default. Machines
without it (CI images, Linux servers, fresh laptops) often have Playwright's
own Chromium instead, downloaded by `npx playwright install chromium` into
the ms-playwright cache. Order:

1. Google Chrome at its standard location: `--browser chrome`.
2. Playwright's bundled Chromium, the newest revision in the cache:
   `--browser chromium --executable-path <binary>`.
3. Neither: an error that says how to install one.

browser-server.py uses the flags; core-server.py uses the label, so the
browser config a run records (claim and report) names the engine that
actually ran. Detection is a few stat calls, done again on every launch so
installing a browser needs no restart.

Overrides: ARCHETYPE_CHROME_PATHS (paths separated by os.pathsep) replaces
the Chrome locations, PLAYWRIGHT_BROWSERS_PATH the cache (Playwright's own
variable). Stdlib only.
"""

from __future__ import annotations

import glob
import os
import re
import sys
from pathlib import Path
from typing import Any

INSTALL_HINT = "npx playwright install chromium"


def chrome_paths() -> list[str]:
    override = os.environ.get("ARCHETYPE_CHROME_PATHS")
    if override is not None:
        return [p for p in override.split(os.pathsep) if p]
    if sys.platform == "darwin":
        app = "Google Chrome.app/Contents/MacOS/Google Chrome"
        return [f"/Applications/{app}", str(Path.home() / "Applications" / app)]
    if sys.platform.startswith("win"):
        tail = os.path.join("Google", "Chrome", "Application", "chrome.exe")
        roots = [os.environ.get(k) for k in ("PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA")]
        return [os.path.join(r, tail) for r in roots if r]
    return ["/opt/google/chrome/chrome", "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable"]


def playwright_cache_dirs() -> list[Path]:
    custom = os.environ.get("PLAYWRIGHT_BROWSERS_PATH")
    if custom and custom != "0":
        return [Path(custom)]
    if sys.platform == "darwin":
        return [Path.home() / "Library" / "Caches" / "ms-playwright"]
    if sys.platform.startswith("win"):
        local = os.environ.get("LOCALAPPDATA")
        return [Path(local) / "ms-playwright"] if local else []
    cache = os.environ.get("XDG_CACHE_HOME") or str(Path.home() / ".cache")
    return [Path(cache) / "ms-playwright"]


# The Chromium binary inside one chromium-<revision> folder, per platform
# and per packaging (Chromium builds, then Chrome for Testing builds).
_BINARIES = (
    "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    "chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    "chrome-mac/Chromium.app/Contents/MacOS/Chromium",
    "chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium",
    "chrome-linux64/chrome",
    "chrome-linux/chrome",
    "chrome-win64/chrome.exe",
    "chrome-win/chrome.exe",
)


def bundled_chromium() -> tuple[str, str] | None:
    """(binary, revision) of the newest installed Playwright Chromium."""
    found: list[tuple[int, str, str]] = []
    for cache in playwright_cache_dirs():
        for folder in glob.glob(str(cache / "chromium-*")):
            match = re.search(r"chromium-(\d+)$", folder)
            if not match:
                continue
            for rel in _BINARIES:
                binary = os.path.join(folder, rel)
                if os.path.isfile(binary) and os.access(binary, os.X_OK):
                    found.append((int(match.group(1)), binary, match.group(1)))
                    break
    if not found:
        return None
    _, binary, revision = max(found)
    return binary, revision


def pick() -> dict[str, Any]:
    """The engine to launch: {engine, args, label} or {error}."""
    for path in chrome_paths():
        if os.path.isfile(path):
            return {"engine": "chrome", "args": ["--browser", "chrome"], "label": "chrome channel",
                    "executable": path}
    bundled = bundled_chromium()
    if bundled:
        binary, revision = bundled
        return {"engine": "chromium", "args": ["--browser", "chromium", "--executable-path", binary],
                "label": f"bundled chromium {revision}", "executable": binary}
    looked = ", ".join([*chrome_paths(), *(str(c) for c in playwright_cache_dirs())])
    return {"error": (
        "No browser for the plugin's Playwright servers: Google Chrome is not installed and "
        f"Playwright's bundled Chromium was not found (looked in {looked}). Install one with "
        f"`{INSTALL_HINT}` (or install Google Chrome), then call the browser tool again; "
        "no restart is needed."
    )}
