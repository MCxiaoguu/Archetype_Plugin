#!/usr/bin/env python3
"""SessionStart hook: one line when the session cannot run Archetype commands.

Silent when connected, and it never fails the session: any surprise is
swallowed, because a hook that errors is worse than a missing nudge.

Once per pinned browser package it also starts a detached
`npx -y <package> --help` in the background, so the npm download (up to a
few minutes on a cold cache) happens before the first validation instead
of during it. ARCHETYPE_NO_PREWARM=1 turns that off.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path


def nudge() -> str | None:
    plugin_data = os.environ.get("CLAUDE_PLUGIN_DATA")
    if not plugin_data:
        return None
    auth_path = Path(plugin_data) / "auth.json"
    if not auth_path.exists():
        return "archetype: not connected. Run /archetype:setup to get started."
    try:
        auth = json.loads(auth_path.read_text())
    except Exception:
        return "archetype: saved login is unreadable. Run /archetype:setup to reconnect."
    if not isinstance(auth, dict) or not auth.get("access_token"):
        return "archetype: not connected. Run /archetype:setup to get started."
    if auth.get("refresh_token"):
        # The core server renews an expired login with it, no prompt needed.
        return None
    saved_at, expires_in = auth.get("saved_at"), auth.get("expires_in")
    if isinstance(saved_at, (int, float)) and isinstance(expires_in, (int, float)):
        remaining = saved_at + expires_in - time.time()
        if remaining <= 0:
            return (
                "archetype: your login has expired. Run /archetype:setup before "
                "starting a validation (subagents cannot show the login prompt)."
            )
        if remaining < 3600:
            return (
                f"archetype: your login expires in about {max(int(remaining // 60), 1)} "
                "minute(s). Run /archetype:setup now if you plan a long validation."
            )
    return None


def prewarm_browser() -> bool:
    """Start the one time background download of the pinned browser server.
    Returns True when a download was started."""
    plugin_data = os.environ.get("CLAUDE_PLUGIN_DATA")
    if not plugin_data or os.environ.get("ARCHETYPE_NO_PREWARM") == "1":
        return False
    npx = shutil.which("npx")
    if not npx:
        return False  # the browser servers report the missing Node themselves
    pinned = Path(__file__).resolve().parent.parent / "browser" / "pinned.json"
    package = json.loads(pinned.read_text())["package"]
    marker = Path(plugin_data) / "browser" / (".warm-" + package.replace("/", "_").replace("@", ""))
    if marker.exists():
        return False
    marker.parent.mkdir(parents=True, exist_ok=True)
    marker.write_text(str(int(time.time())) + "\n")  # once: a failed download is retried by the server itself
    subprocess.Popen(
        [npx, "-y", package, "--help"],
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    return True


if __name__ == "__main__":
    try:
        message = nudge()
        if message:
            print(message)
    except Exception:
        pass
    try:
        prewarm_browser()
    except Exception:
        pass
    sys.exit(0)
