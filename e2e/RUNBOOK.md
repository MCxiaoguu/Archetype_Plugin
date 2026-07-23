# Archetype Plugin — Live E2E Runbook

The exact operator sequence for the real (non-smoke) end-to-end test: an outer
orchestrator session drives an inner Claude Code session (in tmux) that loads
the `archetype` plugin, completes the Auth0 device-flow login wizard, drives
Chrome (Claude-in-Chrome) on the demo product, and reports results to the local
backend. Every step maps inline to the acceptance criteria in
`docs/GOAL_AND_TEST_CRITERIA.md` (A1–A5, B1–B2, C).

Source of the verified recipes: `docs/E2E_HARNESS_NOTES.md`. Do not invent
alternatives to what it verified.

## Paths & names (fill `<sub>` / `<run_id>` at run time)

- `PL`  = `/Users/hanyanggu/Personal_Files/Coding/Archetype_all/Archetype_Plugins`
- `BE`  = `/Users/hanyanggu/Personal_Files/Coding/Archetype_all/Archetype_Core/Archetype_Backend`
- tmux session name: `archetype-e2e` (helpers in `e2e/tmux.sh`)
- Artifacts dir: `PL/e2e/artifacts/` (gitignored). **Create it first:**
  `mkdir -p /Users/hanyanggu/Personal_Files/Coding/Archetype_all/Archetype_Plugins/e2e/artifacts`
