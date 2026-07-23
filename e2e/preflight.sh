#!/usr/bin/env bash
# e2e/preflight.sh — preconditions for the Archetype plugin live E2E test.
#
# Prints one PASS / FAIL / INFO line per check. Exits non-zero if ANY hard
# check FAILs (INFO checks never fail the script). Encodes the verified
# playbook (docs/E2E_HARNESS_NOTES.md §0/§3/§7) and clears stale plugin auth so
# the login wizard renders deterministically (criterion A3).
#
# Run:  bash e2e/preflight.sh
# Note: the backend and demo app are started SEPARATELY (see e2e/RUNBOOK.md);
#       this script only probes that they are up.

BACKEND_DIR="/Users/hanyanggu/Personal_Files/Coding/Archetype_all/Archetype_Core/Archetype_Backend"
DEMO_SERVE="/Users/hanyanggu/Personal_Files/Coding/Archetype_all/Archetype_Plugins/demo-app/serve.sh"

fail=0
pass() { echo "PASS  $1"; }
fatal() { echo "FAIL  $1"; fail=1; }
info()  { echo "INFO  $1"; }

# --- tmux present -----------------------------------------------------------
if command -v tmux >/dev/null 2>&1; then
  pass "tmux present ($(tmux -V))"
else
  fatal "tmux not found — install it (brew install tmux)"
fi

# --- claude present ---------------------------------------------------------
if command -v claude >/dev/null 2>&1; then
  pass "claude present ($(claude --version 2>/dev/null))"
else
  fatal "claude not found on PATH"
fi

# --- backend .env exists ----------------------------------------------------
if [ -f "$BACKEND_DIR/.env" ]; then
  pass "backend .env exists ($BACKEND_DIR/.env)"
else
  fatal "backend .env missing at $BACKEND_DIR/.env — pipeline env (Mongo/Gemini/Auth0) will not load"
fi

# --- backend /health on :5001 ----------------------------------------------
health="$(curl -s -m 3 http://localhost:5001/health 2>/dev/null)"
if printf '%s' "$health" | grep -q '"status"[[:space:]]*:[[:space:]]*"ok"'; then
  pass "backend /health ok on :5001"
else
  fatal "backend not healthy on :5001 — start it: cd $BACKEND_DIR && nohup uv run python app.py > /tmp/e2e_backend.log 2>&1 &"
fi

# --- demo app on :8321 ------------------------------------------------------
demo="$(curl -s -m 3 http://localhost:8321 2>/dev/null)"
if printf '%s' "$demo" | grep -q 'id="cta-trial"'; then
  pass "demo app serving on :8321 (Lumina Notes)"
else
  fatal "demo app not serving on :8321 — start it: sh $DEMO_SERVE &"
fi

# --- redis (INFORMATIONAL — Flask API runs without a worker; notes §3) ------
if command -v redis-cli >/dev/null 2>&1 && [ "$(redis-cli ping 2>/dev/null)" = "PONG" ]; then
  info "redis-cli ping → PONG (needed only if a Celery worker is run)"
else
  info "redis not answering PONG — fine for the plugin actor flow (no worker needed)"
fi

# --- stale plugin auth cleanup (forces the wizard — criterion A3) -----------
removed="$(ls ~/.claude/plugins/data/archetype-*/auth.json 2>/dev/null)"
if [ -n "$removed" ]; then
  rm -f ~/.claude/plugins/data/archetype-*/auth.json
  echo "PASS  removed stale plugin auth (forces the login wizard):"
  printf '        %s\n' $removed
else
  pass "no stale plugin auth.json present (wizard will render)"
fi

# --- Screen Recording probe (MANUAL vision confirmation required; notes §7) -
open -a Calculator 2>/dev/null
sleep 2
screencapture -x /tmp/e2e_sr_check.png 2>/dev/null
# Quit Calculator so it can't cover Chrome during the A4 captures later.
osascript -e 'quit app "Calculator"' 2>/dev/null
echo "MANUAL STEP: orchestrator must visually Read /tmp/e2e_sr_check.png and confirm"
echo "             the Calculator window is visible — file size is NOT authoritative"
echo "             (wallpaper-only captures are full-size). If only wallpaper + menu"
echo "             bar show, grant Screen Recording to Terminal (Settings → Privacy &"
echo "             Security → Screen & System Audio Recording) and re-run."

echo
if [ "$fail" -ne 0 ]; then
  echo "PREFLIGHT: FAIL — resolve the FAIL line(s) above before starting the run."
  exit 1
fi
echo "PREFLIGHT: all hard checks PASS — remember to complete the MANUAL Screen Recording confirmation."
exit 0
