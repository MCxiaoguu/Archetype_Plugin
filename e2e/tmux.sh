#!/usr/bin/env bash
# e2e/tmux.sh — sourceable tmux helpers for the Archetype plugin live E2E test.
#
# These wrappers encode the VERIFIED recipes from docs/E2E_HARNESS_NOTES.md
# (§4 launch, §4.3 slash-command submit, §4.4 elicitation modal keys, §8 idle
# detection). Source it, then drive the inner Claude Code session by name:
#
#   . e2e/tmux.sh
#   e2e_start
#   e2e_send "mkdir -p /tmp/e2e_inner && cd /tmp/e2e_inner && ... claude ..."
#   e2e_send "/archetype:validation"
#   e2e_keys Space Down Enter
#   e2e_pane
#   e2e_idle && echo "turn finished"
#   e2e_stop
#
# Requires bash (uses arrays and local). All helpers target one fixed session
# name so the outer session's tmux target is unambiguous (notes §8 caution).

E2E_SESSION="${E2E_SESSION:-archetype-e2e}"

# Start a detached session with a generous pane so dialogs/modals don't
# truncate (notes §4.1: -x 220 -y 50). No-op if it already exists.
e2e_start() {
  if tmux has-session -t "$E2E_SESSION" 2>/dev/null; then
    echo "e2e_start: session '$E2E_SESSION' already exists"
    return 0
  fi
  tmux new-session -d -s "$E2E_SESSION" -x 220 -y 50
  echo "e2e_start: started session '$E2E_SESSION' (220x50)"
}

# Send literal text, let autocomplete settle, then submit with Enter.
# The sleep 1 is VERIFIED necessary for slash commands (notes §4.3): the
# typed-out command must win over the autocomplete menu before Enter.
e2e_send() {
  tmux send-keys -t "$E2E_SESSION" -l "$1"
  sleep 1
  tmux send-keys -t "$E2E_SESSION" Enter
}

# Send raw tmux key names (NOT literal text) for modal/dialog driving:
#   e2e_keys Space Down Enter   # accept the elicitation modal (notes §4.4)
#   e2e_keys Enter              # accept the trust dialog (notes §4.2)
#   e2e_keys Escape             # cancel a modal
e2e_keys() {
  local k
  for k in "$@"; do
    tmux send-keys -t "$E2E_SESSION" "$k"
  done
}

# Dump the pane with 200 lines of scrollback (notes §8: dialogs/results scroll
# fast, never grep only the visible pane for history).
e2e_pane() {
  tmux capture-pane -t "$E2E_SESSION" -p -S -200
}

# Return 0 iff the pane looks IDLE (a turn has finished): an empty input
# prompt line "❯" is present AND no LIVE spinner is on screen (notes §8:
# while busy the pane shows a spinner line like "✽ Fluttering… (14s · ↓ 420
# tokens)" plus an "esc to interrupt" affordance; when idle the bottom shows an
# empty "❯" and a closing line like "✻ Cogitated for 27s"). Uses the last
# visible pane only — spinner state is a live property, not scrollback.
#
# CAUTION: the closing "✻ Cogitated…" glyph appears on IDLE panes too, so it is
# NOT a busy signal. Reliable busy signals are the live token counter
# ("· ↓ N tokens") and "esc to interrupt". We match those, not the glyph alone.
e2e_idle() {
  local pane
  pane="$(tmux capture-pane -t "$E2E_SESSION" -p)"
  # Busy signals: the running token counter or the interrupt affordance.
  if printf '%s' "$pane" | grep -qE '·[[:space:]]*↓[[:space:]]*[0-9].*token|esc to interrupt'; then
    return 1
  fi
  # Idle signal: a prompt line showing "❯".
  if printf '%s' "$pane" | grep -q '❯'; then
    return 0
  fi
  return 1
}

# Return 0 iff a dialog/modal that needs operator keys is on screen, and print
# ALL distinct matched patterns so the caller can branch (notes §8). Searches
# scrollback so a modal that just scrolled is still caught — which also means
# matches may be STALE (e.g. the trust dialog stays in scrollback after it was
# accepted). To ask "is dialog X up NOW", grep the visible pane instead:
#   tmux capture-pane -t "$E2E_SESSION" -p | grep -q 'requests your input'
e2e_dialog() {
  local pane matches m
  pane="$(tmux capture-pane -t "$E2E_SESSION" -p -S -200)"
  matches="$(printf '%s' "$pane" | grep -Eo 'requests your input|trust this folder|Do you want' | sort -u)"
  if [ -n "$matches" ]; then
    printf '%s\n' "$matches" | while IFS= read -r m; do
      echo "e2e_dialog: matched '$m'"
    done
    return 0
  fi
  return 1
}

# Kill the session (teardown). No-op if it's already gone.
e2e_stop() {
  if tmux has-session -t "$E2E_SESSION" 2>/dev/null; then
    tmux kill-session -t "$E2E_SESSION"
    echo "e2e_stop: killed session '$E2E_SESSION'"
  else
    echo "e2e_stop: no session '$E2E_SESSION' to kill"
  fi
}