- `<sub>` = the Auth0 `sub` the wizard logs in as (the run's `user_id`).
  Get it from the backend log after login (the `/api/plugin/runs` request) or
  from the created test doc's `user_id`.
- `<run_id>` = the `runId` (`test_id`) printed in the inner session's `start_run`
  result / final report.

Load the helpers once in the orchestrator shell: `. PL/e2e/tmux.sh`

## Expected timings (plan-level, watch for these)

- Inner `start_run` (first for a fresh user) takes **60–90 s** — the backend
  generates the replay persona via Gemini. The MCP tool call timeout is **180 s**
  (`start_run` POSTs with `timeout=180`), so it should complete; if the inner
  Claude times out the tool call anyway, pre-warm the persona once from `BE`
  (`ensure_replay_persona`) before the run and note it here.
- MCP connect ≈ 0.3 s; skill → ToolSearch → first tool call can take 15–40 s.
  Keep every phase timeout ≥ 120 s.
- The Auth0 device flow is real even against localhost (backend proxies the dev
  tenant) — the browser approval leg is genuine.

---

## Step 1 — Start backend + demo app with tailable logs  → B1, B2

```bash
cd /Users/hanyanggu/Personal_Files/Coding/Archetype_all/Archetype_Core/Archetype_Backend \
  && nohup uv run python app.py > /tmp/e2e_backend.log 2>&1 &
echo $! > /tmp/e2e_backend.pid
sh /Users/hanyanggu/Personal_Files/Coding/Archetype_all/Archetype_Plugins/demo-app/serve.sh &
echo $! > /tmp/e2e_demo.pid
# Wait ~10–12 s (Atlas index init), then confirm health:
curl -s http://localhost:5001/health          # → {"status":"ok"}
curl -s http://localhost:8321/ | grep -q 'id="cta-trial"' && echo "demo up"
```

Monitor during the whole run (this is the **B2 "logs monitored" evidence**):

```bash
tail -f /tmp/e2e_backend.log | grep --line-buffered "/api/plugin"
```

At the end, capture excerpts for the record:

```bash
grep "/api/plugin" /tmp/e2e_backend.log > \
  /Users/hanyanggu/.../Archetype_Plugins/e2e/artifacts/backend_log_excerpt.txt
```

Do NOT `source .env` (unquoted `&` in the Mongo URI breaks zsh); `app.py` loads
it via dotenv. Redis/Celery are not needed for the actor flow. (Notes §3.)

## Step 2 — Preflight  → A3 (auth cleared), C (vision harness proven)

```bash
bash /Users/hanyanggu/.../Archetype_Plugins/e2e/preflight.sh
```

Must end `PREFLIGHT: all hard checks PASS`. It deletes stale
`~/.claude/plugins/data/archetype-*/auth.json` so the wizard renders
deterministically (**A3**). Then complete its MANUAL step:

> **Read `/tmp/e2e_sr_check.png`** and visually confirm the Calculator window is
> visible. File size is NOT authoritative — wallpaper-only captures are
> full-size. If only wallpaper + menu bar show, grant Screen Recording to
> Terminal and re-run. This proves the **C** vision harness works before the run.

## Step 3 — Start the tmux session and ATTACH it in a visible Terminal  → C

A detached tmux session has **no on-screen pixels**, so every `screencapture` of
the wizard/TUI depends on a visible attached client (notes §7).

```bash
e2e_start
# Open a visible Terminal window attached to the session (orchestrator-run):
osascript -e 'tell app "Terminal" to do script "tmux attach -t archetype-e2e"'
osascript -e 'tell app "Terminal" to activate'
```

(If `osascript` is not permitted, ask the user once to run
`tmux attach -t archetype-e2e` in a Terminal window.)

## Step 4 — Launch the inner Claude Code with the plugin  → A1

Fresh scratch cwd keeps project settings out and makes the trust dialog
deterministic; `--debug-file` keeps the TUI clean for `e2e_idle` and gives a
greppable MCP log. `ARCHETYPE_BACKEND_URL` points the plugin's MCP server at the
local backend (notes §2, §4.1).

```bash
e2e_send "mkdir -p /tmp/e2e_inner && cd /tmp/e2e_inner && ARCHETYPE_BACKEND_URL=http://localhost:5001 claude --plugin-dir /Users/hanyanggu/Personal_Files/Coding/Archetype_all/Archetype_Plugins --debug-file /tmp/e2e_inner_debug.log"
```

Sanity (optional): `grep archetype /tmp/e2e_inner_debug.log` →
`Loaded N skills from plugin archetype`,
`MCP server "plugin:archetype:archetype-setup": Successfully connected`,
`[archetype-setup] server starting; backend=http://localhost:5001`.

## Step 5 — Accept the folder-trust dialog if it appears  → A1

~10 s after launch a fresh cwd shows the trust dialog (option 1 pre-selected).

```bash
e2e_pane
if e2e_dialog | grep -q "trust this folder"; then e2e_keys Enter; fi
```

## Step 6 — Login wizard leg  → A2, A3

```bash
e2e_send "/archetype:validation"          # no args ⇒ login flow
```

Wait for the elicitation modal, then screenshot it (**A3 vision evidence**):

```bash
# poll until the modal is up:
until e2e_dialog | grep -q "requests your input"; do sleep 3; done
screencapture -x /Users/hanyanggu/.../Archetype_Plugins/e2e/artifacts/wizard.png
```

Extract the Auth0 verification URL from the pane and complete the approval:

```bash
e2e_pane | grep -Eo 'https://[^ ]*activate\?user_code=[A-Z0-9-]+'
```

- **Outer-session Chrome** navigates that URL and approves the device request.
  (Only touch Chrome from the outer session for THIS approval; the inner session
  drives Chrome for the actual test.) **Human fallback:** if outer-session Chrome
  automation is blocked, the operator/user approves the one page manually.
- The modal keys (focus starts on the checkbox — notes §4.4):

```bash
e2e_pane            # ALWAYS re-capture before sending keys (timing-sensitive)
e2e_keys Space Down Enter
```

Confirm success:

```bash
until e2e_pane | grep -q "Connected to Archetype"; do sleep 2; done
ls -l ~/.claude/plugins/data/archetype-*/auth.json     # exists, mode 0600 (-rw-------)
```

`--dangerously-skip-permissions` does NOT skip elicitation — the modal always
needs interactive keys (notes §4.4). Do not use `-p`/`dontAsk` (kills the wizard).

## Step 7 — Run the validation flow; capture Chrome  → A2, A4

```bash
e2e_send "/archetype:validation \"test the signup flow\" url=http://localhost:8321"
```

The inner session becomes the persona and drives Chrome on the demo app. While
the pane shows activity, capture Chrome periodically (**A4 evidence** — genuine
browser activity, not just tool logs). Bring Chrome frontmost first, because the
attached tmux Terminal (Step 3) may cover it:

```bash
open -a "Google Chrome"
n=0
while ! e2e_idle; do
  open -a "Google Chrome"
  screencapture -x "/Users/hanyanggu/.../Archetype_Plugins/e2e/artifacts/chrome_$(printf '%02d' $n).png"
  n=$((n+1)); sleep 20
done
```

When idle, save the final report pane text (**A5 payload cross-check input**):

```bash
e2e_pane > /Users/hanyanggu/.../Archetype_Plugins/e2e/artifacts/final_report.txt
```

Note the `runId` and `sessionId` from the report → `<run_id>` / `<sub>`.

## Step 8 — Verify backend state  → B1, B2, A5

```bash
cd /Users/hanyanggu/Personal_Files/Coding/Archetype_all/Archetype_Core/Archetype_Backend \
  && uv run python \
     /Users/hanyanggu/Personal_Files/Coding/Archetype_all/Archetype_Plugins/e2e/verify_backend.py \
     --user-id <sub> --run-id <run_id>
```

Must exit 0 with all `[1]..[5]` = PASS (`[INFO]` extraction is best-effort).
This proves the pipeline ran end to end (replay → persona → run → results
persisted) and that the plugin's feedback reached Mongo (**A5**).

## Step 9 — Vision-verdict subagent  → A3, A4, A5, C

Dispatch a vision subagent. **Inputs:** `e2e/artifacts/wizard.png`,
`e2e/artifacts/chrome_*.png`, `e2e/artifacts/final_report.txt`, and the criteria
text A3/A4/A5 from `docs/GOAL_AND_TEST_CRITERIA.md`. **Ask it to return** a
structured PASS/FAIL per criterion with an evidence quote for each:

- **A3** — `wizard.png` shows the elicitation modal ("Connect to Archetype",
  Auth0 activate URL, verification code, Accept/Decline) rendered correctly.
- **A4** — the `chrome_*.png` series shows Chrome genuinely on
  `http://localhost:8321` performing the signup-flow test (Lumina Notes header /
  form fields visible), not a blank/unrelated page.
- **A5** — `final_report.txt` findings/verdict match what the run actually did
  and match the persisted feedback (cross-check with Step 8 output).

## Step 10 — Teardown

```bash
e2e_stop
kill "$(cat /tmp/e2e_backend.pid)" 2>/dev/null
kill "$(cat /tmp/e2e_demo.pid)" 2>/dev/null
```

Artifacts are retained in `e2e/artifacts/` (gitignored). Between attempts, reset
backend state and re-run from Step 1:

```bash
cd /Users/hanyanggu/Personal_Files/Coding/Archetype_all/Archetype_Core/Archetype_Backend \
  && uv run python \
     /Users/hanyanggu/Personal_Files/Coding/Archetype_all/Archetype_Plugins/e2e/verify_backend.py \
     --user-id <sub> --cleanup
```

---

## Criteria coverage map

| Criterion | Where demonstrated |
|---|---|
| A1 inner session + `--plugin-dir` + local backend url | Steps 3–5 |
| A2 plugin actually used (`/archetype:validation`) | Steps 6–7 |
| A3 wizard renders (vision) | Steps 6, 9 (`wizard.png`) |
| A4 Chrome really driven (vision) | Steps 7, 9 (`chrome_*.png`) |
| A5 correct feedback sent back | Steps 7–9 (`final_report.txt` + verify + vision) |
| B1 full pipeline with dummy replay | Steps 1, 8 (`verify_backend.py`) |
| B2 every stage monitored; Mongo inspected | Steps 1 (log tail), 8 (checklist) |
| C outer monitors pane/logs/Mongo; vision agent verdict | Steps 3, 8, 9 |
