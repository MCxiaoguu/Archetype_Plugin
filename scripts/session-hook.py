#!/usr/bin/env python3
"""SessionStart hook: one line when the session cannot run Archetype commands.

Silent when connected. Purely local (no network), and it never fails the
session: any surprise is swallowed, because a hook that errors is worse than
a missing nudge.
"""

from __future__ import annotations

import json
import os
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


if __name__ == "__main__":
    try:
        message = nudge()
        if message:
            print(message)
    except Exception:
        pass
    sys.exit(0)
