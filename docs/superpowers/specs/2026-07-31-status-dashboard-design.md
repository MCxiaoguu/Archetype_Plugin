# Status dashboard + self-healing auth — design

Date: 2026-07-31
Status: approved (local run log variant)

## Problem

1. There is no way to see at a glance which Archetype account the plugin is
   connected to, whether the backend is reachable, or to jump to the portal.
2. When the cached token is missing or expired, every actor command costs three
   tool calls (`<tool>` → "Not connected" → `login` → retry) instead of one.

## Design

### 1. `status` MCP tool (`scripts/setup-server.py`)

One tool call renders the whole dashboard:

- **Account** — decode the cached `id_token` payload from
  `${CLAUDE_PLUGIN_DATA}/auth.json` (base64 decode only; display, not trust)
  for email/name; fall back to `user_id` from `POST /api/oauth/validate-token`.
  If there is no `auth.json`, say "not connected" and point at the login wizard.
- **Connection health** — the same `validate-token` call yields valid/expired;
  report the backend base URL and reachability (network errors render plainly).
- **Features** — count from the existing `GET /api/features`.
- **Recent runs** — last 5 entries of the local run log (below).
- **Portal link** — `ARCHETYPE_PORTAL_URL` env var, default
  `https://www.syntheticarchetype.com` (mirrors `ARCHETYPE_BACKEND_URL`).

### 2. `status` skill (`skills/status/SKILL.md`)

`/archetype:status` → call the `status` tool once, render its text as a compact
dashboard with the clickable portal link. No other tool calls.

### 3. Local run log

`start_run` (on success) appends `{run_id, session_id, goal, url, feature_id,
started_at}` to `${CLAUDE_PLUGIN_DATA}/runs.json`; `report_result` (on success)
updates that entry with `{status, verdict, reported_at}`. Keep the newest 20
entries. Corrupt/missing log is never fatal — degrade to "no runs recorded".

Limitation (accepted): only runs started from this machine appear. Full
cross-device history lives in the portal; a `GET /api/plugin/runs` backend
listing is a possible later upgrade.

### 4. Self-healing auth

A shared `authed_call()` used by `start_run`, `report_result`, `get_run`,
`list_features` (`status` deliberately does NOT self-heal — asking for status
must never pop a login modal):

1. Load the cached token. If present, use it (unchanged fast path).
2. If missing — or the backend answers 401 — run the existing device-flow
   login inline (same elicitation modal), save the token, and retry the
   original backend call once.
3. If the user cancels or the flow fails, return the current "Not connected /
   login hint" error text.

The explicit `login` tool remains for the wizard and for hooks. Net effect:
worst case is one tool call from the actor's side, with the human-in-the-loop
approval happening inside it.

### 5. Skill wording

Skills load all needed MCP tools in a single ToolSearch `select:` query, and
the "on Not connected → login → retry" instruction shrinks to "the tools log
you in automatically; if a tool still errors, follow its message".

## Testing

- Unit (`scripts/test_setup_server.py`): status rendering (connected /
  not-connected / backend-down), id_token payload decoding, run-log append /
  update / truncation / corrupt-file tolerance, self-heal retry on 401 and
  missing token (login mocked).
- Live: tmux E2E harness (`e2e/RUNBOOK.md`) against the marketplace-installed
  plugin before pushing.

## Out of scope

- Backend changes in Archetype_Core (no runs-list endpoint yet).
- Token refresh via `refresh_token` (device flow re-run is acceptable).
