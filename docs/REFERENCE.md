# Archetype plugin — wiring reference

This plugin is the actor half of the Archetype pipeline: it lets a builder test their product as if
customers were sitting beside them. The backend supplies a persona, goal, and scenarios; the plugin's
skills and agent drive Claude-in-Chrome through the product as that persona and report structured
results back for persistence, plus a local report in the session. Personas are **pool-first**
(v0.4.0): a persona pool is a distribution spec, and each pool-targeted run spins off one fresh
tester from it — the spun-off member is the persona the actor becomes. All backend traffic flows
through one stdio MCP server (`core`, `scripts/core-server.py`); Claude never touches tokens or raw
HTTP.

Contents:

1. [Studies, protocol v2 and browsers (0.6.0)](#studies-protocol-v2-and-browsers-060)
2. [Commands and agents](#commands-and-agents)
3. [MCP tools (server: `core`)](#mcp-tools-server-core)
4. [Backend HTTP contract](#backend-http-contract)
5. [Configuration, data, and distribution](#configuration-data-and-distribution)

---

## Studies, protocol v2 and browsers (0.6.0)

0.6.0 adds behavioral studies on top of the single run actor. Everything
here works against a backend that speaks protocol v2 (studies API, run
claim, live steps); against an older backend the single run path behaves
exactly as in 0.5.1 (see [Old backends](#old-backends)).

### `/archetype:study`

Source: `skills/study/SKILL.md`. Intake is natural language, as in
`validation`: `"<goal>" url=<...> icp="<who>" success="<criterion>"
[feature=] [pool=] [archetypes=4..8] [repeats=confirm|explore|decide]
[mode=ofat_stress|ofat|factorial|half_fraction|composites] [parallel=N]
[watch=live] [browser=chrome] [unattended] [model=M] [factors=a,b,c] [questions="...;..."]`,
or `/archetype:study study=<id>` to resume a study (`get_study`: the stage
it reached and the next call). `unattended` asks nothing and confirms
nothing (the command line is the consent): it accepts a suggested check,
applies `factors=` or the backend's selection, dispatches the swarm runner
with `confirm: true` and waits with `study_status` `wait_seconds: 300`.
`max_runs=N` caps the actor runs (`dispatch_study` `max_runs`, the runner's
`--max-runs`): a next wave larger than what is left runs the archetypes whose
outcome disagreed with the baseline first, then frustration, then steps, and
the rest are reported as aborted with "not run: the run budget of N was
spent". The runner also aborts, with the reason, a run whose worker exited
or timed out without reporting and one whose worker logged no step for
`--stall-min` (20) minutes after the claim. A
missing ICP or success criterion is asked once, with suggestions from the
feature target or the pool.

| Step | Tool | Backend | What the user sees |
| :-- | :-- | :-- | :-- |
| 1 | `create_study` | `POST /api/studies` | the normalized study as a table; a suggested success check to confirm |
| 2 | `generate_factors`, `update_factors` | `POST`, `PATCH /api/studies/<id>/factors` | factors with why they matter here, risk pole and typical level; "use these, or edit?" |
| 3 | `generate_archetypes` | `POST /api/studies/<id>/archetypes` | name, role, varied factor and pole, story, patience budget, trust gates |
| 4 | `create_study_runs` | `POST /api/studies/<id>/runs` | wave 1 matrix in dispatch order, time and token estimate, likely wave 2 size |
| 5 | actors, or `dispatch_study` | `POST /api/plugin/runs/<id>/claim`, `/steps`, `/results` | a progress table |
| 6 | `next_study_wave` | `POST /api/studies/<id>/runs/next` | wave 2 (confirmation runs, with why each archetype runs again) or done |
| 7 | `get_study_report` | `GET /api/studies/<id>/report` | the terminal report and the portal link |

Defaults (addendum D1 and D2): design `ofat_stress` (baseline, one variant
per factor at its risk pole, one stress archetype with every factor at
risk), repeats `confirm` (baseline 3 runs, others 1, then 2 more for any
archetype that disagrees with the baseline, at most 2 waves). The backend
owns the waves; the plugin only asks for the next one when every run of the
current wave has reported.

### Execution modes

| Mode | When | Browser | Parallel | Actor |
| :-- | :-- | :-- | :-- | :-- |
| Headless, in session (default) | every study | `archetype-browser-1` to `-4`, headless, isolated | up to 4 background subagents | `feature-validator-headless` |
| Watch live | `watch=live` | `archetype-watch-1` and `-2`, headed, isolated | up to 2 | `feature-validator-headless` |
| Swarm, unattended | `unattended`, CI | `archetype-browser-<k>` inside each worker session | `parallel` workers (default 2, at most 4) | `claude -p` running `/archetype:validation --run <id>` |
| Chrome | `browser=chrome` only | the user's real Chrome profile | 1, the whole study | `feature-validator` |

Claude in Chrome stays the default only for ad hoc `/archetype:validation`
runs, with a one line warning that it uses the real profile. A study never
mixes browsers: every run records its browser config and the report
aggregates only runs whose config matches the study's first scored run
(the others are listed as excluded with the reason).

### Run claim

`start_run(run_id=..., browser=...)` claims a run the study created:
`POST /api/plugin/runs/<run_id>/claim` with `{browser: {engine, version,
headless, user_agent, viewport, profile, server}}` (unknown values are left
out, not sent as null). The answer is the same
briefing as an ad hoc run. A 409 (`already_claimed`) means another actor owns
the run or it already ran: the tool tells the actor not to act on or report it. A 404
other than `run_not_found` means the backend has no claim route (it
predates studies). The actor never retries a claim.

`browser` is a name, not a config: `archetype-browser-N`,
`archetype-watch-N`, `chrome` or `playwright`. The server turns it into the
config (`BROWSER_PROFILES` and `browser/pinned.json`), so actors never deal
with user agents or versions.

### The briefing in protocol v2

`_render_run` adds, when the backend sends them:

- **HOW YOU BEHAVE**: `instructions.behavior.rules`, one per line, then the
  patience budget in words (`at most N steps in a row that get you
  nowhere, and M steps in all`) and the statement that the rules override
  the scenario steps. With no behavior block (an older backend), the
  persona's `traits` are put into words by `_traits_to_phrases` ("high
  impatience, moderate skepticism"); traits were never shown before.
- **WHO YOU ARE TODAY**: for a study run, the archetype's `whatIsDifferent`,
  `seedBeliefs` and `factorStatements` from `instructions.archetype`. Its
  name, role and varied factors are deliberately not shown: an actor told
  it is "the impatient variant" plays a caricature.
- **Done when**: the success criterion and each check in words, under the
  scenarios header. A claimed run's `instructions.preconditions` are
  rendered under "You arrive with:".
- **PROTOCOL 2**: call `log_step` after every browser action; the report
  contract adds `abandoned` and `feedback.outcome`.

Both spellings are read for every new key (`patience_budget` and
`patienceBudget`, `protocol_version` and `protocolVersion`), because the
contract names the behavior block in snake_case while the REST edge is
camelCase.

### `log_step`

Input: `run_id`, optional `session_id`, and `step`, the record of plan 5.3:
`seq`, `scenario_id?`, `observe {page_type, summary, stood_out,
visible_text_excerpt, url, title}`, `recall {applied}`, `decide {monologue,
intent, action_text, confidence, rule_applied?}`, `act {target?, result
ok|failed|no_change, error_message?}`, `after {friction {level, type?,
note?}, sentiment, progress, hesitation, trust_request?, remember?}`,
`screenshot_path?`.

What the server does:

1. Stamps `client_ts` (ISO, UTC, milliseconds) and `elapsed_s` (since
   `start_run` returned), fills a missing `seq`, and turns a
   `screenshot_path` into `screenshot_b64` (images only, 1 MB, 6 per run).
   Then checks the record the way the backend's `normalize_step` does
   (closed lists and ranges): a record it would refuse is an error here,
   before anything is sent or buffered.
2. Sends any steps still buffered for this run, oldest first, then this
   one, to `POST /api/plugin/runs/<run_id>/steps` with body
   `{session_id, step}` (snake_case, as plan 5.3). The whole call, flush
   included, finishes inside `ARCHETYPE_STEP_TIMEOUT` (15 s).
3. Timeout, network error, 5xx, a missing route, a refused login (401) or
   no token: the step is appended to `runs/<run_id>.steps.jsonl` and goes
   out with the next step or with `report_result`. The actor is told why
   (a refused login goes out once the user logs in again) and keeps going;
   a step that cannot even be saved locally is an error. A 400 (or 404
   `run_not_found`) is the actor's to fix: returned as an error, nothing
   kept. A 409 `run_ended` means the persona's patience ran out: the NOTE
   says the run has ended and to report it abandoned. Any other 409 means
   the run is already closed (reported, or aborted by the swarm runner):
   an error telling the actor to stop and not report. A buffered step the
   backend later refuses, or takes no more, is named in the answer.
4. Answers with the backend's `state`, `activeRules`, `recall` and `note`,
   or, when the backend did not answer in time, with local state computed
   from the same rules (unproductive grows on a failed action, major or
   blocked friction, a reported progress that did not rise (a step without
   progress is no signal) or a refused trust request, and resets
   when progress rises by 10 or more; the review fires on the budget, the
   step cap or a repeated error and halves the counter; a second exhausted
   budget ends the run). The local counters follow the backend's whenever
   it answered, its reviews included.

The answer is a fenced STATE line plus at most 120 words:

```
STATE step 7 of max 22 | unproductive 2 of 5 | progress 40 | sentiment trend: falling
```
```
ACTIVE RULES:
- ...
RECALL:
- I once abandoned a signup that asked for my phone first (seed belief)
NOTE: Your patience budget is exhausted: decide now. Continue only if the last step made real progress toward "<criterion>"; otherwise call report_result with status "abandoned" and a quit_reason.
```

Rules and recall are clipped and dropped (recall first) until the text fits.

### `report_result` in protocol v2

Before posting, the server flushes the step buffer. Steps the backend never
acknowledged ride along in `steps` as the v2 records they are, which the
backend's success checks and metrics read (`observe`, `after`, `client_ts`).
On a protocol 1 backend, steps logged with `log_step` go in the v1 shape
(`actionText`, `narration`, `url`, `observationPageType`, `success`) with
the full record under `protocolV2`. The body adds:

- `status: "abandoned"` (on an older backend it becomes `failed`, with the
  outcome kept in feedback; without local state for the run it is sent as
  given),
- `feedback.outcome {completed, in_their_words, quit_reason?,
  abandoned_at_step?}` with the backend's quit reasons (`price_barrier`,
  `trust_refused`, `confusion`, `feature_not_found`, `goal_completed`,
  `frustration`, `technical_error`, `distraction`, `other`; `trust_refused`
  when the person leaves out of distrust, such as a broken promise, an
  unexplained card request or a data request they are not comfortable with,
  `price_barrier` only for the price itself); quit fields are dropped from
  a completed outcome,
- `rawActions`: `runs/<run_id>.actions.jsonl` (at most 1000),
- `browser`: the config of the browser the recorded actions drove, else the
  one named at claim,
- `artifacts.video_path`: the largest `.webm` in
  `${CLAUDE_PLUGIN_DATA}/browser/<server>/videos/` written since the run
  started (the actor closes the browser first, which writes the file),
- `durationSeconds` from the start time when the actor gives none.

After a stored report the run's local files are removed.

### Raw actions (`scripts/action-hook.py`)

`PostToolUse` and `PostToolUseFailure` hooks on
`mcp__playwright__.*`, `mcp__claude-in-chrome__.*` and
`mcp__plugin_archetype_archetype-(browser|watch)-[0-9]+__.*` (async), plus
a synchronous one on `mcp__plugin_archetype_core__(start_run|report_result)`.
MCP tool calls carry no agent id but hook input does, so the hook learns
which run an agent is on from `start_run`'s answer (`runId: ...`) and keeps
it in `runs/active-<agent_id>.json` (`main-<session_id>` outside
subagents); `report_result` clears it. Each browser call is appended to
`runs/<run_id>.actions.jsonl` as `{ts, agent_id, tool_name, tool_input,
result_ok, error, tool_use_id, duration_ms}`. Typed text, values, uploads
and passwords are replaced by their length; code is cut to 120 characters.
Calls before the claim (the preflight) are not filed. The hook always
exits 0.

### Browsers (`.mcp.json`, `scripts/browser-server.py`)

Six plugin servers: `archetype-browser-1` to `-4` (headless) and
`archetype-watch-1`, `-2` (headed). Each runs the real server as

```
npx -y @playwright/mcp@0.0.84 [--headless] --isolated --no-webmcp \
  --viewport-size 1280x900 --user-agent "<pinned desktop Chrome UA>" \
  --config ${CLAUDE_PLUGIN_DATA}/browser/<server>/config.json \
  --output-dir ${CLAUDE_PLUGIN_DATA}/browser/<server>
```

- The pinned values live in `browser/pinned.json` (package, Playwright
  version, user agent `Mozilla/5.0 (Windows NT 10.0; Win64; x64)
  AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36`,
  viewport, idle stop). Every flag was checked against `npx -y
  @playwright/mcp@0.0.84 --help`; `--save-video` no longer exists.
- Video: `browser/playwright.config.json` sets
  `browser.contextOptions.recordVideo` (Playwright's `BrowserContextOptions`,
  passed through by the MCP server). Its `dir` must be absolute: a relative
  one resolves against the session's working directory (the user's
  project), and without one Playwright keeps videos in a temporary folder
  it deletes. The proxy writes a per server config with
  `dir: ${CLAUDE_PLUGIN_DATA}/browser/<server>/videos`.
- The browser (`scripts/browser_engine.py`, checked at every launch):
  the installed Google Chrome (`--browser chrome`), else the newest
  Playwright Chromium in the ms-playwright cache (`--browser chromium
  --executable-path <binary>`), else the tool call fails with "install one
  with `npx playwright install chromium`". `ARCHETYPE_CHROME_PATHS` and
  `PLAYWRIGHT_BROWSERS_PATH` override the locations. The run's browser
  config version says `chrome channel` or `bundled chromium <revision>`.
- `--no-webmcp`: a site under test cannot register tools for the actor.
- Lazy start: Claude Code starts every plugin server with the session, and
  six idle Playwright servers measured about 548 MB (npm exec about 53 MB
  plus node about 40 MB each; about 208 MB each when run alone). The proxy
  answers `server/discover` and other non tool requests with `-32601`, the
  handshake and `tools/list` from `browser/tools.json` (the pinned tool
  list, refreshed with `browser-server.py <name> --capture-tools`), and
  starts the real server on the first `tools/call`. Measured idle cost in a
  live session: six proxies, 51.1 MB in total, no Playwright process. After
  15 idle minutes the real server is stopped again (which also writes any
  open video).

Tools allowlisted for `feature-validator-headless`:
`mcp__plugin_archetype_<server>__*` for the six servers, with
`browser_run_code_unsafe`, `browser_evaluate`, `browser_file_upload`,
`browser_network_requests`, `browser_network_request` and `browser_drop`
in `disallowedTools` (the persona sees the page, not its internals). The
old `mcp__playwright__*` list stays for self-registered servers.

### Permissions (`scripts/permission-hook.py`)

A plugin's `settings.json` takes effect only for `agent` and
`subagentStatusLine`, so permission rules cannot ship with the plugin, and
background subagents surface every prompt in the main session. A
`PreToolUse` hook on `mcp__plugin_archetype_.*` answers `allow` only when
the caller's `agent_type` is `feature-validator` or
`feature-validator-headless` and the tool is a plugin browser tool (minus
the six above) or one of `start_run`, `log_step`, `report_result`,
`get_run`, `list_features`. Anything else gets no answer and goes through
the normal flow; the user's deny and ask rules still win. Verified live in
a print mode session without permission bypass: the actor's three browser
calls ran with no denial, while the same call from the main session was
denied.

### Figma prototypes (`browser/figma-proto-init.js`)

Every browser server loads `browser/figma-proto-init.js` with
`--init-script`. It does nothing outside `figma.com/proto` and
`figma.com/deck`. On a prototype it turns on the viewer's own screen reader
mode (the `enable.screenreader` setting behind Options, Advanced settings,
Accessibility settings), which renders each screen's text and every hotspot
as real page elements, and lifts those elements above the canvas that
otherwise swallows clicks. The actor then reads a prototype from its
snapshot and taps hotspots with an ordinary `browser_click`, and each tap
runs the prototype interaction. The viewer rewrites the URL's `node-id`
(dash form, `71-616`) on every screen change, so the goal screen is a
`url_matches` check such as `*node-id=71-616&*`. The actor procedure's
"Prototype targets" section covers the rest: only hotspots respond, layer
names are labels, dead hotspots and dead ends are findings, and the
viewer's own controls are off limits.

Measured on 2026-11-03: a Claude actor finished a third party 12 screen
prototype (from its welcome screen to the end of its tutorial) in 103
seconds and reported a real wiring defect on the way.

### Swarm runner (`scripts/study_runner.py`, `dispatch_study`)

`dispatch_study {study_id, parallel?, model?, timeout_minutes?, confirm?}`
reads the study's queued runs (`GET /api/studies/<id>/runs`, whose runs
carry their live status; the study object's own run refs do not), else the
last wave seen locally, shows the count and an estimate (8 to 15 minutes and 30k to
200k actor tokens per run), and starts the runner only with `confirm:
true`. The runner:

- copies the plugin into `studies/<id>/plugin` with every server and hook
  command wrapped in `env CLAUDE_PLUGIN_DATA=<real data dir>` (a
  `--plugin-dir` load would otherwise get its own data folder without the
  login),
- starts one worker per run, up to `parallel`: `claude -p
  "/archetype:validation --run <run_id> browser=archetype-browser-<k>
  (headless, unattended)" --plugin-dir <shadow>
  --dangerously-skip-permissions --output-format stream-json --verbose
  --no-chrome --no-session-persistence [--model M]`, with `CLAUDECODE`,
  `CLAUDE_CODE_*` and the plugin path variables removed from its
  environment; worker k drives `archetype-browser-k`,
- writes `studies/<id>/<run_id>/stream.jsonl` and `stderr.log` per worker
  and `studies/<id>/runner.json` (read by `study_status`),
- asks for the next wave when the queue is empty, until the backend says
  done; a `stop` file in the study folder stops new workers.

**Watch mode** serves studies that another client started and asked to be
run remotely (`execution: "remote"`), such as the Figma plugin:

```
python3 scripts/study_runner.py --watch --data-dir ${CLAUDE_PLUGIN_DATA} \
  --backend https://api.syntheticarchetype.com [--parallel 2] [--once] [--poll-sec 20]
```

It polls `GET /api/studies?execution=remote&status=running`, runs every
queued run of each study (oldest first) with the same workers, waves,
orphan handling and budget as above, then polls again. Runs that are
already claimed or finished are left alone, so two watchers never act on
one run (the claim is atomic on the backend). `--once` makes one pass for
cron or CI; a `stop` file in `${CLAUDE_PLUGIN_DATA}/studies/` stops it
between studies. It uses the login in `auth.json`, so it serves that
account's studies.

`docs/examples/study-ci.yml` is a documented GitHub Actions job (not
enabled here) that runs a study against a preview URL and comments the
summary on the pull request.

### Old backends

A briefing without `instructions.protocol_version` is protocol 1: no HOW
YOU BEHAVE rules (traits as words instead), the 0.5.1 report contract, and
the line "PROTOCOL 1: ... do not call log_step". If an actor calls
`log_step` anyway, steps are kept locally and sent with `report_result` in
the v1 shape when the actor sends none. `abandoned` becomes `failed`.
`rawActions`, `browser` and `artifacts` are not sent. Study tools on a
backend without the studies API say it predates behavioral studies.

---

## Commands and agents

All commands are skills under `skills/<name>/SKILL.md`; every backend call goes through the `core`
MCP server (`python3 ${CLAUDE_PLUGIN_ROOT}/scripts/core-server.py`, stdio), whose tools surface as
`mcp__plugin_archetype_core__<tool>` and may be deferred (loaded via ToolSearch before use). Auth is
self-healing across all authed tools (see [Self-healing auth](#self-healing-auth-authed_call)), so
skills are told to *never* pre-call `login`; a "Not connected" error only comes back if the user
declined the login.

### /archetype:setup — onboarding

Source: `skills/setup/SKILL.md`. The canonical onboarding command. Flow:

1. Call the `login` tool with an empty arguments object. That single call encapsulates the entire
   connection flow: cached-token check, device-code request, browser launch, elicitation modal,
   polling, and the on-disk token save. (Loads `login` and `status` in one ToolSearch query:
   `select:mcp__plugin_archetype_core__login,mcp__plugin_archetype_core__status`.)
2. On success (newly connected or "already connected as X"), call the `status` tool and render the
   dashboard — account, backend, features, recent runs, portal link, **no raw ids**.
3. Close with one-line first steps: `/archetype:persona`, `/archetype:validation "<goal>" url=<...>`,
   `/archetype:status`.
4. On cancellation/timeout/error: surface the tool's message verbatim and ask whether to retry.

Boundaries: never ask the user to paste codes or tokens in chat; the elicitation modal + browser
approval is the only authorized path, and the device flow must not be shortcut or simulated.

### /archetype:validation — the core actor loop

Source: `skills/validation/SKILL.md`. Branches on `$ARGUMENTS`:

- **Empty** → runs the **login wizard** and stops (kept so a bare `/archetype:validation` still
  connects; `/archetype:setup` is the canonical onboarding).
- **Non-empty** → runs the **validation run flow**.

**Intake (step 1).** `$ARGUMENTS` is natural language, not a token grammar — the model is the parser
("parse like one intelligent reader, not a regex"). The output of intake is a **list of run
objects**, each `{ "goal": "...", "url": "...", "pool": "<intent or null>", "feature": "<name or null>", "preconditions": [...] }`:

| field | semantics |
| :-- | :-- |
| `goal` | what to test — the free text minus everything else captured |
| `url` | a `url=<...>` token or any URL in the text |
| `pool` | ANY tester/persona intent: `pool=<...>` token, a pool's name ("as Veda", "with Marcus"), or a description ("as cautious non-technical first-timers") |
| `feature` | a named saved feature (prefer `validate-feature` when feature-first) |
| `preconditions` | context the tester BEARS on arrival, split from the goal: provisioned accounts/credentials ("staging login: X/Y"), "your own X" phrasing, prior knowledge/state. Canonical example: "test Relay with your own suite of endpoints" → goal = evaluating Relay; precondition = the tester owns endpoints (which they know, even unnamed). Passed to `start_run` verbatim as a list; the persona invents implied specifics in character, never asks, never skips. Comparison runs share preconditions unless per-pool ones are given. |

**Multi-run fan-out.** One command can mean several runs. Comparison/fan-out phrasing produces one
object per combination the user actually means: "as Veda and as Marcus" / "compare Veda vs Marcus" →
2 runs sharing goal+url; "with each of my pools" (or "personas") → resolve via `list_pools`, one run
per pool (confirm the count first); two URLs ("on staging and on prod") → one run per URL.
Unmentioned fields are SHARED (one url + two pools → both objects carry that url); dimensions the
user didn't ask to cross are never multiplied. A single-intent command is simply a list of one.

**Pool resolution** (for every distinct tester intent; `list_pools` is called once and reused):
match the intent — name or description — against real pools, **case-insensitively on the pool's
name** with the archetype name (the `archetype:` line in the tool output, from
`metadata.primary_archetype_name`) as fallback, or best description fit; propose the match
conversationally before using it ("I found **<name>** (<one-line description>) — … Test with a
member of that pool, or create a new pool?"); **several pools matching the same name → list the
candidates (name · description · created) and ask — never guess.** **None plausible → create from
blank, right there**: one confirmation, then `create_pool` directly with the user's description as
`vibe_prompt` (plus whatever controls their words imply and a short `name`), skipping previews
unless asked — never dead-end the user into a separate command (`/archetype:persona` is only for
the full guided flow). Only a pool the user confirmed becomes `pool_id`; tester intent is never
silently dropped into the goal text, and candidates are never guessed between.

**Feature resolution**: a named feature that doesn't exist gets the same treatment — offer to create
it on the spot (`create_feature` with a title + one-line description distilled from the user's
words; ask only for what can't be inferred), then run with the new `feature_id`.

**Confirmation rules**: present the run list as a table (goal · url · pool · feature). A single
run with every field explicit and unambiguous → proceed straight away, stating the row. Anything
missing (a URL is required — never guessed), inferred, or fuzzy-matched → one compact question about
exactly those fields. **Multiple runs → always confirm the list once** before starting (each run
costs real minutes). When a run targets a pool, warn at kickoff that spinning off a fresh tester
adds up to ~a minute before the browser session starts.

**Multi-run execution (step 2a).** Ensure the session is connected FIRST (intake's `list_pools`
self-heals auth in the main session; subagents cannot render the login modal). Then dispatch the
`feature-validator` agent once per run object with its resolved fields verbatim (goal, url,
`feature_id`, `pool_id` + the pool's display name for sanity-checking, `preconditions`), run
**sequentially** — the agents share one Chrome, parallel dispatch makes them fight over the browser. If a run returns the
"backend did not honor the pool" error (see [Pool guard](#pool-guard-in-start_run)), stop
remaining pool-selected runs and surface it once. Afterwards render a **comparison report**, not
N stacked reports: header row per run (tester + the pool they were spun from · verdict · run id),
scenario outcomes side by side, findings split into "hit by all testers" vs "only <name> hit this",
each tester's reaction quote, and a `/archetype:check-run-status <run_id>` line per run.

**Single-run execution (steps 2–7).** Call `start_run` with `goal` (omit if running purely by
`feature_id`), `url` (required), optional `feature_id`, optional `pool_id`, optional
`preconditions` (verbatim list; rendered back in the briefing under `You arrive with:`, which the
agent embodies, implied specifics invented in character, never asked, never skipped). The tool guards
pool selection: if the backend does not honor the requested pool, it returns an error instead
of a briefing — relay and stop. The result text is authoritative (mission brief, the "running as
<member>, spun from pool <name>" line for pool runs, first-person
persona card, numbered scenarios with steps + expected result, conduct rules, `runId`/`sessionId`,
the full `report_result` contract — see
[`report_result` payload contract](#report_result-payload-contract-in-full)). Then: become the
persona (narrate in first person at their patience/skill/reading level); load Claude-in-Chrome tools
via ToolSearch, call `tabs_context_mcp` first, create a **new** tab, navigate; execute scenarios in
order, ~3-minute time-box each, marking blocked scenarios `blocked`; keep a snake_case step log
(`seq`, `scenario_id`, `action_text`, `narration`, `url`, `observation_page_type`, `success`,
optional `error`, optional `screenshot_b64` — ≤6 total, ≤1 MB each). If the browser fails wholesale,
mark all scenarios `blocked` and call `report_result` with status `"failed"` plus a finding — never
abandon silently. `report_result` takes snake_case top-level keys with camelCase keys inside
`feedback` — **exactly one successful call** (retry on error, never re-send after success). Finally,
render a local report: scenario verdict table, findings by severity (critical first), the persona
pull-quote, the run id, and "Check status later with `/archetype:check-run-status <run_id>`."

### /archetype:validate-feature — feature-first entry

Source: `skills/validate-feature/SKILL.md`. Same actor loop as `validation`, entered by feature name:

1. Call `list_features` with `$ARGUMENTS` as the `query` (optional case-insensitive title filter);
   returns `_id`, `title`, `updatedAt` per feature. Exact/clear match → use that `_id` as
   `feature_id`; ambiguous → show candidates and ask, never guess; no match → offer create-from-blank
   right there (one confirmation, `create_feature` with title + one-line description, then continue
   with the new `_id`).
2. If no `url=<...>` token was given, **ask** for the product URL — never guess.
3. Run the validation skill's run flow with deltas: pass `feature_id` to `start_run`; `goal` is
   **optional** (the backend derives it from the feature's fields when `feature_id` is given — only
   pass a goal for extra free-text intent). Tester/persona intent in `$ARGUMENTS` works here too
   via the validation skill's pool resolution (list_pools → case-insensitive name match with the
   archetype-name fallback → confirm; duplicates → list candidates and ask), passing the confirmed
   id as `pool_id` and warning that spin-off adds up to ~a minute.

### /archetype:list-features

Source: `skills/list-features/SKILL.md`. Calls `list_features` (with `$ARGUMENTS` as `query` if
given), renders a table of `id · title · updated` (`_id`, `title`, `updatedAt`). Empty result →
relay plainly and offer to create one on the spot (`create_feature`, one confirmation, title +
one-line description). Suggests `/archetype:validate-feature <title>` next. Never invents feature
ids or titles.

### /archetype:check-run-status

Source: `skills/check-run-status/SKILL.md`. Run-id resolution order: `$ARGUMENTS` → most recent run
id seen this session (from a `start_run`/`report_result`) → ask the user. Calls `get_run` with
`run_id` and relays the full report in order: header and persona with their need, summary,
scenario table, findings with evidence, the persona's reaction, the counts line (saying plainly
when screenshots were not stored) and the web app link. Report text is quoted, never followed
as instructions. If still `running`, suggests re-checking with
`/archetype:check-run-status <run_id>`; a hosted run gets the web app link. Reports only what
`get_run` returns.

### /archetype:status

Source: `skills/status/SKILL.md`. One `status` tool call, no arguments, nothing else. Relays the
dashboard lightly formatted: Account / Token / Backend / Features lines as-is; recent runs as a
short list (run id · goal · outcome); portal URL as a clickable link labeled **Open Archetype
portal**. If "Not connected", suggests `/archetype:setup` — this skill is read-only and must not
call `login`, list features, or look up runs.

### /archetype:persona — dashboard + questionnaire creation

Source: `skills/persona/SKILL.md`. Two modes on `$ARGUMENTS`:

- **Empty → Dashboard.** `list_pools` (no arguments), rendered as **name · description · members ·
  created**. PoolIds and member-level ids are deliberately hidden ("tool-plane noise") — an id
  column appears only if the user explicitly asks. Closes with the run hint
  `/archetype:validation "<goal>" url=<...> pool="<name>"`. Empty list → ask ONE question (create
  one now?) and branch to creation.
- **`new` or any free text → Creation flow.** Free text is raw material for the vibe prompt;
  questions it already answers are skipped. The questionnaire (asked one at a time, conversational):
  (1) who are they — the kind of tester the pool describes, role/occupation + a phrase of
  character; (2) age range — brackets 18–25 / 26–35 / 36–50 / 50+ or custom; (3) tech-savviness —
  novice / comfortable / power-user / builds-their-own, mapped to `skills_range` roughly [10,35] /
  [35,65] / [65,85] / [80,100]; (4) what they care about / what annoys them; (5) product context —
  one line, pre-proposed if the session already knows the target. Then compose a plain-English 2–3
  sentence `vibe_prompt` (no key:value dumps) and call `create_pool` with `preview_only: true`,
  `preview_count: 2`, plus the mapped `age_range`, `skills_range`, `occupation`,
  `product_description`. Present both candidates side by side (name, vibe, story, need) as
  **directions for the pool's distribution** — the candidates themselves are not saved; the pool
  stores the spec and generates fresh testers along the chosen direction at validation time. On
  choice, call `create_pool` WITHOUT `preview_only`, same controls, vibe_prompt extended by the
  chosen candidate's summary ("... similar in spirit to: <vibeSummary>") and `name` set to a short
  display name (the chosen candidate's name or the user's own phrase, confirmed in the same breath
  as the direction). Relay the saved pool (name, description — no raw id) and say plainly that it
  starts EMPTY — members are spun off at validation time, one fresh tester per run. If the tool
  reports the pool was saved but the rename failed (auto-generated `Pool_<hex>` name), relay that
  verbatim — the pool is fully usable.
- **Low-resistance shortcut.** A rich description (or "just make it") → offer to skip the remaining
  questions AND the preview round: one confirmation, then save directly. The full flow is guidance,
  never a gate.

Boundaries: only show pools/ids the tools returned; **one SAVE per flow** (`create_pool`
without `preview_only` at most once, after user confirmation — previews are free to repeat); warn
the user that pool creation is LLM-backed and can take up to a couple of minutes per call.

### feature-validator agent

Source: `agents/feature-validator.md`. The delegated/headless actor: one full validation cycle —
start run, become persona, drive Chrome, report — in a single invocation. Static tools: `Bash, Read,
Grep, Glob, ToolSearch, mcp__plugin_archetype_core__start_run,
mcp__plugin_archetype_core__report_result, mcp__plugin_archetype_core__get_run,
mcp__plugin_archetype_core__list_features`. Claude-in-Chrome tools are loaded at runtime via
ToolSearch (query `claude-in-chrome`).

**Dispatch contract.** The prompt should carry: the product URL (required — the agent asks rather
than guesses), a `goal` and/or `feature_id` (a named saved feature is resolved via `list_features`;
ambiguous → ask once, never guess an id), and optionally a **pre-resolved** `pool_id` plus the
pool's display name — the agent carries it as-is and never invents or substitutes one (the backend
spins off one fresh tester from the pool, which can add up to ~a minute). If `start_run` reports
the backend did not honor the requested pool, the agent surfaces the error verbatim and stops.
The URL is used exactly as given, query string included, and the agent treats its parameters as
opaque routing data. The actor can still read them, so run labels in the URL must not describe the
test (use `?twin_label=r7f3`, not `?twin_label=chaos-trickle-start`); the validation skill flags
descriptive values when it confirms the run list.

**Why login can't happen inside it.** The `login` tool is deliberately absent from its tool list:
the login elicitation modal cannot render inside a subagent, so authentication must happen in the
main session before dispatch. On a "Not connected" error the agent tells the user to run
`/archetype:setup` in the main session and stops — it never fabricates a run.

**One-run boundary.** One run per invocation; runs come only from `start_run`, results only through
`report_result` with exactly one SUCCESSFUL call (retry on error, never re-send after success).
`start_run` is never called twice: after a deadline or timeout the agent reports that no run was
created and stops, and any retry is the user's decision in the main session. It
follows the same operating procedure as the validation skill (persona adoption, new-tab browsing,
~3-minute scenario time-boxes, snake_case step log, camelCase `feedback` keys, blocked-scenario
handling for whole-run browser failure) and ends with a scenario verdict table, findings by
severity, persona quote, and run id, noting status can be re-checked via `get_run` /
`/archetype:check-run-status <run_id>`.

**Browser first, run second.** Step 2 of the procedure proves the browser works (`tabs_context_mcp`)
before `start_run` is called, because `start_run` creates a run and spins a tester into the pool.
With no browser the agent stops without creating anything.

**Do it once.** A purchase, booking or submission that went through is never repeated to double
check it; the agent verifies from the confirmation page, the account area or the inbox. It is
repeated only when a scenario explicitly asks for a second pass.

**Fresh snapshot after a stale or ambiguous target.** On "Ref not found" or a "strict mode
violation", the agent takes a new accessibility snapshot before any other action and picks targets
by role plus accessible name rather than raw text. It never reports a control as broken on the
strength of a click that hit a stale ref. (A 2026-09-24 stress run reported a working Cart link as
dead after the cart count re-rendered.)

### `feature-validator-headless`

Source: `agents/feature-validator-headless.md`. The same actor loop on an isolated Playwright
browser. It is the actor for every study run, on the plugin browser its dispatch prompt names
(`archetype-browser-1` to `-4`, or `archetype-watch-1` and `-2` for `watch=live`), and for ad hoc
runs when Claude in Chrome is not available (locked screen, SSH, CI, no extension). See
[Browsers](#browsers-mcpjson-scriptsbrowser-serverpy) for the servers and its allowlist. A Playwright
server the user registered as `playwright` still works (`mcp__playwright__browser_*`). The two agent
files may differ only in the browser preflight and in how the site is opened;
`python3 scripts/test_agents_in_sync.py` (in CI) fails on any other drift, and also checks that both
carry `log_step`, `maxTurns: 120` and the per-step protocol, and that the headless actor allowlists
all six plugin browsers without the code running tools.

### SessionStart hook

Source: `hooks/hooks.json`. A single `SessionStart` hook with matcher `startup`, type `command`:

```
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/session-hook.py"
```

At session startup it reads `${CLAUDE_PLUGIN_DATA}/auth.json` locally (no network) and prints one
line only when the session cannot run Archetype commands as it stands:

| state | line |
| :--- | :--- |
| no `auth.json`, or no `access_token` in it | `archetype: not connected. Run /archetype:setup to get started.` |
| unparseable `auth.json` | `archetype: saved login is unreadable. ...` |
| `saved_at + expires_in` is in the past | `archetype: your login has expired. ...` |
| less than an hour of lifetime left | `archetype: your login expires in about N minute(s). ...` |
| valid | *(nothing)* |

The expiry lines matter because the login modal cannot render inside the `feature-validator`
subagent: a token that lapses mid-run would otherwise surface only when `report_result` fails.
The hook always exits `0`. Tests: `python3 scripts/test_session_hook.py`.

---

## MCP tools (server: `core`)

The server is a stdlib-only Python stdio MCP server at `scripts/core-server.py`, registered in
`.claude-plugin/plugin.json` under `mcpServers.core`
(`python3 ${CLAUDE_PLUGIN_ROOT}/scripts/core-server.py`). It reports itself as `archetype-core`
v`0.6.0` (protocol `2025-06-18`) and is the data plane between the actor LLM and the Archetype
backend: Claude never touches tokens or raw HTTP. Configuration comes from environment variables
(see [Environment variables](#environment-variables)).

**Deadlines:** every value here bounds the WHOLE HTTP exchange on the wall clock, not a single
socket operation. `urllib`'s own `timeout` restarts on every `recv`, so a backend or proxy that
trickles bytes could otherwise hold a call open forever; `_send` runs the exchange on a daemon
thread and abandons it at the deadline. An expired deadline maps to status `0` with body
`{"error": "deadline_exceeded", "message": ...}`. `start_run` adds "no run was handed to this
session", tells the actor not to call `start_run` again (retrying is the user's decision, offered by
the validation skill in the main session), and adds a run-without-`pool=` hint for pool runs;
`report_result` tells the actor to check
`get_run` before re-sending, because the backend may already have stored the results.
Default `HTTP_TIMEOUT = 15` s; `RUN_TIMEOUT = 180` s (run assembly runs a server-side
LLM chain, ~90 s tolerated, plus up to ~a minute of pool spin-off); `RESULT_TIMEOUT = 60` s
(multi-MB screenshot payloads; a client timeout after server-side storage would surface as a
confusing 409 on retry); `PERSONA_TIMEOUT = 180` s (one server-side LLM call per preview candidate,
and one for the pool's reference persona on save).

**Shared error rendering:** any non-2xx backend response becomes an `isError` text result via
`backend_error_text` — it prefers the backend's `message`, falls back to the `error` slug, then
`backend returned {status}`. A 401 always gets the login hint appended:
`Run /archetype:setup to log in.` Network failures map to status `0` with body
`{"error": "network_error", "message": ...}` and render through the same path. When `authed_call`
cannot obtain a token at all, the tool returns `Not connected. Run /archetype:setup to log in.`
(`isError`).

**Concurrency:** only the main loop reads stdin. Each `tools/call` runs on its own daemon thread, so
a slow `start_run` never delays `status`, `get_run` or `report_result`. Responses to
server-initiated requests (the login elicitation) are routed to their waiter by `route_response`.
`notifications/cancelled` suppresses the reply of the named request, per MCP. `ping` answers `{}`.
When the client sends `_meta.progressToken`, the server emits `notifications/progress` every
`ARCHETYPE_PROGRESS_INTERVAL` seconds while the call is in flight.

### The tools

Twenty tools. The ten below are unchanged from 0.5.1 apart from `start_run` (claim mode, `browser`)
and `report_result` (`abandoned`, outcome, raw actions, browser, video). `log_step`, the eight
study tools and `dispatch_study` are described in
[Studies, protocol v2 and browsers](#studies-protocol-v2-and-browsers-060).

#### `login`

Connect the session to an Archetype account; validates any cached token first, otherwise runs the
Auth0 device flow.

- **Arguments:** none.
- **Backend:** `POST /api/oauth/validate-token` (15 s) for the cached token; on miss, the device
  flow (see [Login / elicitation flow](#login--elicitation-flow-perform_device_login)):
  `POST /api/oauth/device/code` and polled `POST /api/oauth/device/token` (15 s each).
- **Result text:** if the cached token is valid — `Already connected to Archetype as {user_id}.`
  plus the token path and re-login instructions. On fresh login —
  `Connected to Archetype. Access token saved to {auth_path} (mode 0600).` plus next-step
  suggestions (`/archetype:persona`, `/archetype:validation <goal> url=<...>`).
- **Errors:** `isError` if `CLAUDE_PLUGIN_DATA` is unset, if the device-code request fails, if the
  user cancels the elicitation (`Login cancelled. Re-run /archetype:setup to try again.`), or if
  polling ends in a terminal error / times out (`expired_token`).
- **Browser:** the default browser is auto-opened once per device code, when the code is minted.
  A re-prompt for a code that is still pending never opens another tab, and
  `ARCHETYPE_NO_BROWSER=1` (or a `BROWSER` whose basename is `true`) suppresses the auto-open
  entirely; the modal then says to open the URL by hand.

#### `start_run`

Start a validation run: the backend assembles a persona-enriched instruction set that the actor
follows verbatim.

- **Arguments:**
  - `url` (string, optional): the product URL under test. Required unless `feature_id` names a
    feature with a saved url; a call with neither is refused locally with advice to ask the user.
  - `goal` (string, optional) — what to test, e.g. `test the signup flow`.
  - `feature_id` (string, optional) — saved-feature `_id` from `list_features`.
  - `pool_id` (string, optional) — `poolId` from `list_pools`, to run AS a fresh member spun off
    from that pool's distribution instead of the replay-derived persona (spin-off adds up to ~a
    minute before the run starts).
  - `preconditions` (array of strings, optional; added v0.4.1, released in 0.5.1): context the
    persona BEARS on arrival, distinct from the goal: their own project/stack ("you run your own
    suite of production endpoints"), a provisioned account ("staging login: X/Y"), or prior
    knowledge/state. Specifics a precondition implies but doesn't state are invented by the
    persona in character, never asked, never skipped. A lone string is treated as a one-item
    list; blank entries are dropped.
- **Backend:** `POST /api/plugin/runs` (timeout **180 s**), body keys camelCased (`goal`,
  `featureId`, `url`, `poolId`; `None` values dropped), via `authed_call`. Non-empty
  `preconditions` are sent as a list under their own name. No backend reads them yet, so the
  plugin renders them into the briefing itself.
- **Result text:** the rendered briefing — backend `brief`, for pool runs a
  `Running as {member name}, spun from pool {pool name}.` line (from the response's `pool` +
  `persona` blocks; when the backend reports `pool.spunOff: false` the line says the tester was
  chosen from the pool as the member whose need fits the goal best), the persona section with the persona card, a `WHY YOU ARE HERE` section
  with the need this run gives the persona (left out when there is none), a `You arrive with:`
  section listing each precondition plus the reminder that implied specifics are the persona's to
  invent in character (left out when there are none), the scenarios section (with
  `(goal: … · target: …)` when present), each scenario numbered as `[id] title` with `- step`
  lines and an `Expected:` line, `— CONDUCT RULES —`, `runId`/`sessionId`, and the full
  `report_result` contract (see
  [`report_result` payload contract](#report_result-payload-contract-in-full)).
- **Errors:** `not_connected()` when no token could be obtained; `backend_error_text` for non-2xx;
  the [pool guard](#pool-guard-in-start_run) can abort a *successful* response as `isError`.
  The local run log records the start only after the guard passes.

#### `report_result`

Post the actor's structured results back to Archetype and return the backend confirmation plus
summary counts.

- **Arguments:**
  - `run_id` (string, **required**)
  - `session_id` (string, **required**)
  - `status` (string, **required**, enum `completed | failed | aborted`)
  - `steps` (array, **required**) — per-step keys are translated snake→camel: `action_text→actionText`,
    `observation_page_type→observationPageType`, `scenario_id→scenarioId`,
    `screenshot_b64→screenshotB64`; all other keys pass through unchanged. A step may instead
    carry `screenshot_path`, the file a screenshot tool saved: the server reads it and sends it as
    `screenshotB64` only when it is a PNG, JPEG or WebP file (checked by magic bytes) of at most
    1 MB, never sends the path, and lists skipped files in the result. `screenshot_b64` wins
    when both are given.
  - `feedback` (object, **required**) — passed through **untouched**; its nested keys must already
    be camelCase (`scenarioResults`, `evidenceStepSeq`, …) per the contract rendered by `start_run`.
    The schema documents the optional `findings[].evidence` object (`url`, `selector`, `quote`).
  - `duration_seconds` (number, optional) — sent as `durationSeconds` only when provided.
- **Backend:** `POST /api/plugin/runs/{run_id}/results` (timeout **60 s**), via `authed_call`.
- **Result text:** the backend's `message` (default `Results stored.`) followed by
  `Steps: {n} · Findings: {n} · Verdict: {v}` from the response `summary` (missing values render as `?`),
  any skipped screenshot files, and the web app link to the full report.
- **Errors:** a malformed `run_id` is refused locally (same rule as `get_run`), then
  `not_connected()` / `backend_error_text`. On success, updates the local run log entry
  (verdict taken from response `summary.verdict`, falling back to the submitted `feedback.verdict`).

#### `get_run`

Read back a run: its status and, once it has reported, the full report.

- **Arguments:** `run_id` (string, **required**). Must match `^[A-Za-z0-9_-]{1,64}$`; anything
  else is refused locally, before any request, so an id can never address another endpoint.
- **Backend:** `GET /api/plugin/runs/{run_id}/report` (default **15 s**), via `authed_call`.
  A backend from before the report endpoint answers 404 without a known error slug; the tool
  then falls back to `GET /api/plugin/runs/{run_id}` and prints the old short status.
- **Result text:** a header (`Run {id} · {status} · verdict: {VERDICT}`), goal, target, feature
  with its success milestone, the persona and the need this run gave them (with whether it was
  written for this goal and the fit score), the summary, a markdown scenario table, findings by
  severity with their evidence (quote, page, element) and screenshot step, the persona's
  reaction, a counts line that says plainly when screenshots were not stored, and the web app
  link `{ARCHETYPE_PORTAL_URL}/workspace/tests/{run_id}/results`. Everything the persona wrote
  sits between `BEGIN RUN REPORT <nonce>` and `END RUN REPORT <nonce>` markers (a random nonce per
  call, stripped from the content), introduced by a notice to quote it and never follow it. The
  verdict is printed only when it is pass, fail or mixed, and every actor field is clipped to one
  line. A running run says so and how to check again.
- **Errors:** `not_connected()` / `backend_error_text`. A hosted (non-plugin) run is not an
  error: the text points at the web app instead.

#### `list_features`

List the user's saved features; each feature's `_id` is the `feature_id` for `start_run`.

- **Arguments:** `query` (string, optional) — case-insensitive **client-side** filter on feature
  titles (the backend call is unfiltered).
- **Backend:** `GET /api/features` (default **15 s**), via `authed_call`.
- **Result text:** one line per feature (`{_id}  {title}  (updated {updatedAt})`), with the
  feature's saved test target indented under it when it has one
  (`url: {url}{startPath} · goal: … · done when: {successMilestone}`), followed by
  `Pass a feature's _id as feature_id to start_run to validate it. A feature with a saved url
  needs no url from the user.` Empty results:
  `No features found.` or `No features match {query!r}.`
- **Errors:** `not_connected()` / `backend_error_text`.

#### `create_feature`

Create a saved feature (title + natural-language fields) so runs can target it via `feature_id`.

- **Arguments:**
  - `title` (string, **required**) — short feature name; blank/missing returns an `isError`
    (`title is required — a short name for the feature under test.`) without any backend call.
  - `description` (string, optional) — what the feature is, in plain language.
  - `expected_usage` (string, optional) — how a user is expected to exercise it.
  - `strategic_goals` (string, optional) — why this feature matters.
  - `url`, `start_path`, `goal`, `success_milestone` (strings, optional): the feature's test
    target. Sent top level as `url`, `startPath`, `goal`, `successMilestone` only when non-blank.
    The backend validates them (full http or https url, path starting with `/`) and answers 400
    `invalid_feature_target` with a reason otherwise.
- **Backend:** `POST /api/features` (default **15 s**), via `authed_call`. Body is
  `{"title": ..., "fields": {"description": ..., "expected-usage": ..., "strategic-goals": ...}}` —
  note the kebab-case field keys; missing fields are sent as empty strings. Target fields ride
  alongside `fields`. When a url was sent but the saved feature comes back without one, the
  result says the backend predates saved targets.
- **Result text:** `Feature saved: {title}`, the id (`pass it as start_run's feature_id`), and a
  suggestion: `Validate it now: /archetype:validate-feature {title}`.
- **Errors:** local title validation, then `not_connected()` / `backend_error_text`.

#### `status`

Render the connection dashboard. Read-only — **never** triggers a login.

- **Arguments:** none.
- **Backend:** `POST /api/oauth/validate-token` (15 s) and, when the token is valid,
  `GET /api/features` (15 s) — both called directly, **not** through `authed_call`.
- **Result text:** `— ARCHETYPE STATUS —` header, then:
  - *No token:* `Account: Not connected — run /archetype:setup to log in.` plus Backend and Portal
    lines.
  - *Token valid (200 + `valid: true`):* Account line built from the `id_token` JWT claims (`name`,
    `email`; payload decoded for display only, no signature check) plus `({user_id})`;
    `Token: valid` with an expiry estimate computed from `saved_at + expires_in` (`in ~Nh` /
    `in ~Nm` / `past its lifetime (a re-login will happen automatically)`);
    `Backend: … — reachable`; `Features: N saved` (or `Features: unavailable`).
  - *Backend unreachable (status 0):* `(could not verify)` account,
    `Token: could not verify — backend unreachable`, `Backend: … — unreachable ({message})`.
  - *Token invalid/expired:* `Token: expired or invalid — run /archetype:setup to log in (any
    archetype command will also re-login automatically)`.
  - Then `Recent runs (this machine):` — the last **5** run-log entries, newest first, as
    `{run_id}  {goal-or-url}  → {status}[ · verdict {v}]` (or `none recorded yet`) — and the Portal
    link.
- **Errors:** never returns `isError`; every state (including no token and corrupt `auth.json`)
  renders as a normal dashboard.

#### `list_pools`

List the user's persona pools with name, description, member count, and created date.

- **Arguments:** none.
- **Backend:** `GET /api/persona/pools` (default **15 s**), via `authed_call`.
- **Result text:** `{N} persona pool(s):`, then per pool: `{name}  · {personaCount} member(s)` with
  `· created {createdAt}` when present, the description truncated to 200 chars, an
  `archetype: {metadata.primary_archetype_name}` line when it differs from the pool name (the
  fallback key skills match against), and an indented `id: {poolId}` line. A footer shows the
  run-usage pattern (`/archetype:validation "<goal>" url=<...> pool="<name>"`) and instructs the
  actor to resolve names to ids for `start_run`'s `pool_id` without displaying ids to the user
  unless asked. Empty: `No persona pools yet. Create one with /archetype:persona — say 'new' and
  I'll walk you through a short questionnaire.`
- **Errors:** `not_connected()` / `backend_error_text`.

#### `create_pool`

Create a persona pool from a natural-language vibe prompt (plus optional demographic controls);
`preview_only=true` returns unsaved candidate directions instead of saving. The saved pool is
**EMPTY** — it stores the distribution spec only, and fresh testers are spun off from it at
validation time (each run adds one member).

- **Arguments:**
  - `vibe_prompt` (string, **required**) — who the pool's testers are, how they behave, what they
    care about; blank/missing returns an `isError` without a backend call.
  - `name` (string, optional) — display name for the pool (the archetype name); when omitted, the
    name derives from the server's vibe summary (then the reference persona's generated name).
  - `age_range` (array of numbers, optional) — `[low, high]`, e.g. `[28, 35]` → sent as
    `controls.ageRange`.
  - `skills_range` (array of numbers, optional) — `[low, high]` tech-savviness on a 0–100 scale →
    `controls.skillsRange`.
  - `occupation` (string, optional) → `controls.occupation`.
  - `education` (string, optional) → `controls.education`.
  - `product_description` (string, optional) — one-line product description used to derive the
    testers' need → `productDescription`.
  - `preview_only` (boolean, optional) — return unsaved candidates; sets `previewOnly: true`.
  - `preview_count` (number, optional) — how many previews (1–5, default **2**); sent as
    `previewCount` only in preview mode.
- **Backend, preview mode:** `POST /api/persona/vibe` (timeout **180 s**), via `authed_call`; body
  always includes `mode: "vibe"` and `vibePrompt`; `controls` is included only if at least one
  control was given. Nothing is persisted.
- **Backend, save mode — a THREE-call sequence** (each via `authed_call`, timeouts **180 s** /
  **180 s** / **15 s**):
  1. `POST /api/persona/custom` — persists the distribution spec as a customized preset plus one
     reference persona (intrinsic: distributions are derived from the generated sample). Body:
     `mode: "vibe"`, `vibePrompt`, `controls?`, `productDescription?`, `archetypeName` (only when
     `name` was given). The response yields `persona.personaId` (the reference) and
     `customPersonaId`.
  2. `POST /api/persona/pool/create` with `selectedPersonaIds: [<reference personaId>]`,
     `archetypeName`, `description` (the vibe prompt, truncated to 300 chars) → `personaPoolId`.
     The reference persona carries a `custom_persona_id`, so the backend stores the spec link as
     `metadata.selected_custom_persona_ids` and attaches **no members**. This route hard-codes the
     pool's name to `Pool_<8-hex>` and does not return a name.
  3. `PATCH /api/persona/pools/<poolId>` with body `{"name": <pool name>, "description": …}` — the
     route only recognizes the body key `name` (`pool_name` would be silently ignored and the
     rename dropped).
- **Failure semantics (the sequence is non-atomic by design):** a step-2 failure is an `isError`
  with retry guidance — only an orphaned preset is left behind (benign: its reference persona is
  unattached and invisible to pool listings). A step-3 failure is **not** an error: the pool is
  fully usable under its auto-generated `Pool_<hex>` name — the result reports the `poolId` and
  says so. Step 1 is never auto-retried.
- **Result text:** *preview mode* — `{N} persona preview(s) — directions for the pool's
  distribution, not saved yet…`, each candidate with name, `vibe:` summary, story (truncated to
  300 chars), and `need:`, plus instructions to call `create_pool` again without `preview_only`,
  folding the chosen candidate's summary into `vibe_prompt` (and passing its name as `name`).
  *Save mode* — `Persona pool saved: {name}` (or the rename-failure variant above), `Spec: {vibe
  summary}`, the `Members: 0 — fresh testers are spun off … each run adds one.` line, the
  run-usage line with `pool="{name}"`, and `(id for tool calls only, not for display: {poolId})`.
- **Errors:** local `vibe_prompt` validation, then `not_connected()` / `backend_error_text` /
  the step-2 and step-3 semantics above.

### Self-healing auth (`authed_call`)

Every backend-touching tool except `login` and `status` wraps its HTTP call in `authed_call(do_call)`:

1. **Load token** — `load_token()` reads `access_token` from `${CLAUDE_PLUGIN_DATA}/auth.json`
   (returns `None` on missing env var, missing file, or unparseable JSON).
2. **Missing token** → run `perform_device_login()` inline (the same elicitation-modal device flow
   as `login`). If that fails or the user declines, `authed_call` returns the failure message (a
   `str`) and the caller renders `Not connected. Run /archetype:setup to log in.` followed by that
   message (`isError`), so the URL and code reach the user even from a subagent.
3. **Call once.** If the backend answers **401** → re-login once via the same inline flow, and if a
   new token is obtained, **retry the call exactly once**. If re-login fails, the original 401 is
   returned and rendered by `backend_error_text` with the login hint and the failure message.

Tool calls run concurrently, so `perform_device_login` holds a lock: a second call that needs a
login while one is in progress waits, then reuses the token the first obtained (one modal, one
device code).

### Resumable, bounded login

The device flow never depends on the modal being readable:

- **The modal leads with what matters.** Line 1 is `Archetype login code: <code>`, line 2 is the
  bare verification URL. Clients truncate long elicitation messages to their first lines.
- **stderr carries the same two values** (`login: open <url> and confirm code <code>`), which land
  in the Claude Code debug log.
- **The device code is kept** in `${CLAUDE_PLUGIN_DATA}/pending_login.json` (mode `0600`) until it
  is used, declined, or expires. The next `login` (or self-heal) polls it once first: an approval
  given in the browser is honored with no new modal and no new code. `logout` deletes it.
- **One browser per code.** Auth0 binds a user code to the first browser session that opens it; a
  second browser then sees "Invalid or expired user code". The plugin auto-opens the default
  browser once, when the code is minted, so finish there; a re-prompt for the same code never
  opens another tab. Opening the URL by hand is for when nothing opened (set
  `ARCHETYPE_NO_BROWSER=1`, or `BROWSER=true` as the test harness does, to suppress the
  auto-open).
- **Every wait is bounded.** The modal waits `ARCHETYPE_ELICIT_TIMEOUT` (600 s) at most; after
  Accept, token polling runs for `ARCHETYPE_APPROVAL_POLL_WINDOW` (120 s) at most.

| modal outcome | then |
| :--- | :--- |
| accepted, token ready | token saved, `Connected to Archetype...` |
| accepted, approval not through within the window | `isError`, "has not come through yet", how to finish in the browser; still resumable |
| declined or cancelled | `Login cancelled.`; no token poll; device code discarded |
| error or never answered (headless client, subagent) | one poll (the browser may already be approved), else `isError` with URL, code and "Re-run /archetype:setup"; still resumable |

Opt-outs: **`login`** is the flow itself (it validates the cached token via
`existing_token_is_valid`, then runs the device flow), and **`status`** is deliberately read-only —
its docstring says "Reports state; never triggers login" — so a broken token renders as a dashboard
line instead of a modal. One consequence for skills and agents: the login elicitation modal can only
render in the main session, so multi-run dispatch must ensure the session is connected before
spawning the `feature-validator` agent, which does not carry the `login` tool at all.

### Pool guard in `start_run`

After a 2xx response, if the caller passed `pool_id` but the response's `pool.poolId` does not
match it (or the response carries no `pool` block at all), the run is aborted with an `isError`
result *before* the briefing is rendered or the run log is written. Rationale (from the code
comment): an outdated backend silently ignores unknown fields, which would brief the actor as the
wrong tester. The error text names both ids (`asked for {requested}, got {returned or 'none'}`),
suggests deploying the current backend or retrying without `pool=` to use the replay-derived
persona, and warns: `Do NOT act on this run; a stray run doc ({runId}) may exist server-side.`

### Local run log

- **Path:** `${CLAUDE_PLUGIN_DATA}/runs.json` (per-machine; cross-device history lives in the
  portal). Best-effort only — write failures are logged to stderr, never fatal.
- **On `start_run` success** (`record_run_start`): appends
  `{run_id, session_id, goal, url, feature_id, pool_id, started_at}` (`started_at` is epoch
  seconds; `None` values dropped). `run_id`/`session_id` come from the response; the rest from the
  tool arguments. Pre-0.4.0 entries carry `persona_id` instead of `pool_id`; the `status`
  dashboard tolerates them (it renders run id, goal/url, and outcome only).
- **On `report_result` success** (`record_run_result`): scans entries newest-first for the matching
  `run_id` and sets `status`, `verdict`, `reported_at` on that entry.
- **Cap:** only the last **20** entries (`RUN_LOG_LIMIT`) are kept on each save; `status` displays
  the last **5** (`RUN_LOG_SHOWN`).
- **Corruption tolerance:** unreadable or non-list JSON makes `load_run_log()` log
  `run log unreadable, starting fresh` and return `[]` — the next write overwrites the corrupt file.

### Login / elicitation flow (`perform_device_login`)

1. Requires `CLAUDE_PLUGIN_DATA`; otherwise fails with a "cannot determine where to store
   credentials" message. Token path: `${CLAUDE_PLUGIN_DATA}/auth.json`.
2. `POST /api/oauth/device/code` (empty body, 15 s) → `device_code`, `user_code`, verification URL
   (`verification_uri_complete`, falling back to `verification_uri`), `interval` (default 5),
   `expires_in` (default 900). Missing URL or non-200 is a failure.
3. Best-effort `webbrowser.open(verify_url)` (silently tolerated on headless boxes), only for a
   code minted by this call (a resumed pending code was opened when it was minted) and never when
   `ARCHETYPE_NO_BROWSER=1` or `BROWSER` names `true`. Then a
   server-initiated JSON-RPC `elicitation/create` modal showing the URL and the user code (for
   cross-check) with a single required boolean field `approved` ("I've approved the request in my
   browser"). The flow proceeds only when the user clicks **Accept** with the box ticked; anything
   else (decline, elicitation error, unticked) →
   `Login cancelled. Re-run /archetype:setup to try again.`
4. Polls `POST /api/oauth/device/token` with `{device_code}` every `max(interval, 3)` seconds until
   the `expires_in` deadline: `authorization_pending` → keep polling; `slow_down` → add 2 s to the
   interval; any other error → terminal failure; deadline reached → `expired_token` ("Device flow
   timed out before approval.").
5. On success, writes `auth.json` with `access_token`, `token_type` (default `Bearer`),
   `expires_in`, `scope`, `refresh_token`, `id_token`, and `saved_at` (epoch seconds; `None` values
   dropped), then `chmod 0600`.

Note that `server_request` blocks on stdin for the elicitation response and ignores (logs and skips)
any interleaved messages that arrive while waiting.

---

## Backend HTTP contract

All backend traffic goes through the `archetype-core` MCP server (`scripts/core-server.py`); Claude
never issues raw HTTP — it calls MCP tools, and the server maps them to these endpoints.

**Transport basics**

- Base URL: `ARCHETYPE_BACKEND_URL` env var, default `https://api.syntheticarchetype.com` (trailing
  `/` stripped).
- Auth: single `Authorization: Bearer <access_token>` scheme; the token is an Auth0 RS256 JWT cached
  at `${CLAUDE_PLUGIN_DATA}/auth.json` (mode `0600`).
- `User-Agent`: `archetype-claude-plugin/0.6.0` (override via `ARCHETYPE_PLUGIN_USER_AGENT`).
  Required: the Cloudflare WAF in front of the API returns HTTP 403 (error 1010) for the default
  Python-urllib UA.
- Timeouts: as listed under [MCP tools](#mcp-tools-server-core) — 15 s default, 180 s for
  `POST /api/plugin/runs`, `POST /api/persona/vibe`, `POST /api/persona/custom`, and
  `POST /api/persona/pool/create`, 60 s for results ingestion.
- Network failures are mapped client-side to status `0` with body
  `{"error": "network_error", "message": ...}`.

### Endpoint table

| Method | Path | Auth | Called by (MCP tool) | Request body (as sent by plugin) | Success response |
|---|---|---|---|---|---|
| POST | `/api/oauth/device/code` | none | `login` / self-healing path | `{}` | 200 — Auth0 device-code response verbatim: `device_code`, `user_code`, `verification_uri`, `verification_uri_complete`, `expires_in`, `interval` (URIs may be rewritten to a branded `DEVICE_AUTH_PUBLIC_BASE` domain) |
| POST | `/api/oauth/device/token` | none | `login` / self-healing path (polled) | `{"device_code": "<...>"}` | 200 — `access_token`, `token_type`, `expires_in`, `scope`, `refresh_token?`, `id_token?`. While pending, Auth0's 403 with `error: "authorization_pending"` (keep polling) or `"slow_down"` (plugin adds 2 s to the poll interval) |
| POST | `/api/oauth/validate-token` | Bearer | `login`, `status` | `{}` (token in header) | 200 — `{"valid": true, "user_id", "audience", "issuer", "expires_at", "issued_at", "scope", "payload"}`; invalid token → 401 `{"valid": false, "error": "invalid_token", "reason"}`; no token → 400 `{"valid": false, "error": "missing_token"}` |
| POST | `/api/plugin/runs` | Bearer | `start_run` | `{"goal", "featureId", "url", "poolId", "preconditions"?}`: plugin maps `feature_id`→`featureId`, `pool_id`→`poolId`; `None` fields dropped; `preconditions` is a list of strings, sent only when non-empty and not read by any backend yet (the plugin renders it into the briefing); tool-side, either `url` or `feature_id` is required (a feature with a saved url needs no url; the backend then opens its start page). Legacy `personaId` payloads (pre-0.4.0 plugins) get 400 `plugin_outdated` ("update your plugin") from a pool-aware backend | 201: run body: `runId`, `sessionId`, `brief`, `persona{personaId, personaCard, ...}` (for pool runs, the freshly spun-off member appended to the pool), `pool{poolId, name}` when a pool was targeted, `instructions{goal, targetUrl, scenarios[{id, title, steps[], expectedResult}], conduct[]}`. `persona.personaNeed` is the need fitted to this run's goal, with `needSource` (`persona`, `rewritten` or `fallback`) and `alignmentScore`; `start_run` prints it as the WHY YOU ARE HERE section |
| POST | `/api/plugin/runs/<run_id>/results` | Bearer | `report_result` | See full contract below | 200 — `{"message": "<confirmation>", "summary": {"steps": n, "findings": n, "verdict": "..."}}` |
| POST | `/api/plugin/runs/<run_id>/claim` | Bearer | `start_run` (claim mode) | `{"browser": {...}}` (or `{}`) | 200: the same briefing as `POST /api/plugin/runs`; 409 when the run is not `queued` |
| POST | `/api/plugin/runs/<run_id>/steps` | Bearer | `log_step`, `report_result` (flush) | `{"session_id", "step"}` (snake_case step record) | 200: `{"ok", "state": {"seq", "maxSteps", "unproductive", "maxUnproductiveSteps", "progress", "sentimentTrend", "reviewGiveUp", "ended", "endedReason"}, "recall": [{"text", "source"}], "activeRules": [str], "note"}`; 409 when the run takes no more steps |
| POST | `/api/studies` | Bearer | `create_study` | camelCase study (see `docs/studies-api.md` in the backend) | 201: the study |
| PATCH | `/api/studies/<id>` | Bearer | `create_study` with `study_id` | the changed fields | 200: the study |
| GET | `/api/studies/<id>` | Bearer | `get_study` | none | 200: the study (factorSpec, archetypes, run refs, `runsDoneReason`) |
| GET | `/api/studies/<id>/runs` | Bearer | `dispatch_study`, `get_study` | none | 200: `{currentWave, status, runs: [{runId, archetypeId, archetypeName, status, wave, outcome, metrics, browser}]}` |
| POST, PATCH | `/api/studies/<id>/factors` | Bearer | `generate_factors`, `update_factors` | `{force?}`; `{factors: [{key, selected?, label?, riskPole?, icpTypicalLevel?, whyItMattersHere?}], order?}` | 200: `{factorSpec, status, generated?}` |
| POST | `/api/studies/<id>/archetypes` | Bearer | `generate_archetypes` | `{force?}` | 200: `{archetypes: [{archetypeId, name, role, variedFactors, factorVector, summaryOneLine, behaviorPolicy}], status}` |
| POST | `/api/studies/<id>/runs` | Bearer | `create_study_runs` | `{}` | 201: `{wave: 1, runs: [{runId, archetypeId, archetypeName, repeatIndex}]}` |
| POST | `/api/studies/<id>/runs/next` | Bearer | `next_study_wave`, the swarm runner | `{}` | 200: `{wave, runs}` or `{done: true, reason}`; 409 while the wave runs |
| GET | `/api/studies/<id>/status` | Bearer | `study_status` (polled every 10 s while `wait_seconds` lasts) | none | 200: `{status, archetypeCount, factorSpecReady, runs: {total, terminal, allTerminal, byStatus}}` |
| GET | `/api/studies/<id>/report` | Bearer | `get_study_report` | none | 200: plan 6.2 plus addendum section 2 |
| GET | `/api/plugin/runs/<run_id>/report` | Bearer | `get_run` | none | 200: `{"runId", "sessionId", "status", "goal", "url", "feature"?: {"id", "name", "successMilestone"}, "persona"?: {"name", "need", "needSource", "alignmentScore"}, "verdict", "summary", "personaReaction", "scenarios": [{"id", "title", "steps", "expectedResult", "status", "actualResult"}], "findings": [{"scenarioId", "category", "severity", "description", "evidenceStepSeq", "evidence", "screenshotStepSeq"}], "steps": [...], "screenshots": {"kept", "dropped"}, "counts", "analyticsReady"}`. 404 `run_not_found`, or `not_a_plugin_run` for hosted runs |
| GET | `/api/plugin/runs/<run_id>` | Bearer | `get_run` (fallback for older backends) | none | 200: `{"runId", "status", "progress", "analyticsReady", "screenshots"?, "feedback"?: {"verdict", "summary", ...}}` |
| GET | `/api/features` | Bearer | `list_features`, `status` (feature count) | — | 200 — `{"ok": true, "features": [{"_id", "title", "updatedAt", ...}]}`; a feature's `_id` is the `feature_id` for `start_run`. (The `query` title filter on `list_features` is applied client-side, not a query param.) |
| POST | `/api/features` | Bearer | `create_feature` | `{"title", "fields": {"description", "expected-usage", "strategic-goals"}, "url"?, "startPath"?, "goal"?, "successMilestone"?}`: plugin maps `expected_usage`→`expected-usage`, `strategic_goals`→`strategic-goals`, `start_path`→`startPath`, `success_milestone`→`successMilestone`; missing fields sent as `""`, blank target fields left out | 201: `{"ok": true, "feature": {"_id", "title", ...}}`; 400 `invalid_feature_target` |
| GET | `/api/persona/pools` | Bearer (401 on bad token — never degrades to anonymous listing, which would break self-healing) | `list_pools` | — | 200 — `{"personaPools": [{"poolId", "name", "description", "personaCount", "activePersonaCount", "createdAt", "metadata": {"primary_archetype_name"?, "selected_custom_persona_ids"?, ...}, ...}], "totalCount", "limit", "offset"}` |
| POST | `/api/persona/vibe` | Bearer | `create_pool` (preview only) | `{"mode": "vibe", "vibePrompt", "controls"?: {"ageRange", "skillsRange", "occupation", "education"}, "productDescription"?, "previewOnly": true, "previewCount": n}` — plugin maps `vibe_prompt`→`vibePrompt`, `age_range`→`controls.ageRange`, `skills_range`→`controls.skillsRange`, `product_description`→`productDescription`, `preview_count`→`previewCount` (default 2) | 200 — `{"examples": [{"name", "vibeSummary", "story", "personaNeed", ...}]}` (unsaved) |
| POST | `/api/persona/custom` | Bearer | `create_pool` (save, call 1 of 3) | `{"mode": "vibe", "vibePrompt", "controls"?, "productDescription"?, "archetypeName"?}` (`archetypeName` only when the `name` argument was given) | 201 — `{"persona": {"personaId", "name", "vibePromptSummary", ...}, "customPersonaId", "preset": {...}}` — the reference persona + spec preset |
| POST | `/api/persona/pool/create` | Bearer | `create_pool` (save, call 2 of 3) | `{"selectedPersonaIds": [<reference personaId>], "archetypeName", "description"}` — creates an EMPTY pool linked to the spec via `metadata.selected_custom_persona_ids`; hard-codes `pool_name` to `Pool_<8-hex>` | 201 — `{"personaPoolId", "selectedPersonaIds", "customPersonaIds", "archetypeName", "createdAt"}` — no pool name; the plugin echoes the name it already holds |
| PATCH | `/api/persona/pools/<pool_id>` | Bearer | `create_pool` (save, call 3 of 3) | `{"name": <pool name>, "description"}` — the route only recognizes the body key `name` (mapped to stored `pool_name`); `pool_name` would be silently ignored | 200 — the updated pool (same shape as a `personaPools` entry, plus `personas`) |

The backend also exposes `POST /api/plugin/replay/sessions` (body
`{"sessions": [{sessionId?, events, meta?}], "source"?: "upload"}` → 200
`{"ok", "ingested", "poolSize"}`), plus feature `GET/PUT/DELETE /api/features/<id>`, persona
`manual` mode, `GET /api/persona`, `GET/DELETE /api/persona/pools/<pool_id>`, and
`GET /api/oauth/me` — none of which the plugin's MCP server calls.

### snake_case → camelCase mapping

The MCP tool surface is snake_case (actor-facing); the wire format is camelCase (backend). The
server performs the mapping:

- **`start_run` top level:** `feature_id`→`featureId`, `pool_id`→`poolId` (`goal`, `url`,
  `preconditions` unchanged; `preconditions` is normalized to a list of strings and only sent
  when non-empty).
- **`report_result` top level:** `session_id`→`sessionId`, `duration_seconds`→`durationSeconds`
  (only included when provided); `status`, `steps`, `feedback` keys unchanged.
- **`report_result` per-step** (`_STEP_KEY_MAP`): `action_text`→`actionText`,
  `observation_page_type`→`observationPageType`, `scenario_id`→`scenarioId`,
  `screenshot_b64`→`screenshotB64`. All other step keys (`seq`, `narration`, `url`, `success`,
  `error`) pass through unchanged.
- **`report_result` `feedback` is passed through untouched** — its nested keys must already be
  camelCase (`scenarioResults`, `evidenceStepSeq`, …) per the contract rendered by `start_run`.
- **`create_pool`:** `vibe_prompt`→`vibePrompt`, `name`→`archetypeName` (step 1; also the pool
  name in steps 2–3), `age_range`→`controls.ageRange`, `skills_range`→`controls.skillsRange`,
  `product_description`→`productDescription`, `preview_only`→`previewOnly`,
  `preview_count`→`previewCount`. The PATCH rename sends the camelCase-free body key `name` —
  never `pool_name`.
- **`create_feature`:** `expected_usage`→`fields["expected-usage"]`,
  `strategic_goals`→`fields["strategic-goals"]`, `description`→`fields.description`.

### `report_result` payload contract (in full)

As rendered to the actor at the end of every `start_run` briefing:

- `run_id` (path), `session_id`, `status` — one of `completed | failed | aborted`,
  `duration_seconds` (optional number).
- `steps[]` — each step: `seq`, `scenario_id`, `action_text`, `narration`, `url`,
  `observation_page_type`, `success`, `error?`, `screenshot_b64?` (screenshots: at most 6 total, at
  most 1 MB each).
- `feedback` (camelCase inside):
  - `verdict`: `pass | fail | mixed`
  - `summary`: string
  - `scenarioResults[]`: `{scenarioId, status: pass | fail | blocked, actualResult}`
  - `findings[]`: `{scenarioId, category: bug | ux | content | performance | other, severity: critical | high | medium | low, description, evidenceStepSeq, evidence?}`
  - `findings[].evidence` (optional object, every field optional): `url` (the page, up to 2048
    characters), `selector` (CSS selector or role plus accessible name, up to 512) and `quote` (the
    exact on-screen text, up to 1000). The backend trims over-long strings and drops unusable
    evidence instead of rejecting the results, stores it with the finding and returns it in
    `GET /api/plugin/runs/<run_id>` under `feedback.findings[]`. It lets a grader check a finding
    mechanically instead of re-running the persona.
  - `personaReaction`: string

Wire body sent to `POST /api/plugin/runs/<run_id>/results`:

```json
{
  "sessionId": "...",
  "status": "completed",
  "durationSeconds": 123,
  "steps": [{"seq": 1, "scenarioId": "...", "actionText": "...", "narration": "...",
             "url": "...", "observationPageType": "...", "success": true,
             "error": "...?", "screenshotB64": "...?"}],
  "feedback": {"verdict": "pass", "summary": "...",
               "scenarioResults": [{"scenarioId": "...", "status": "pass", "actualResult": "..."}],
               "findings": [{"scenarioId": "...", "category": "bug", "severity": "high",
                             "description": "...", "evidenceStepSeq": 3,
                             "evidence": {"url": "...", "selector": "...", "quote": "..."}}],
               "personaReaction": "..."}
}
```

### Error statuses the plugin distinguishes

The `/api/plugin/*` routes return a uniform error body
`{"error": "<slug>", "message": "<plain-language guidance>"}` — by design, since the consumer is the
actor LLM. The plugin's `backend_error_text` renders `message` first, falling back to the `error`
slug, then `backend returned <status>`. (Persona-route errors use
`{"error", "details": {"message"}, "request_id"}`, so for those the plugin surfaces the slug.)

| Status | Slug | Plugin behavior |
|---|---|---|
| 401 | `unauthorized` | Handled by [self-healing auth](#self-healing-auth-authed_call): missing token → inline device-flow login; a 401 answer → re-login once and retry the call once. If a 401 still surfaces, the rendered error appends the login hint `Run /archetype:setup to log in.` Exception: the `status` tool is read-only and never triggers login. |
| 404 | `run_not_found` (plugin routes) / `not_found` (persona routes) | Rendered as the backend's natural-language `message`; no retry. |
| 409 | `conflict` | Rendered as-is — e.g. results already stored for the run (which the generous `RESULT_TIMEOUT` exists to avoid triggering spuriously). |
| 400 | `bad_request` / `validation_error` / `invalid_request` | Rendered as-is (malformed payload; e.g. missing `vibePrompt`). |
| 400 | `plugin_outdated` | A pool-aware backend rejecting a legacy `personaId` run payload: "Your Archetype plugin is outdated — personas are now pools. Update the plugin … and retry." The 0.4.0 plugin never sends `personaId`, so seeing this means an older plugin version is talking to the new backend. |
| 502 | `persona_generation_failed` | Upstream LLM fault during run assembly (including pool spin-off), results, or read-back; the message states no run was created (or results were not stored) and that it is **safe to retry** in a moment. Distinct from `PluginRunError` — mapped to its own branch server-side. |
| 500 | `internal_error` | "Safe to retry" NL message. |
| 0 | `network_error` (client-synthesized) | Backend unreachable; `status` dashboard reports "backend unreachable". |

One non-HTTP guard sits on top of the contract: the
[pool guard in `start_run`](#pool-guard-in-start_run), which aborts after a 2xx if the
response's `pool.poolId` does not match the requested `pool_id` (or the `pool` block is missing).

---

## Configuration, data, and distribution

### Environment variables

All configuration is read by the `core` MCP server (`scripts/core-server.py`) at startup. The server
inherits the environment of the Claude Code CLI, so export these **before** launching `claude`.

| Variable | Default | Effect |
| :--- | :--- | :--- |
| `ARCHETYPE_BACKEND_URL` | `https://api.syntheticarchetype.com` | Base URL for every backend call (device-flow OAuth, `/api/plugin/*`, `/api/features`, `/api/persona/*`). Trailing slashes are stripped. Set to `http://localhost:5001` for local backend development. Must be https; plain http only on `localhost`, `127.0.0.1` or `::1`, else every call (login included) is refused. Redirects are followed only within the same origin. |
| `ARCHETYPE_PORTAL_URL` | `https://www.syntheticarchetype.com` | Portal link rendered in the `/archetype:status` dashboard. Trailing slashes are stripped. |
| `ARCHETYPE_PLUGIN_USER_AGENT` | `archetype-claude-plugin/<server version>` (currently `archetype-claude-plugin/0.6.0`, from the `SERVER_VERSION` constant in `core-server.py`) | HTTP `User-Agent` sent on every backend request. The Cloudflare WAF in front of `api.syntheticarchetype.com` returns HTTP 403 (error 1010) for the default Python-urllib UA; any real, identifiable UA passes. If you override this and hit a 1010, switch back to the default. |
| `ARCHETYPE_HTTP_TIMEOUT` | `15` | Wall-clock deadline in seconds for ordinary backend calls. |
| `ARCHETYPE_RUN_TIMEOUT` | `180` | Deadline for `POST /api/plugin/runs` (run assembly plus pool spin-off). |
| `ARCHETYPE_RESULT_TIMEOUT` | `60` | Deadline for results ingestion. |
| `ARCHETYPE_PERSONA_TIMEOUT` | `180` | Deadline for the persona preview/custom/pool-create calls. |
| `ARCHETYPE_ELICIT_TIMEOUT` | `600` | Longest the login modal is waited on, in seconds. |
| `ARCHETYPE_NO_BROWSER` | *(unset)* | Set to `1` to stop login from opening a browser tab by itself (the modal still shows the URL to open by hand). A `BROWSER` whose basename is `true` (e.g. `/usr/bin/true`) has the same effect. |
| `ARCHETYPE_APPROVAL_POLL_WINDOW` | `120` | Longest token polling continues after the user accepts the modal. |
| `ARCHETYPE_PROGRESS_INTERVAL` | `5` | Seconds between `notifications/progress` ticks while a tool call is in flight (sent only when the client supplied a `progressToken`). |
| `ARCHETYPE_STEP_TIMEOUT` | `15` | Budget for a whole `log_step` call, flush included; past it the step is buffered. |
| `ARCHETYPE_STUDY_TIMEOUT` | `180` | Deadline for the study calls that run models (factors, archetypes, runs). |
| `ARCHETYPE_BROWSER_IDLE_MINUTES` | `15` | Idle minutes before a plugin browser's real server is stopped (`browser-server.py`). |
| `ARCHETYPE_BROWSER_START_TIMEOUT` | `180` | How long the proxy waits for the real browser server's handshake (first `npx` run downloads it). |
| `ARCHETYPE_BROWSER_TRACE` | *(unset)* | A file the browser proxy appends every MCP method to, for debugging startup. |
| `ARCHETYPE_CLAUDE_BIN` | `claude` | The CLI the swarm runner starts workers with. |
| `ARCHETYPE_RUNNER_WAVE_WAIT` | `30` | Seconds the runner waits between next wave attempts while the backend answers 409. |
| `CLAUDE_PLUGIN_DATA` | *(set by Claude Code)* | Directory holding `auth.json` (credentials), `runs.json` (run log), `runs/`, `browser/` and `studies/`; see below. |

### Plugin data files (`${CLAUDE_PLUGIN_DATA}`)

Claude Code resolves `${CLAUDE_PLUGIN_DATA}` per install: `~/.claude/plugins/data/archetype-archetype/`
for the marketplace install, `~/.claude/plugins/data/archetype-inline/` for a `--plugin-dir` dev
install (the dev copy is safe to wipe for E2E resets). If the variable is unset (e.g. Claude Code
was launched from inside the plugin folder), the server refuses to store credentials.

- **`auth.json`** — written by the device-flow login with file mode `0600`. Contents (fields with
  `None` values are dropped): `access_token`, `token_type` (defaults to `"Bearer"`), `expires_in`,
  `scope`, `refresh_token`, `id_token`, and `saved_at` (unix seconds). Every authed tool reads
  `access_token` from here and sends `Authorization: Bearer <token>`; the `status` tool decodes the
  account identity from `id_token`. Delete the file to force a fresh login.
- **`runs.json`** — best-effort per-machine run log feeding the status dashboard (cross-device
  history lives in the portal). Capped to the last **20** entries (`RUN_LOG_LIMIT`); the dashboard
  shows the most recent **5** (`RUN_LOG_SHOWN`). Write timing and per-entry fields are described
  under [Local run log](#local-run-log). Write failures are logged and never fatal.

- **`runs/`**: per run state while a run is active (`<run_id>.state.json`, `.journal.jsonl`,
  `.steps.jsonl` buffer, `.actions.jsonl` raw actions, `active-<agent>.json`), removed after a
  stored report.
- **`browser/<server>/`**: each plugin browser's `config.json`, Playwright output files and
  `videos/*.webm`.
- **`studies/<study_id>/`**: `waves.json` (waves seen), and for the swarm runner `runner.json`,
  `runner.log`, the shadow plugin and `<run_id>/stream.jsonl` per worker.

### Install, update, and dev loop

- **Marketplace install (partners/users):**
  1. `/plugin marketplace add https://github.com/MCxiaoguu/Archetype_Plugin` — use the **HTTPS URL
     form**; the `owner/repo` shorthand clones over SSH and fails for users without SSH keys.
  2. `/plugin install archetype@archetype` (plugin name `archetype` from the marketplace named
     `archetype`).
- **Updates:** installed copies only see an update when `version` in `.claude-plugin/plugin.json` is
  bumped — bump it for every released change so update prompts fire cleanly.
- **Dev install:** `claude --plugin-dir /path/to/Archetype_Plugins --debug`. Launch from a directory
  **outside** the plugin folder, otherwise Claude Code treats the plugin files as project config and
  `${CLAUDE_PLUGIN_ROOT}` / `${CLAUDE_PLUGIN_DATA}` won't resolve (`/doctor` shows "Missing
  environment variables"). Use `/reload-plugins` to pick up edits without relaunching. Multiple
  `--plugin-dir` flags stack, and a local `--plugin-dir` copy takes precedence over a same-name
  marketplace install for that session.
- **Alternative distribution:** zip the plugin directory, host it, and load with
  `claude --plugin-url https://example.com/archetype.zip`.

### Testing

- **Unit harness:** `python3 scripts/test_core_server.py`. A scripted stdio harness that runs the
  MCP server as a subprocess, drives line-delimited JSON-RPC over stdin/stdout, and stands up a
  stdlib `http.server` stub that records every backend request (method, path, headers, parsed JSON
  body) and replays canned responses. Stdlib-only (no pytest, no pip deps); exits non-zero on the
  first failing assertion and prints per-case PASS/FAIL plus a final `ALL PASS` line.
- **Action hook:** `python3 scripts/test_action_hook.py` (writes, redacts, never fails, maps tool
  names, keeps parallel agents apart).
- **Browsers:** `python3 scripts/test_browsers.py` (the lazy proxy against a fake MCP child, the
  permission hook decisions, the runner's shadow plugin and worker command).
- **Agents:** `python3 scripts/test_agents_in_sync.py`; **session hook:**
  `python3 scripts/test_session_hook.py`.
- **Manifest:** `claude plugin validate --strict .` (CI runs it).
- **Live E2E:** the operator runbook is `e2e/RUNBOOK.md`. An outer orchestrator session drives an
  inner Claude Code session in tmux (session name `archetype-e2e`, helpers in `e2e/tmux.sh`,
  override via `E2E_SESSION`) through the real Auth0 device flow, a Chrome-driven validation of the
  demo app at `http://localhost:8321`, and backend verification via `e2e/verify_backend.py` —
  whose required checks now include the pool-first happy path: the run's pool exists, its listed
  `pool_name` equals `metadata.primary_archetype_name` (catches a silently dropped `create_pool`
  rename), and the spun-off member was appended to the pool. Artifacts land in `e2e/artifacts/`
  (gitignored); steps map to acceptance criteria A1–A5, B1–B2, C in
  `docs/GOAL_AND_TEST_CRITERIA.md`.

### Manifests

**`.claude-plugin/plugin.json`** (the only file that belongs inside `.claude-plugin/` — skills,
hooks, and agents live at the plugin root):

| Field | Value |
| :--- | :--- |
| `name` | `archetype` |
| `description` | `Persona and behavioral study testing for your product through Synthetic Archetype` |
| `version` | `0.6.0` |
| `author.name` | `Synthetic Archetype` |
| `mcpServers.core` | `{"type": "stdio", "command": "python3", "args": ["${CLAUDE_PLUGIN_ROOT}/scripts/core-server.py"]}`; the six browser servers are in `.mcp.json` at the plugin root |

**`.claude-plugin/marketplace.json`** (makes the repo double as its own single-plugin marketplace):

| Field | Value |
| :--- | :--- |
| `name` | `archetype` (the marketplace name — hence `archetype@archetype`) |
| `owner.name` | `Synthetic Archetype` |
| `plugins[0].name` | `archetype` |
| `plugins[0].source` | `{"source": "url", "url": "https://github.com/MCxiaoguu/Archetype_Plugin.git"}` |
| `plugins[0].description` | `Testing your product with synthetic personas` |

---

### `logout`

Delete the locally cached credentials (`auth.json`) — purely local: the old
token is not revoked server-side and lapses within its normal lifetime. Run
history (`runs.json`) is preserved. No arguments; never triggers a login;
friendly no-op when not connected. Surfaced as `/archetype:logout` (added
v0.3.9).

Verified against plugin version 0.6.0 (`.claude-plugin/plugin.json`, server `archetype-core` 0.6.0,
`@playwright/mcp@0.0.84`) on 2026-11-03.
