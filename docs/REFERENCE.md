# Archetype plugin — wiring reference

This plugin is the actor half of the Archetype pipeline: it lets a builder test their product as if
customers were sitting beside them. The backend supplies a persona, goal, and scenarios; the plugin's
skills and agent drive Claude-in-Chrome through the product as that persona and report structured
results back for persistence, plus a local report in the session. All backend traffic flows through
one stdio MCP server (`core`, `scripts/core-server.py`); Claude never touches tokens or raw HTTP.

Contents:

1. [Commands and agents](#commands-and-agents)
2. [MCP tools (server: `core`)](#mcp-tools-server-core)
3. [Backend HTTP contract](#backend-http-contract)
4. [Configuration, data, and distribution](#configuration-data-and-distribution)

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
objects**, each `{ "goal": "...", "url": "...", "persona": "<intent or null>", "feature": "<name or null>" }`:

| field | semantics |
| :-- | :-- |
| `goal` | what to test — the free text minus everything else captured |
| `url` | a `url=<...>` token or any URL in the text |
| `persona` | ANY persona intent: `persona=<...>` token, a name ("as Veda", "with Marcus"), or a description ("as a cautious non-technical first-timer") |
| `feature` | a named saved feature (prefer `validate-feature` when feature-first) |

**Multi-run fan-out.** One command can mean several runs. Comparison/fan-out phrasing produces one
object per combination the user actually means: "as Veda and as Marcus" / "compare Veda vs Marcus" →
2 runs sharing goal+url; "with each of my personas" → resolve via `list_personas`, one run per
persona (confirm the count first); two URLs ("on staging and on prod") → one run per URL.
Unmentioned fields are SHARED (one url + two personas → both objects carry that url); dimensions the
user didn't ask to cross are never multiplied. A single-intent command is simply a list of one.

**Persona resolution** (for every distinct persona intent; `list_personas` is called once and
reused): match the intent — name or description — against real personas; propose the match
conversationally before using it ("I found **<name>** (<one-line story>) — … Test with them, or
create a new persona?"); multiple plausible → show candidates and ask. **None plausible → create
from blank, right there**: one confirmation, then `create_persona` directly with the user's
description as `vibe_prompt` (plus whatever controls their words imply), skipping previews unless
asked — never dead-end the user into a separate command (`/archetype:persona` is only for the full
guided flow). Only a persona the user confirmed becomes `persona_id`; persona intent is never
silently dropped into the goal text, and candidates are never guessed between.

**Feature resolution**: a named feature that doesn't exist gets the same treatment — offer to create
it on the spot (`create_feature` with a title + one-line description distilled from the user's
words; ask only for what can't be inferred), then run with the new `feature_id`.

**Confirmation rules**: present the run list as a table (goal · url · persona · feature). A single
run with every field explicit and unambiguous → proceed straight away, stating the row. Anything
missing (a URL is required — never guessed), inferred, or fuzzy-matched → one compact question about
exactly those fields. **Multiple runs → always confirm the list once** before starting (each run
costs real minutes).

**Multi-run execution (step 2a).** Ensure the session is connected FIRST (intake's `list_personas`
self-heals auth in the main session; subagents cannot render the login modal). Then dispatch the
`feature-validator` agent once per run object with its resolved fields verbatim (goal, url,
`feature_id`, `persona_id` + the persona's name for sanity-checking), run **sequentially** — the
agents share one Chrome, parallel dispatch makes them fight over the browser. If a run returns the
"backend did not honor the persona" error (see [Persona guard](#persona-guard-in-start_run)), stop
remaining persona-selected runs and surface it once. Afterwards render a **comparison report**, not
N stacked reports: header row per run (persona · verdict · run id), scenario outcomes side by side,
findings split into "hit by all personas" vs "only <name> hit this", each persona's reaction quote,
and a `/archetype:check-run-status <run_id>` line per run.

**Single-run execution (steps 2–7).** Call `start_run` with `goal` (omit if running purely by
`feature_id`), `url` (required), optional `feature_id`, optional `persona_id`. The tool guards
persona selection: if the backend does not honor the requested persona, it returns an error instead
of a briefing — relay and stop. The result text is authoritative (mission brief, first-person
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
   pass a goal for extra free-text intent). Persona intent in `$ARGUMENTS` works here too via the
   validation skill's persona resolution.

### /archetype:list-features

Source: `skills/list-features/SKILL.md`. Calls `list_features` (with `$ARGUMENTS` as `query` if
given), renders a table of `id · title · updated` (`_id`, `title`, `updatedAt`). Empty result →
relay plainly and offer to create one on the spot (`create_feature`, one confirmation, title +
one-line description). Suggests `/archetype:validate-feature <title>` next. Never invents feature
ids or titles.

### /archetype:check-run-status

Source: `skills/check-run-status/SKILL.md`. Run-id resolution order: `$ARGUMENTS` → most recent run
id seen this session (from a `start_run`/`report_result`) → ask the user. Calls `get_run` with
`run_id`; reports **status + progress** (e.g. `running · 60%`), **analyticsReady**, and — if
present — the feedback verdict (`pass`/`fail`/`mixed`) + summary. If still `running`, suggests
re-checking with `/archetype:check-run-status <run_id>`. Reports only what `get_run` returns.

### /archetype:status

Source: `skills/status/SKILL.md`. One `status` tool call, no arguments, nothing else. Relays the
dashboard lightly formatted: Account / Token / Backend / Features lines as-is; recent runs as a
short list (run id · goal · outcome); portal URL as a clickable link labeled **Open Archetype
portal**. If "Not connected", suggests `/archetype:setup` — this skill is read-only and must not
call `login`, list features, or look up runs.

### /archetype:persona — dashboard + questionnaire creation

Source: `skills/persona/SKILL.md`. Two modes on `$ARGUMENTS`:

- **Empty → Dashboard.** `list_personas` (no arguments), rendered as **name · source · occupation ·
  story (one line)**. PersonaIds are deliberately hidden ("tool-plane noise") — an id column appears
  only if the user explicitly asks. Closes with the run hint
  `/archetype:validation "<goal>" url=<...> persona="<name>"`. Empty list → ask ONE question (create
  one now?) and branch to creation.
- **`new` or any free text → Creation flow.** Free text is raw material for the vibe prompt;
  questions it already answers are skipped. The questionnaire (asked one at a time, conversational):
  (1) who are they — role/occupation + a phrase of character; (2) age range — brackets 18–25 /
  26–35 / 36–50 / 50+ or custom; (3) tech-savviness — novice / comfortable / power-user /
  builds-their-own, mapped to `skills_range` roughly [10,35] / [35,65] / [65,85] / [80,100];
  (4) what they care about / what annoys them; (5) product context — one line, pre-proposed if the
  session already knows the target. Then compose a plain-English 2–3 sentence `vibe_prompt` (no
  key:value dumps) and call `create_persona` with `preview_only: true`, `preview_count: 2`, plus the
  mapped `age_range`, `skills_range`, `occupation`, `product_description`. Present both candidates
  side by side (name, vibe, story, need) as **directions** — the saved persona is regenerated along
  the chosen direction, not stored verbatim. On choice, call `create_persona` WITHOUT
  `preview_only`, same controls, vibe_prompt extended by the chosen candidate's summary ("... similar
  in spirit to: <vibeSummary>"). Relay the saved persona (name, story, need — no raw id).
- **Low-resistance shortcut.** A rich description (or "just make it") → offer to skip the remaining
  questions AND the preview round: one confirmation, then save directly. The full flow is guidance,
  never a gate.

Boundaries: only show personas/ids the tools returned; **one SAVE per flow** (`create_persona`
without `preview_only` at most once, after user confirmation — previews are free to repeat); warn
the user that generation is LLM-backed and can take up to a couple of minutes per call.

### feature-validator agent

Source: `agents/feature-validator.md`. The delegated/headless actor: one full validation cycle —
start run, become persona, drive Chrome, report — in a single invocation. Static tools: `Bash, Read,
Grep, Glob, ToolSearch, mcp__plugin_archetype_core__start_run,
mcp__plugin_archetype_core__report_result, mcp__plugin_archetype_core__get_run,
mcp__plugin_archetype_core__list_features`. Claude-in-Chrome tools are loaded at runtime via
ToolSearch (query `claude-in-chrome`).

**Dispatch contract.** The prompt should carry: the product URL (required — the agent asks rather
than guesses), a `goal` and/or `feature_id` (a named saved feature is resolved via `list_features`;
ambiguous → ask once, never guess an id), and optionally a **pre-resolved** `persona_id` plus the
persona's name — the agent carries it as-is and never invents or substitutes one. If `start_run`
reports the backend did not honor the requested persona, the agent surfaces the error verbatim and
stops.

**Why login can't happen inside it.** The `login` tool is deliberately absent from its tool list:
the login elicitation modal cannot render inside a subagent, so authentication must happen in the
main session before dispatch. On a "Not connected" error the agent tells the user to run
`/archetype:setup` in the main session and stops — it never fabricates a run.

**One-run boundary.** One run per invocation; runs come only from `start_run`, results only through
`report_result` with exactly one SUCCESSFUL call (retry on error, never re-send after success). It
follows the same operating procedure as the validation skill (persona adoption, new-tab browsing,
~3-minute scenario time-boxes, snake_case step log, camelCase `feedback` keys, blocked-scenario
handling for whole-run browser failure) and ends with a scenario verdict table, findings by
severity, persona quote, and run id, noting status can be re-checked via `get_run` /
`/archetype:check-run-status <run_id>`.

### SessionStart hook

Source: `hooks/hooks.json`. A single `SessionStart` hook with matcher `startup`, type `command`:

```
test -f "$CLAUDE_PLUGIN_DATA/auth.json" || echo 'archetype: not connected. Run /archetype:setup to get started.'
```

At session startup it checks for the saved token file at `${CLAUDE_PLUGIN_DATA}/auth.json`; if
absent, it injects the one-line nudge pointing the user at `/archetype:setup`. When the token file
exists, it prints nothing.

---

## MCP tools (server: `core`)

The server is a stdlib-only Python stdio MCP server at `scripts/core-server.py`, registered in
`.claude-plugin/plugin.json` under `mcpServers.core`
(`python3 ${CLAUDE_PLUGIN_ROOT}/scripts/core-server.py`). It reports itself as `archetype-core`
v`0.3.2` (protocol `2025-06-18`) and is the data plane between the actor LLM and the Archetype
backend — Claude never touches tokens or raw HTTP. Configuration comes from environment variables
(see [Environment variables](#environment-variables)).

**Timeouts:** default `HTTP_TIMEOUT = 15` s; `RUN_TIMEOUT = 180` s (run assembly runs a server-side
LLM chain, ~90 s tolerated); `RESULT_TIMEOUT = 60` s (multi-MB screenshot payloads; a client timeout
after server-side storage would surface as a confusing 409 on retry); `PERSONA_TIMEOUT = 180` s
(one server-side LLM call per preview candidate).

**Shared error rendering:** any non-2xx backend response becomes an `isError` text result via
`backend_error_text` — it prefers the backend's `message`, falls back to the `error` slug, then
`backend returned {status}`. A 401 always gets the login hint appended:
`Run /archetype:setup to log in.` Network failures map to status `0` with body
`{"error": "network_error", "message": ...}` and render through the same path. When `authed_call`
cannot obtain a token at all, the tool returns `Not connected. Run /archetype:setup to log in.`
(`isError`).

### The nine tools

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

#### `start_run`

Start a validation run: the backend assembles a persona-enriched instruction set that the actor
follows verbatim.

- **Arguments:**
  - `url` (string, **required**) — the product URL under test.
  - `goal` (string, optional) — what to test, e.g. `test the signup flow`.
  - `feature_id` (string, optional) — saved-feature `_id` from `list_features`.
  - `persona_id` (string, optional) — `personaId` from `list_personas`, to run AS that persona
    instead of the replay-derived one.
- **Backend:** `POST /api/plugin/runs` (timeout **180 s**), body keys camelCased (`goal`,
  `featureId`, `url`, `personaId`; `None` values dropped), via `authed_call`.
- **Result text:** the rendered briefing — backend `brief`, `— YOUR PERSONA —` + persona card,
  `— YOUR SCENARIOS —` (with `(goal: … · target: …)` when present), each scenario numbered as
  `[id] title` with `- step` lines and an `Expected:` line, `— CONDUCT RULES —`,
  `runId`/`sessionId`, and the full `report_result` contract (see
  [`report_result` payload contract](#report_result-payload-contract-in-full)).
- **Errors:** `not_connected()` when no token could be obtained; `backend_error_text` for non-2xx;
  the [persona guard](#persona-guard-in-start_run) can abort a *successful* response as `isError`.
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
    `screenshot_b64→screenshotB64`; all other keys pass through unchanged.
  - `feedback` (object, **required**) — passed through **untouched**; its nested keys must already
    be camelCase (`scenarioResults`, `evidenceStepSeq`, …) per the contract rendered by `start_run`.
  - `duration_seconds` (number, optional) — sent as `durationSeconds` only when provided.
- **Backend:** `POST /api/plugin/runs/{run_id}/results` (timeout **60 s**), via `authed_call`.
- **Result text:** the backend's `message` (default `Results stored.`) followed by
  `Steps: {n} · Findings: {n} · Verdict: {v}` from the response `summary` (missing values render as `?`).
- **Errors:** `not_connected()` / `backend_error_text`. On success, updates the local run log entry
  (verdict taken from response `summary.verdict`, falling back to the submitted `feedback.verdict`).

#### `get_run`

Read back a run's status, progress, and (if finished) feedback.

- **Arguments:** `run_id` (string, **required**).
- **Backend:** `GET /api/plugin/runs/{run_id}` (default **15 s**), via `authed_call`.
- **Result text:** `Run {runId}`, then `status: … · progress: …% · analyticsReady: …`, plus
  `verdict: … — {summary}` when the response contains `feedback`.
- **Errors:** `not_connected()` / `backend_error_text`.

#### `list_features`

List the user's saved features; each feature's `_id` is the `feature_id` for `start_run`.

- **Arguments:** `query` (string, optional) — case-insensitive **client-side** filter on feature
  titles (the backend call is unfiltered).
- **Backend:** `GET /api/features` (default **15 s**), via `authed_call`.
- **Result text:** one line per feature — `{_id}  {title}  (updated {updatedAt})` — followed by
  `Pass a feature's _id as feature_id to start_run to validate it.` Empty results:
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
- **Backend:** `POST /api/features` (default **15 s**), via `authed_call`. Body is
  `{"title": ..., "fields": {"description": ..., "expected-usage": ..., "strategic-goals": ...}}` —
  note the kebab-case field keys; missing fields are sent as empty strings.
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

#### `list_personas`

List the user's personas (replay-derived, vibe, custom) with `personaId`, source, occupation, and
story.

- **Arguments:** none.
- **Backend:** `GET /api/persona` (default **15 s**), via `authed_call`.
- **Result text:** `{N} persona(s):`, then per persona: `{name}  [{source}]` with `· {occupation}`
  and `· created {createdAt}` when present, the story truncated to 200 chars, and an indented
  `id: {personaId}` line. A footer shows the run-usage pattern
  (`/archetype:validation "<goal>" url=<...> persona="<name>"`) and instructs the actor to resolve
  names to ids for `start_run`'s `persona_id` without displaying ids to the user unless asked.
  Empty: `No personas yet. Create one with /archetype:persona — say 'new' and I'll walk you through
  a short questionnaire.`
- **Errors:** `not_connected()` / `backend_error_text`.

#### `create_persona`

Create a persona from a natural-language vibe prompt (plus optional demographic controls);
`preview_only=true` returns unsaved candidates instead of saving.

- **Arguments:**
  - `vibe_prompt` (string, **required**) — who they are, how they behave, what they care about;
    blank/missing returns an `isError` without a backend call.
  - `age_range` (array of numbers, optional) — `[low, high]`, e.g. `[28, 35]` → sent as
    `controls.ageRange`.
  - `skills_range` (array of numbers, optional) — `[low, high]` tech-savviness on a 0–100 scale →
    `controls.skillsRange`.
  - `occupation` (string, optional) → `controls.occupation`.
  - `education` (string, optional) → `controls.education`.
  - `product_description` (string, optional) — one-line product description used to derive the
    persona's need → `productDescription`.
  - `preview_only` (boolean, optional) — return unsaved candidates; sets `previewOnly: true`.
  - `preview_count` (number, optional) — how many previews (1–5, default **2**); sent as
    `previewCount` only in preview mode.
- **Backend:** `POST /api/persona/vibe` (timeout **180 s**), via `authed_call`; body always includes
  `mode: "vibe"` and `vibePrompt`; `controls` is included only if at least one control was given.
- **Result text:** *preview mode* — `{N} persona preview(s) — directions, not saved yet…`, each
  candidate with name, `vibe:` summary, story (truncated to 300 chars), and `need:`, plus
  instructions to call `create_persona` again without `preview_only`, folding the chosen candidate's
  summary into `vibe_prompt`. *Save mode* — `Persona saved: {name}`, story (300 chars), `Need: …`,
  the run-usage line with `persona="{name}"`, and
  `(id for tool calls only, not for display: {personaId})`.
- **Errors:** local `vibe_prompt` validation, then `not_connected()` / `backend_error_text`.

### Self-healing auth (`authed_call`)

Every backend-touching tool except `login` and `status` wraps its HTTP call in `authed_call(do_call)`:

1. **Load token** — `load_token()` reads `access_token` from `${CLAUDE_PLUGIN_DATA}/auth.json`
   (returns `None` on missing env var, missing file, or unparseable JSON).
2. **Missing token** → run `perform_device_login()` inline (the same elicitation-modal device flow
   as `login`). If that fails or the user declines, `authed_call` returns `None` and the caller
   renders `Not connected. Run /archetype:setup to log in.` (`isError`).
3. **Call once.** If the backend answers **401** → re-login once via the same inline flow, and if a
   new token is obtained, **retry the call exactly once**. If re-login fails, the original 401 is
   returned and rendered by `backend_error_text` with the login hint appended.

Opt-outs: **`login`** is the flow itself (it validates the cached token via
`existing_token_is_valid`, then runs the device flow), and **`status`** is deliberately read-only —
its docstring says "Reports state; never triggers login" — so a broken token renders as a dashboard
line instead of a modal. One consequence for skills and agents: the login elicitation modal can only
render in the main session, so multi-run dispatch must ensure the session is connected before
spawning the `feature-validator` agent, which does not carry the `login` tool at all.

### Persona guard in `start_run`

After a 2xx response, if the caller passed `persona_id` but the response's `persona.personaId` does
not match it, the run is aborted with an `isError` result *before* the briefing is rendered or the
run log is written. Rationale (from the code comment): an outdated backend silently ignores unknown
fields, which would brief the actor as the wrong persona. The error text names both ids
(`asked for {requested}, got {returned or 'none'}`), suggests deploying the current backend or
retrying without `persona=` to use the replay-derived persona, and warns:
`Do NOT act on this run; a stray run doc ({runId}) may exist server-side.`

### Local run log

- **Path:** `${CLAUDE_PLUGIN_DATA}/runs.json` (per-machine; cross-device history lives in the
  portal). Best-effort only — write failures are logged to stderr, never fatal.
- **On `start_run` success** (`record_run_start`): appends
  `{run_id, session_id, goal, url, feature_id, persona_id, started_at}` (`started_at` is epoch
  seconds; `None` values dropped). `run_id`/`session_id` come from the response; the rest from the
  tool arguments.
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
3. Best-effort `webbrowser.open(verify_url)` (silently tolerated on headless boxes), then a
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
- `User-Agent`: `archetype-claude-plugin/0.3.2` (override via `ARCHETYPE_PLUGIN_USER_AGENT`).
  Required — the Cloudflare WAF in front of the API returns HTTP 403 (error 1010) for the default
  Python-urllib UA.
- Timeouts: as listed under [MCP tools](#mcp-tools-server-core) — 15 s default, 180 s for
  `POST /api/plugin/runs` and `POST /api/persona/vibe`, 60 s for results ingestion.
- Network failures are mapped client-side to status `0` with body
  `{"error": "network_error", "message": ...}`.

### Endpoint table

| Method | Path | Auth | Called by (MCP tool) | Request body (as sent by plugin) | Success response |
|---|---|---|---|---|---|
| POST | `/api/oauth/device/code` | none | `login` / self-healing path | `{}` | 200 — Auth0 device-code response verbatim: `device_code`, `user_code`, `verification_uri`, `verification_uri_complete`, `expires_in`, `interval` (URIs may be rewritten to a branded `DEVICE_AUTH_PUBLIC_BASE` domain) |
| POST | `/api/oauth/device/token` | none | `login` / self-healing path (polled) | `{"device_code": "<...>"}` | 200 — `access_token`, `token_type`, `expires_in`, `scope`, `refresh_token?`, `id_token?`. While pending, Auth0's 403 with `error: "authorization_pending"` (keep polling) or `"slow_down"` (plugin adds 2 s to the poll interval) |
| POST | `/api/oauth/validate-token` | Bearer | `login`, `status` | `{}` (token in header) | 200 — `{"valid": true, "user_id", "audience", "issuer", "expires_at", "issued_at", "scope", "payload"}`; invalid token → 401 `{"valid": false, "error": "invalid_token", "reason"}`; no token → 400 `{"valid": false, "error": "missing_token"}` |
| POST | `/api/plugin/runs` | Bearer | `start_run` | `{"goal", "featureId", "url", "personaId"}` — plugin maps `feature_id`→`featureId`, `persona_id`→`personaId`; `None` fields dropped; only `url` is required tool-side | 201 — run body: `runId`, `sessionId`, `brief`, `persona{personaId, personaCard, ...}`, `instructions{goal, targetUrl, scenarios[{id, title, steps[], expectedResult}], conduct[]}` |
| POST | `/api/plugin/runs/<run_id>/results` | Bearer | `report_result` | See full contract below | 200 — `{"message": "<confirmation>", "summary": {"steps": n, "findings": n, "verdict": "..."}}` |
| GET | `/api/plugin/runs/<run_id>` | Bearer | `get_run` | — | 200 — `{"runId", "status", "progress", "analyticsReady", "feedback"?: {"verdict", "summary"}}` |
| GET | `/api/features` | Bearer | `list_features`, `status` (feature count) | — | 200 — `{"ok": true, "features": [{"_id", "title", "updatedAt", ...}]}`; a feature's `_id` is the `feature_id` for `start_run`. (The `query` title filter on `list_features` is applied client-side, not a query param.) |
| POST | `/api/features` | Bearer | `create_feature` | `{"title", "fields": {"description", "expected-usage", "strategic-goals"}}` — plugin maps `expected_usage`→`expected-usage`, `strategic_goals`→`strategic-goals`; missing fields sent as `""` | 201 — `{"ok": true, "feature": {"_id", "title", ...}}` |
| GET | `/api/persona` | Bearer (401 on bad token — never degrades to anonymous listing, which would break self-healing) | `list_personas` | — | 200 — `{"personas": [{"personaId", "name", "story", "createdAt", "source", "demographics": {"occupation", ...}, "psychographics", "behavioralTraits", "goalsMotivations", "painPoints", "preferredChannels", "controls", "preview", ...}]}` |
| POST | `/api/persona/vibe` | Bearer | `create_persona` | `{"mode": "vibe", "vibePrompt", "controls"?: {"ageRange", "skillsRange", "occupation", "education"}, "productDescription"?, "previewOnly"?: true, "previewCount"?: n}` — plugin maps `vibe_prompt`→`vibePrompt`, `age_range`→`controls.ageRange`, `skills_range`→`controls.skillsRange`, `product_description`→`productDescription`, `preview_only`→`previewOnly`, `preview_count`→`previewCount` (default 2 when previewing) | Preview: 200 — `{"examples": [{"name", "vibeSummary", "story", "personaNeed", ...}]}` (unsaved). Save: 201 — persona summary incl. `personaId`, `name`, `story`, `personaNeed` |

The backend also exposes `POST /api/plugin/replay/sessions` (body
`{"sessions": [{sessionId?, events, meta?}], "source"?: "upload"}` → 200
`{"ok", "ingested", "poolSize"}`), plus feature `GET/PUT/DELETE /api/features/<id>`, persona
`manual` mode, `/api/persona/custom`, pool routes, and `GET /api/oauth/me` — none of which the
plugin's MCP server calls.

### snake_case → camelCase mapping

The MCP tool surface is snake_case (actor-facing); the wire format is camelCase (backend). The
server performs the mapping:

- **`start_run` top level:** `feature_id`→`featureId`, `persona_id`→`personaId` (`goal`, `url`
  unchanged).
- **`report_result` top level:** `session_id`→`sessionId`, `duration_seconds`→`durationSeconds`
  (only included when provided); `status`, `steps`, `feedback` keys unchanged.
- **`report_result` per-step** (`_STEP_KEY_MAP`): `action_text`→`actionText`,
  `observation_page_type`→`observationPageType`, `scenario_id`→`scenarioId`,
  `screenshot_b64`→`screenshotB64`. All other step keys (`seq`, `narration`, `url`, `success`,
  `error`) pass through unchanged.
- **`report_result` `feedback` is passed through untouched** — its nested keys must already be
  camelCase (`scenarioResults`, `evidenceStepSeq`, …) per the contract rendered by `start_run`.
- **`create_persona`:** `vibe_prompt`→`vibePrompt`, `age_range`→`controls.ageRange`,
  `skills_range`→`controls.skillsRange`, `product_description`→`productDescription`,
  `preview_only`→`previewOnly`, `preview_count`→`previewCount`.
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
  - `findings[]`: `{scenarioId, category: bug | ux | content | performance | other, severity: critical | high | medium | low, description, evidenceStepSeq}`
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
                             "description": "...", "evidenceStepSeq": 3}],
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
| 502 | `persona_generation_failed` | Upstream LLM fault during run assembly/results/read-back; the message states no run was created (or results were not stored) and that it is **safe to retry** in a moment. Distinct from `PluginRunError` — mapped to its own branch server-side. |
| 500 | `internal_error` | "Safe to retry" NL message. |
| 0 | `network_error` (client-synthesized) | Backend unreachable; `status` dashboard reports "backend unreachable". |

One non-HTTP guard sits on top of the contract: the
[persona guard in `start_run`](#persona-guard-in-start_run), which aborts after a 2xx if the
response's `persona.personaId` does not match the requested `persona_id`.

---

## Configuration, data, and distribution

### Environment variables

All configuration is read by the `core` MCP server (`scripts/core-server.py`) at startup. The server
inherits the environment of the Claude Code CLI, so export these **before** launching `claude`.

| Variable | Default | Effect |
| :--- | :--- | :--- |
| `ARCHETYPE_BACKEND_URL` | `https://api.syntheticarchetype.com` | Base URL for every backend call (device-flow OAuth, `/api/plugin/*`, `/api/features`, `/api/persona`). Trailing slashes are stripped. Set to `http://localhost:5001` for local backend development. |
| `ARCHETYPE_PORTAL_URL` | `https://www.syntheticarchetype.com` | Portal link rendered in the `/archetype:status` dashboard. Trailing slashes are stripped. |
| `ARCHETYPE_PLUGIN_USER_AGENT` | `archetype-claude-plugin/<server version>` (currently `archetype-claude-plugin/0.3.2`, from the `SERVER_VERSION` constant in `core-server.py`) | HTTP `User-Agent` sent on every backend request. The Cloudflare WAF in front of `api.syntheticarchetype.com` returns HTTP 403 (error 1010) for the default Python-urllib UA; any real, identifiable UA passes. If you override this and hit a 1010, switch back to the default. |
| `CLAUDE_PLUGIN_DATA` | *(set by Claude Code)* | Directory holding `auth.json` (credentials) and `runs.json` (run log); see below. |

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
- **Live E2E:** the operator runbook is `e2e/RUNBOOK.md`. An outer orchestrator session drives an
  inner Claude Code session in tmux (session name `archetype-e2e`, helpers in `e2e/tmux.sh`,
  override via `E2E_SESSION`) through the real Auth0 device flow, a Chrome-driven validation of the
  demo app at `http://localhost:8321`, and backend verification via `e2e/verify_backend.py`.
  Artifacts land in `e2e/artifacts/` (gitignored); steps map to acceptance criteria A1–A5, B1–B2, C
  in `docs/GOAL_AND_TEST_CRITERIA.md`.

### Manifests

**`.claude-plugin/plugin.json`** (the only file that belongs inside `.claude-plugin/` — skills,
hooks, and agents live at the plugin root):

| Field | Value |
| :--- | :--- |
| `name` | `archetype` |
| `description` | `Plugin for Run Feature Validation Testing through Synthetic Archetype` |
| `version` | `0.3.6` |
| `author.name` | `Synthetic Archetype` |
| `mcpServers.core` | `{"type": "stdio", "command": "python3", "args": ["${CLAUDE_PLUGIN_ROOT}/scripts/core-server.py"]}` — the MCP server is declared inline, no separate `.mcp.json` |

**`.claude-plugin/marketplace.json`** (makes the repo double as its own single-plugin marketplace):

| Field | Value |
| :--- | :--- |
| `name` | `archetype` (the marketplace name — hence `archetype@archetype`) |
| `owner.name` | `Synthetic Archetype` |
| `plugins[0].name` | `archetype` |
| `plugins[0].source` | `{"source": "url", "url": "https://github.com/MCxiaoguu/Archetype_Plugin.git"}` |
| `plugins[0].description` | `Testing your product with synthetic personas` |

---

Verified against plugin version 0.3.6 (`.claude-plugin/plugin.json`, server `archetype-core` 0.3.6) on 2026-08-03.
