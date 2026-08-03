# E2E Harness Playbook — Real Claude Code Plugin Test via tmux

Research notes for running a REAL end-to-end test of the `archetype` plugin:
an outer Claude Code session drives an inner Claude Code session (in tmux) that
loads the plugin, completes the MCP elicitation login wizard, drives Chrome via
Claude-in-Chrome, and reports back to a local Flask backend.

Everything marked **[verified]** was actually executed on this machine
(macOS darwin 24.3.0) on 2026-07-22. Everything else is flagged in
"Risks / unknowns".

---

## 0. GO / NO-GO summary

| Question | Answer |
|---|---|
| tmux installed? | **GO** — tmux 3.5a `[verified]` |
| Claude Code version | 2.1.170 at `~/.nvm/versions/node/v22.16.0/bin/claude` `[verified]` |
| Plugin loads via `--plugin-dir`? | **GO** — 4 skills + 1 agent + hooks + MCP server `core` all load `[verified]` |
| Elicitation modal renders in tmux TUI? | **GO** — rendered, interacted with, cancelled `[verified]` |
| Does `--dangerously-skip-permissions` auto-accept elicitation? | **NO** — elicitation ALWAYS needs interactive keys (docs + observed: modal appeared even though auto mode had already approved the tool call) |
| Headless `claude -p` viable? | Plugins + plugin MCP servers load in `-p` `[verified]`, but print mode does **not** support elicitation (official docs) → interactive TUI in tmux is REQUIRED for the wizard |
| Chrome MCP sharing model | Built-in MCP (extension relay via native messaging), account-scoped. Outer and inner sessions were BOTH "connected" simultaneously `[verified]`. Each session opens its own tabs. Recommendation: only the inner session drives Chrome |
| MongoDB path | No local mongod. Backend `.env` points at the **Atlas dev cluster** and connects fine `[verified]`. Docker daemon not running; docker-compose has no mongo service anyway |
| Redis | **GO** — running via brew services, `redis-cli ping` → PONG `[verified]` |
| Backend on :5001 | **GO** — `uv run python app.py` → `/health` 200 and `/api/oauth/device/code` works locally `[verified]` |
| Vision verification via `screencapture` | **BLOCKED until permission granted** — Screen Recording is NOT granted to Terminal.app; captures show wallpaper + menu bar only `[verified]`. Fix in §7 |

---

## 1. Machine inventory `[verified]`

```
tmux -V                  → tmux 3.5a
claude --version         → 2.1.170 (Claude Code)
which claude             → /Users/hanyanggu/.nvm/versions/node/v22.16.0/bin/claude
python3 --version        → Python 3.11.14   (system; backend venv uses 3.13)
uv --version             → uv 0.8.12
docker --version         → 28.2.2, but daemon NOT running (docker ps fails)
mongod / mongosh         → NOT installed
brew services            → redis: started;  redis-cli ping → PONG
GetWindowID              → NOT installed (brew install smokris/getwindowid/getwindowid if needed)
Chrome                   → RUNNING; native messaging host file present:
  ~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.anthropic.claude_code_browser_extension.json
```

MCP configuration (`~/.claude.json`, secrets redacted):
- User-scope `mcpServers`: only `codex` (stdio). **claude-in-chrome is NOT a
  user-configured MCP server** — it is a *built-in MCP* (`/mcp` panel lists it
  under "Built-in MCPs (always available)").
- `claudeInChromeDefaultEnabled: true`, `cachedChromeExtensionInstalled: true`,
  `hasCompletedClaudeInChromeOnboarding: true` → Chrome tools load in every
  session without `--chrome`.
- Project-scope servers exist for other Archetype dirs (mongodb-mcp with an
  Atlas dev URI — credentials redacted; browser-use HTTP MCP) — not relevant to
  the inner session if it runs in a scratch cwd.

---

## 2. Plugin facts `[verified]`

- Manifest: `.claude-plugin/plugin.json` → plugin name `archetype`, MCP server
  `core` = `python3 ${CLAUDE_PLUGIN_ROOT}/scripts/core-server.py`.
- Backend URL for the MCP server comes from env `ARCHETYPE_BACKEND_URL`
  (default `https://api.syntheticarchetype.com`). **Export it before launching
  the inner claude** — the MCP server inherits the CLI's environment.
- Full MCP tool name (confirmed in both TUI debug log and `-p` mode):
  `mcp__plugin_archetype_core__login`
- Plugin data dir (`CLAUDE_PLUGIN_DATA`) for a `--plugin-dir` load resolves to:
  `~/.claude/plugins/data/archetype-inline/` — an `auth.json` from May 2026
  already exists there (expired, 24 h TTL). **Delete it before an E2E run** to
  force the wizard deterministically:
  `rm -f ~/.claude/plugins/data/archetype-inline/auth.json`
- SessionStart hook prints "archetype: not connected…" when auth.json is absent.
- The login tool also calls `webbrowser.open(verify_url)` → the default browser
  will really open the Auth0 activate page when the wizard runs.
- Tool call sequence observed in the inner session: the model first loads the
  deferred MCP tool schema via ToolSearch, then calls the login tool — allow
  a couple of extra seconds before expecting the modal.

---

## 3. Backend: fastest path to localhost:5001 `[verified]`

No docker needed. Real Mongo = Atlas dev cluster (reachable from this machine),
real Redis = local brew service (already running).

```bash
cd /Users/hanyanggu/Personal_Files/Coding/Archetype_all/Archetype_Core/Archetype_Backend
nohup uv run python app.py > /tmp/e2e_backend.log 2>&1 &
echo $! > /tmp/e2e_backend.pid
# wait ~10-12s (Atlas index init on startup), then:
curl -s http://localhost:5001/health          # → {"status":"ok"}
```

Notes discovered:
- **Do NOT `source .env`** — it is not shell-syntax-safe (unquoted `&` in the
  Mongo URI breaks zsh) `[verified]`. You don't need to: `infrastructure/
  database/mongo_init.py` calls `dotenv.load_dotenv()` (cwd `.env`) and
  `tasks/__init__.py` loads it too, so plain `uv run python app.py` from the
  backend dir picks up all env vars. (`app.py`'s own `load_dotenv("/app/.env")`
  is a docker path and silently no-ops locally.) If you ever need explicit
  loading: `uv run --env-file .env python app.py`.
- Mandatory env (all present in `.env`): `MONGODB_URI`, `REDIS_URL`,
  `GEMINI_API_KEY`, `AUTH0_DOMAIN`/`AUTH0_AUDIENCE` (+
  `AUTH0_DEVICE_AUTH_DOMAIN`, `AUTH0_DEVICE_AUTH_CLIENTID` for device flow).
- **Dev auth bypass**: `DEV_MODE=1` is set in `.env`; `require_auth` is
  bypassed per-request as long as `FLASK_ENV != production` (dual gate in
  `infrastructure/auth/jwt_validator.py`). So protected `/api/*` endpoints
  accept requests without a token locally. The oauth endpoints
  (`/api/oauth/device/*`, `/validate-token`) are NOT `require_auth`-guarded;
  they proxy the REAL Auth0 tenant — so the login wizard against
  `ARCHETYPE_BACKEND_URL=http://localhost:5001` performs a genuine device flow
  (browser approval included). `POST /api/oauth/device/code` on localhost
  returned a real device_code `[verified]`.
- **Celery/Redis**: the Flask API runs without a worker. Only
  `POST /api/uat/tests/<id>/run` dispatches `run_uat_test.delay(...)` — that
  needs `uv run celery -A tasks worker --loglevel=info` in a second process
  (broker = local Redis, already up). Eager mode (`task_always_eager`) is only
  wired up inside tests, not via an env var. For the plugin-actor E2E (fetch
  instructions + POST results) you likely won't need the worker at all.
- App startup log showed no Mongo/analytics init failures → Atlas reachable
  `[verified]`.
- **Gap**: `skills/validate-feature/SKILL.md` references
  `POST {portal}/api/feature-validation/runs` — **no such route exists in the
  backend** (real routes are `/api/uat/tests...`). The "fetch instruction set /
  POST results" endpoints for the actor flow still need to be built or the
  skill pointed at the UAT routes.

Teardown: `kill $(cat /tmp/e2e_backend.pid)`.

---

## 4. Driving the inner Claude Code via tmux `[verified]`

### 4.1 Launch

```bash
mkdir -p /tmp/e2e_inner            # scratch cwd keeps project settings out
tmux new-session -d -s inner -x 220 -y 50
tmux send-keys -t inner -l 'cd /tmp/e2e_inner && ARCHETYPE_BACKEND_URL=http://localhost:5001 claude --plugin-dir /Users/hanyanggu/Personal_Files/Coding/Archetype_all/Archetype_Plugins --debug-file /tmp/e2e_inner_debug.log'
tmux send-keys -t inner Enter
```

Use `-l` (literal) for text so nothing is interpreted as a key name; send
`Enter` as a separate `send-keys` call. `-x/-y` sets a generous pane so dialogs
don't truncate. `--debug-file` gives a greppable log (MCP connect lines,
`[archetype-core]` stderr, tool names) without polluting the TUI.

### 4.2 Trust dialog (appears for a fresh cwd) `[verified]`

~10 s after launch the folder-trust dialog renders:

```
 Accessing workspace: /private/tmp/e2e_inner
 ❯ 1. Yes, I trust this folder
   2. No, exit
 Enter to confirm · Esc to cancel
```

Option 1 is pre-selected → `tmux send-keys -t inner Enter`. (No CLI flag exists
to skip the trust dialog; acceptance is persisted per-directory in
`~/.claude.json`, so it only appears the first time for a given cwd.)

### 4.3 Submit a prompt / slash command `[verified]`

```bash
tmux send-keys -t inner -l '/archetype:validation'
sleep 1                                   # let the autocomplete settle
tmux send-keys -t inner Enter             # submits (typed-out command wins over menu)
```

Verified: typing the full command then Enter submits directly; the model then
runs the skill. Plain prompts work the same way (`send-keys -l 'text'`,
`Enter`). If a stray autocomplete menu is open, `Escape` closes it without
clearing typed text.

Useful checks:
- `/mcp` panel `[verified]` shows:
  `plugin:archetype:core · ✔ connected · 1 tool` and
  `claude-in-chrome · ✔ connected · 22 tools` (Built-in). `Esc` closes it.
- Debug log markers: `grep "archetype" /tmp/e2e_inner_debug.log` →
  `Loaded 4 skills from plugin archetype`, `MCP server "plugin:archetype:
  core": Successfully connected`, `[archetype-core] server
  starting; backend=...` (confirms which backend URL the MCP server got).

### 4.4 The MCP elicitation modal `[verified]` — exact rendering & keys

After `/archetype:validation` (no cached token), the TUI shows:

```
  MCP server “plugin:archetype:core” requests your input

  Connect to Archetype
  1) ... https://dev-....us.auth0.com/activate?user_code=XXXX-XXXX
  2) Verification code (shown for cross-check): XXXX-XXXX
  3) Once you've approved in the browser, tick the box below and click Accept...

  ❯ * I've approved the request in my browser: ☐
    Accept    Decline

  Esc to cancel · ↑/↓ to navigate · Backspace to unset · Space to toggle
```

Key sequence to ACCEPT (after the Auth0 browser approval is done):

```bash
tmux send-keys -t inner Space      # tick the checkbox (focus starts on it)
tmux send-keys -t inner Down       # move to the Accept button
tmux send-keys -t inner Enter      # confirm
```

Key to CANCEL: `tmux send-keys -t inner Escape` → tool returns
"Login cancelled. Re-run /archetype:validation to try again." `[verified]`

Two important verified facts:
1. **Permission modes do not touch elicitation.** The probe ran in the user's
   default *auto mode*: the classifier approved the `login` tool call with no
   permission prompt, and the elicitation modal still rendered and waited for
   keys. Docs confirm `bypassPermissions` skips permission prompts only;
   server-initiated `elicitation/create` is a user-input request, always
   interactive. In `dontAsk`/`-p` modes such interaction is denied/unsupported.
2. **The wizard needs a real browser-side Auth0 approval** before Accept, or
   `poll_for_token` will spin until `expires_in` (default 900 s). For a fully
   automated test, the harness (outer session) must complete the Auth0 approval
   page in Chrome — or you accept the modal and let the poll time out as a
   negative-path test.

### 4.5 Friction-reducing flags for the inner session

- `--permission-mode acceptEdits` or `--dangerously-skip-permissions`:
  removes tool-permission prompts (NOT the elicitation modal, NOT the
  first-run bypassPermissions warning dialog — that one appears once per user
  and needs an interactive accept; this user's default is auto mode, which
  already ran the MCP tool without prompting `[verified]`).
- `--allowedTools "mcp__plugin_archetype_core__login"` pre-approves
  just the login tool in default/manual mode.
- First Chrome action in a session asks permission to use the
  `claude-in-chrome` skill (docs); in auto mode it goes through the classifier.
  If running in manual mode, watch for that prompt and send Enter/`1`.
- Don't use `--permission-mode dontAsk` or `-p` — both kill the wizard.
- `/reload-plugins` in-session picks up plugin edits without restarting.

---

## 5. Claude-in-Chrome model (inner vs outer)

From `https://code.claude.com/docs/en/chrome.md` + local observation:

- Transport: Chrome **extension ⇄ native messaging host ⇄ claude CLI**; the
  host config JSON exists on this machine. It is a *built-in MCP server*
  ("always available"), not an entry in any mcpServers config. Enablement is
  account/user-level (`/chrome` → "Enabled by default", already on here).
- Requires: extension ≥ 1.0.36 (installed), Chrome running, subscription
  login (`/login`, not API key). All satisfied here `[verified]` (Max plan).
- **Concurrency**: the outer session (this one) and the inner probe session
  were connected to Chrome *at the same time* — inner `/mcp` showed
  `claude-in-chrome ✔ connected` while the outer session's
  `list_connected_browsers` returned the same local browser
  (`deviceId 66396e5d…`, `isLocal: true`) `[verified]`. Each session opens its
  own tabs / tab group. Docs only warn about conflicts on Windows named pipes.
- **Recommendation** stands: let ONLY the inner session drive Chrome (click,
  type, navigate). The outer session verifies via backend assertions +
  `screencapture` (§7), and at most uses read-only Chrome tools
  (`tabs_context_mcp`, `get_page_text`) if screen capture is unavailable —
  avoids tab-selection prompts and interleaved-driver confusion.
- Gotchas: extension service worker can idle out on long sessions → `/chrome`
  → "Reconnect extension". JS `alert()`/`confirm()` dialogs block all commands.
  If more than one browser is connected, the first action triggers a
  browser-picker prompt inside the TUI — only one is connected here today.
- Site permissions are inherited from the extension's own settings — make sure
  `localhost` is allowed there before the run.

---

## 6. Headless `-p` mode facts `[verified]`

```bash
cd /tmp/e2e_inner && claude -p \
  --plugin-dir /Users/hanyanggu/Personal_Files/Coding/Archetype_all/Archetype_Plugins \
  'Output only the exact full tool name of the archetype login MCP tool available to you, nothing else.'
# → mcp__plugin_archetype_core__login
```

So `-p` is fine for *non-wizard* plugin smoke tests (skills, MCP server
liveness, backend-driven runs once a token exists) and supports
`--output-format json`, `--max-turns`, `--permission-prompt-tool`. It cannot
render elicitation (docs: print mode is non-interactive by design) → the
login wizard leg must run in the tmux TUI.

---

## 7. Vision verification for the outer session

**Current state: BLOCKED.** `screencapture -x /tmp/shot.png` succeeds
(2940×1912 PNG) but contains ONLY wallpaper + menu bar; a foreground
Calculator window was invisible in the capture `[verified]`. That is the
classic signature of missing **Screen Recording** permission for the invoking
app. This shell's ancestry is `Terminal.app → login → zsh → claude` 
`[verified]`, so:

> System Settings → Privacy & Security → Screen & System Audio Recording →
> enable **Terminal** (then fully quit & reopen Terminal).

Re-verify with the same probe: open any app window, `screencapture -x
/tmp/shot.png`, `Read` the PNG — window content must be visible.

Once granted:
- Whole screen (single built-in display 2560×1664 here):
  `screencapture -x /tmp/shot.png` → read with the Read tool (it renders PNGs).
- Window-scoped capture: `GetWindowID` is not installed
  (`brew install smokris/getwindowid/getwindowid`), or use a one-liner via
  Quartz — note system `python3` lacks pyobjc `[verified]`, so either
  `pip3 install pyobjc-framework-Quartz` or capture full-screen and let the
  vision model find the Chrome window (simplest; screen is small enough).
- The tmux TUI itself needs no vision: `capture-pane -p` gives exact text,
  including the elicitation modal. Screenshots are for Chrome + "wizard really
  rendered on screen" proof — for the latter, keep the tmux client attached in
  a visible Terminal window during the run (`tmux attach -t inner` in a
  Terminal tab the harness opens), otherwise the TUI has no on-screen pixels.
- Independent double-check of Chrome content without driving it: the page
  state can also be asserted via `curl` against the local app under test and
  via backend POST payloads.

---

## 8. tmux monitoring pattern (outer loop)

Busy vs idle `[verified]`: while a turn runs, the pane shows a spinner line
like `✽ Fluttering… (14s · ↓ 420 tokens)` (and `esc to interrupt` on prompt
lines); when idle, the bottom shows an empty input `❯` with no spinner and a
closing line like `✻ Cogitated for 27s`.

Robust pattern — combine (a) sentinel markers you *ask* the inner model to
print, (b) pane grep, (c) timeout:

```bash
# ask the inner session to end each phase with a unique marker, e.g.:
#   "When the login tool returns, print exactly: PHASE1_LOGIN_DONE <status>"

watch_pane() {  # watch_pane <marker> <timeout_s>
  local marker="$1" timeout="$2" t=0
  while [ $t -lt "$timeout" ]; do
    if tmux capture-pane -t inner -p -S -200 | grep -q "$marker"; then
      echo "FOUND: $marker"; return 0
    fi
    # surface dialogs that need keys:
    tmux capture-pane -t inner -p | grep -E "requests your input|Do you want|Esc to cancel|trust this folder" && return 2
    sleep 3; t=$((t+3))
  done
  return 1
}
```

Notes:
- `capture-pane -p -S -200` includes 200 lines of scrollback — dialogs and
  results scroll fast; never grep only the visible pane for history.
- Poll every 2–5 s. Distinct return codes for "marker found" vs "dialog
  waiting" let the outer loop branch into send-keys handling.
- `tmux has-session -t inner` / checking the pane's last line for the shell
  prompt detects a crashed/exited claude.
- For the elicitation modal specifically, grep for
  `requests your input` and `I've approved the request in my browser`.
- The backend is the ground truth for "did it really happen": poll Mongo-backed
  endpoints (e.g. run status) or tail `/tmp/e2e_backend.log` for the POSTs.

Caution for the outer session in auto mode: the classifier explicitly blocks
"sending keystrokes to Claude Code's own tmux pane" (self-driving). Driving a
*different* session's pane is the intended pattern and was not blocked in any
probe, but keep the inner session in a dedicated tmux session (`-s inner`) so
targets are unambiguous.

---

## 9. End-to-end run skeleton (for later implementation)

```bash
# 0. Preconditions
#    - Screen Recording granted to Terminal (§7)  ← currently MISSING
#    - Chrome running, extension connected, localhost allowed in extension
#    - rm -f ~/.claude/plugins/data/archetype-inline/auth.json
# 1. Start backend (§3); curl /health until 200.
# 2. (only if the run needs Celery) uv run celery -A tasks worker &
# 3. Seed the backend with a test-run instruction set (endpoints TBD, §3 gap).
# 4. tmux new-session -d -s inner; launch inner claude with
#    ARCHETYPE_BACKEND_URL=http://localhost:5001 and --plugin-dir (§4.1);
#    accept trust dialog if shown.
# 5. tmux attach in a visible Terminal window if on-screen wizard proof needed.
# 6. Send '/archetype:validation'; watch for the elicitation modal (§8).
# 7. Complete Auth0 approval in Chrome (harness/outer decision: manual user
#    step, or inner-session Chrome automation after modal Accept — see risks),
#    then Space, Down, Enter in the modal (§4.4).
# 8. Watch for login success marker + auth.json recreated (mode 0600).
# 9. Inner session fetches instructions, drives Chrome, POSTs results.
#    Outer session: capture-pane loop + screencapture at key moments +
#    backend log/DB assertions.
# 10. Teardown: /exit inner, tmux kill-session -t inner, kill backend.
```

---

## 10. Risks / unknowns

1. **Screen Recording permission missing (hard blocker for vision).** Until
   Terminal is granted, every `screencapture` is wallpaper-only. Cannot be
   granted programmatically; user must click it once.
2. **Auth0 approval leg.** The device flow is real even against localhost
   (backend proxies the dev Auth0 tenant). Automating the approval page
   (login form, possibly credentials) via the inner session's Chrome tools
   collides with the modal being open — the TUI is blocked on the modal while
   the approval must happen in the browser. Options: (a) human-in-the-loop for
   that single click, (b) outer session drives just the Auth0 page via its own
   Chrome connection (both sessions verified connected, but simultaneous
   *driving* is untested), (c) pre-seed a valid token in auth.json and treat
   the wizard as a cancel-path test. Untested end-to-end.
3. **Two sessions actively driving Chrome at once** — connections coexist
   [verified], concurrent *actions* untested; tab-picker or race behavior
   unknown.
4. **Instruction-set / results endpoints don't exist yet** in the backend
   (`/api/feature-validation/runs` in the skill is fictional; real UAT routes
   differ). The E2E cannot be fully wired until these are built or the skill
   is repointed.
5. **`validate-token` on localhost still validates against real Auth0 JWKS**
   (it is not DEV_MODE-bypassed), so the cached-token path needs either a real
   token or a deleted auth.json. DEV_MODE=1 only bypasses `require_auth`
   endpoints.
6. **Auto mode variability.** The user's default is auto mode; the classifier
   approved the login MCP call this time, but classifier decisions are not
   guaranteed stable. For determinism start the inner session with
   `--permission-mode acceptEdits` plus `--allowedTools` for the login tool
   and Chrome tools, or `--dangerously-skip-permissions`.
7. **First-run dialogs.** A fresh scratch cwd triggers the trust dialog
   (handled, §4.2). `--dangerously-skip-permissions` triggers a one-time
   responsibility dialog if never accepted interactively before (state is in
   user settings; unknown whether already accepted on this machine).
8. **Timing.** MCP connect ≈ 0.3 s, but skill → ToolSearch → tool call took
   ~15–40 s with xhigh effort; keep per-phase timeouts ≥ 120 s.
9. Probe artifacts left behind: `/tmp/e2e_inner_probe/`, `/tmp/e2e_*.png`,
   `/tmp/e2e_inner_claude_debug.log`, `/tmp/e2e_backend_probe.log` —
   harmless, reusable.
