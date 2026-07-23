# Plugin ↔ Backend Pipeline — Design Spec

Date: 2026-07-22 · Status: user-approved design (sections 1–3 approved in
brainstorming) · Repos: `Archetype_Plugins` (this repo) and
`../Archetype_Core/Archetype_Backend`.

Companion documents: `docs/GOAL_AND_TEST_CRITERIA.md` (acceptance criteria),
`docs/E2E_HARNESS_NOTES.md` (verified tmux/Chrome/vision harness playbook),
`docs/notes/*.md` (subsystem maps with file:line references).

## 1. Summary

The Claude Code plugin becomes the **actor** of the Archetype pipeline: it
fetches a **persona-enriched instruction set** from the backend, drives Chrome
via Claude-in-Chrome as that persona against the product under test, and posts
structured results back. The backend gains the **proprietary pipeline**:
session-replay ingestion (rrweb format, dummy fixtures for now) → behavioral
parsing → LLM persona generation (existing generator) → instruction assembly →
result ingestion into the existing `session_log`/analytics/test machinery.

User-approved decisions:

| Decision | Choice |
| :--- | :--- |
| Dispatch model | Pull on demand — plugin initiates; **no polling**: `POST /api/plugin/runs` is synchronous (the MCP server tolerates 60–90 s on first run) |
| Results storage | Full reuse of validation tests: run = `Archetype_Test.test` doc; steps = `Archetype_Test.session_log` via existing `log_result` helpers |
| Fleet/live events | Out of scope now (monitor works post-hoc from `session_log`) |
| Frontend | Completely isolated from the plugin path; replay ingestion is fully automatic (auto-seed), no human intervention |
| Dummy replay data | Faithful rrweb `eventWithTime[]` shape (PostHog blob_v2 style, uncompressed), real minimal parser |
| E2E target | Local demo product page ("Lumina Notes", `localhost:8321`) |
| Wizard in scope | Plugin device-flow login wizard only (vision-verified); frontend onboarding wizard is future work |

## 2. Backend contract (new blueprint `api/routes_plugin.py`, mounted at `/api/plugin`)

All routes `@require_auth` (device-flow Bearer tokens already validate there);
every query scoped by `request.user_id`. No new env vars — `MONGODB_URI`,
`GEMINI_API_KEY` already in the backend `.env`.

### 2.1 `POST /api/plugin/runs` — create + assemble a run (synchronous)

Request:

```jsonc
{
  "goal": "test the signup flow",   // required unless featureId given
  "featureId": "<User.features _id>",  // optional; goal derived from feature fields if omitted
  "url": "http://localhost:8321"       // required: the product under test
}
```

Pipeline inside the handler (`services/plugin_run_service.py`):

1. **Ensure replay pool.** `Replay.sessions` for this `user_id`; if empty,
   auto-seed the bundled dummy fixtures (`data/dummy_replays/*.json`) through
   the same ingestion+parse path a real upload will use
   (`source: "dummy-autoseed"`). This is the stand-in for the future
   onboarding upload; replacing it later changes nothing downstream.
2. **Ensure parse.** Each session doc stores a `behavior_summary` (see §3.2);
   parse happens at ingest time, so this is a no-op for existing docs.
3. **Ensure persona.** Look up `Persona.user_personas` where
   `source == "replay"` and `replay_pool_hash` matches the current pool hash
   (sha256 over sorted `replay_session_id` + `ingested_at`). On miss: build a
   text digest of all behavior summaries → call the existing MVP generator
   `persona/generator.py::generate_persona(...)` (keyword-only signature; pass
   `user_description=digest`, `need=<user intent inferred from the digest,
   fallback "evaluate whether this product fits my workflow">`,
   `start_url=<the run's target url>`) (4 Gemini
   calls, ~30–60 s) → persist the **full** generator output (including
   `generated_episodes`/`generated_chunks`, fixing the known persistence gap)
   plus `user_id`, `source: "replay"`, `replay_pool_hash`,
   `replay_session_ids`. Persona is a durable derived asset: regenerated only
   when the pool changes.
4. **Create the run doc** in `Archetype_Test.test`: `status: "running"`,
   `total_sessions: 1`, `test_meta: {validation_type: "plugin",
   actor: "claude-plugin", url, goal, feature_info?, persona_pool:
   [persona_id], plugin_session_id}`. Session id format: `plugin-<12hex>`.
5. **Assemble the instruction set**: persona card via existing
   `contract_from_persona` → `render_seed_card` (pure functions); 2–4 test
   scenarios from goal/feature via **one** Gemini call (deterministic template
   fallback if the LLM call fails); explicit reporting requirements.

Response `201`:

```jsonc
{
  "runId": "<test_id>",
  "sessionId": "plugin-a1b2c3d4e5f6",
  "brief": "<natural-language mission briefing for the actor LLM: who you are, what you're testing, what good reporting looks like — authored server-side so actor guidance is centrally controlled>",
  "persona": {
    "personaId": "...", "name": "...", "story": "...",
    "personaCard": "<first-person seed-card text>",
    "traits": {"impatience": 0.7, "...": 0.0}, "personaNeed": "..."
  },
  "instructions": {
    "targetUrl": "http://localhost:8321",
    "goal": "test the signup flow",
    "scenarios": [
      {"id": "SC-1", "title": "...", "steps": ["..."], "expectedResult": "..."}
    ],
    "conduct": ["Act with this persona's patience and skill level", "Stay on the target site", "Narrate each step", "..."]
  },
  "reporting": {
    "resultsEndpoint": "/api/plugin/runs/<runId>/results",
    "requiredFields": ["sessionId", "status", "steps", "feedback"]
  }
}
```

Errors: `400` missing goal+featureId or url · `401` invalid token · `502`
`persona_generation_failed` (LLM hard failure on first run; message tells the
user to retry) · `500` unexpected.

### 2.2 `POST /api/plugin/runs/<run_id>/results` — ingest actor results

Request:

```jsonc
{
  "sessionId": "plugin-a1b2c3d4e5f6",   // must match the run
  "status": "completed" | "failed" | "aborted",
  "durationSeconds": 312,
  "steps": [
    {"seq": 1, "scenarioId": "SC-1", "actionText": "clicked Start free trial",
     "narration": "<persona-voice note>", "url": "...",
     "observationPageType": "landing", "success": true,
     "error": null, "screenshotB64": "<optional, ≤1 MB, ≤6 total>"}
  ],
  "feedback": {
    "verdict": "pass" | "fail" | "mixed",
    "summary": "...",
    "scenarioResults": [{"scenarioId": "SC-1", "status": "pass|fail|blocked", "actualResult": "..."}],
    "findings": [{"scenarioId": "SC-1", "category": "bug|ux|content|performance|other",
                   "severity": "critical|high|medium|low", "description": "...",
                   "evidenceStepSeq": 4}],
    "personaReaction": "<first-person quote>"
  }
}
```

Handler behavior: ownership + `sessionId` check → `409` if the test is already
`completed`; a re-POST after `failed` is allowed and treated as a retry
(previous session_log doc superseded) → write steps through the existing
`simulation_core/log_result.py` helpers (`start_session_log` / `log_step` /
`finalize_session_log`; pinned kwargs for the plugin path:
`headless=False, record_video=False, video_format="none"`) so `session_log`
docs are shaped exactly like notte runs (monitor snapshot + replay +
analytics all keep working). `status: "aborted"` maps to test status
`failed` with `error: "aborted by actor"` → store
`feedback` on the test doc (`results.plugin_feedback`) and as
`Archetype_Test.feedback` docs → best-effort `run_post_session_analytics(session_id)`
and rollup → set test `status` (`completed`/`failed`), `progress: 100`,
`completed_at`.

Response `200`: `{ok: true, runId, testStatus, message: "<NL confirmation for
the actor LLM: what was stored, what happens next, where results live>",
summary: {steps, findings, verdict}}`.

**LLM-consumer principle (applies to every `/api/plugin` response):** the
caller is Claude inside the inner session, so responses carry natural-language
fields (`brief`, `message`, per-scenario `expectedResult` prose, `conduct`
rules) alongside structured JSON. The MCP tools render these NL fields
verbatim in the tool result text; the plugin skills instruct Claude to treat
them as authoritative guidance. Error bodies likewise include a plain
`message` telling the actor what to do next.

### 2.3 `GET /api/plugin/runs/<run_id>`

Status/results readback for the `check-run-status` skill:
`{runId, status, progress, createdAt, completedAt?, feedback?, analyticsReady: bool}`.

### 2.4 `POST /api/plugin/replay/sessions` — explicit ingestion (optional path)

`{source: "upload"|"dummy", sessions: [{sessionId?, events: [<rrweb eventWithTime>], meta?}]}`
→ validates, stores, parses each session → `{ok, ingested, poolSize}`. The
auto-seed path calls the same service function. Size guard: reject a session
whose raw events exceed 8 MB (Mongo 16 MB doc limit headroom).

## 3. Backend internals

### 3.1 New modules

```
Archetype_Backend/
├── api/routes_plugin.py            # blueprint, request validation, HTTP mapping (new domain)
├── services/plugin_run_service.py  # run orchestration + result ingestion (new domain)
├── services/persona_service.py     # EXTENDED in place: replay-persona functions
├── services/replay/
│   ├── __init__.py
│   ├── ingest.py                   # store + validate sessions, pool hash
│   ├── parser.py                   # rrweb → behavior_summary
│   └── fixtures.py                 # auto-seed loader
└── data/dummy_replays/             # 3 handcrafted rrweb sessions (JSON)
```

Reuse-first: new files exist only for the genuinely new replay domain and the
plugin-run orchestration; persona persistence, LLM plumbing, result logging,
analytics, finalization, and watchdog are all existing modules extended or
called, never duplicated.

`app.py` registers the blueprint in the existing list (silent-skip import
pattern preserved).

### 3.2 rrweb parser (`services/replay/parser.py`)

Per `archetype_frontend/docs/posthog_ref.md` §4–§7:

- Inflate `cv: "2024-10"` gzip fields when present (fixtures are uncompressed).
- Build the node mirror from FullSnapshot (`id → {tagName, attributes, text,
  parent}`); apply Mutation `adds`/`removes`/`attributes` in timestamp order.
- Extract into `behavior_summary`:

```jsonc
{
  "durationMs": 27000,
  "pages": [{"href": "/", "dwellMs": 9000}, {"href": "/plans", "dwellMs": 6000}],
  "clicks": [{"t": 3210, "tag": "button", "text": "Start free trial", "id": "cta-trial", "page": "/"}],
  "inputs": {"count": 5, "fields": ["name", "email"]},
  "scrolls": 12, "mouseTravel": "high|medium|low",
  "friction": {
    "rageClicks": [{"targetId": "cta-trial", "count": 4, "windowMs": 900}],
    "hesitations": [{"beforeClickOn": "signup-submit", "gapMs": 8200}],
    "backtracks": [{"from": "/plans", "to": "/"}]
  },
  "consoleErrors": ["..."], "viewport": {"w": 1440, "h": 900},
  "parserVersion": 1
}
```

Friction heuristics: rage-click = ≥3 MouseInteraction clicks on one node id
within 1 s; hesitation = >5 s gap with mousemove but no interaction before a
click; backtrack = revisiting a previous `$pageview` href within the session.

### 3.3 Persona digest & generation

Digest renders each session's summary as compact prose (journey, dwell,
friction moments, viewport/device hint) concatenated across the pool, capped
~2000 tokens. Passed as `user_description` to `generate_persona`. Persisted
via the existing `_persist_persona_doc`, **extended in place** with an opt-in
`include_generator_fields: bool = False` parameter (default preserves current
callers exactly) that additionally persists `generated_episodes`,
`generated_chunks`, `self_description`, `browsing_habits`, `starting_mood`,
`start_url` plus the provenance fields `{source: "replay", replay_pool_hash,
replay_session_ids}` — fixing the known field-dropping gap at its source
rather than adding a parallel insert path. The replay-persona functions
(`build_digest`, `ensure_replay_persona`) live in `services/persona_service.py`,
the canonical persona service.

### 3.4 Mongo data models (new/extended)

- **`Replay.sessions`** (new DB/collection): `{replay_session_id, user_id,
  source, ingested_at, events: [...], event_count, duration_ms,
  behavior_summary, parser_version, isDeleted}`. Indexes: `replay_session_id`
  unique; `(user_id, isDeleted)`.
- **`Persona.user_personas`**: existing collection, new fields as §3.3.
- **`Archetype_Test.test` / `session_log` / `feedback`**: existing shapes,
  written through existing helpers; `test_meta.validation_type: "plugin"`
  distinguishes plugin runs.

### 3.5 Dummy fixtures (`data/dummy_replays/`)

Three sessions telling one coherent behavioral story against the demo
product's real DOM (§5): a price-sensitive, skimming user who (1) rage-clicks
the sluggish trial CTA, (2) hunts for pricing behind the ambiguous nav label
and backtracks, (3) starts signup, hits the form-wipe flaw, hesitates, and
abandons. ~40–80 events each: Meta → FullSnapshot (simplified demo-app DOM) →
MouseMove/MouseInteraction/Scroll/Input incrementals → Custom `$pageview`
navs → console-error Plugin event.

## 4. Plugin design (`Archetype_Plugins/`)

### 4.1 MCP server (`scripts/setup-server.py`, name `archetype-setup` unchanged)

Grows from 1 tool to 5. All tools read the Bearer token from
`${CLAUDE_PLUGIN_DATA}/auth.json`; any 401 → error text "Run
`/archetype:validation` to log in." HTTP stays in Python — Claude never
handles tokens or raw JSON over Bash.

| Tool | Input | Behavior |
| :--- | :--- | :--- |
| `login` | `{}` | unchanged (device flow + elicitation) |
| `start_run` | `{goal?, feature_id?, url}` | `POST /api/plugin/runs`, timeout 180 s; renders persona card + scenarios + reporting requirements as tool text |
| `report_result` | `{run_id, session_id, status, duration_seconds?, steps, feedback}` | client-side sanity checks, `POST .../results`, returns confirmation summary |
| `get_run` | `{run_id}` | `GET /api/plugin/runs/<id>` |
| `list_features` | `{query?}` | `GET /api/features` (Bearer), renders table data |

### 4.2 Skills

- **`validation`** (router, rewritten): no args → `login`. With args → full
  run flow: `start_run` → **adopt the persona** (read card aloud in summary) →
  load Claude-in-Chrome tools → drive the target site through each scenario
  *as the persona*, keeping per-step notes `{seq, scenarioId, actionText,
  narration, url, observationPageType, success}` → `report_result` → render
  the local summary (scenario verdict table, findings with severity, persona
  quote, run id + how to re-check).
- **Casing note:** actor-facing step keys are snake_case at the MCP tool
  boundary (`scenario_id`, `action_text`, `observation_page_type`,
  `screenshot_b64`); the MCP server maps them to the backend's camelCase — the
  camelCase step shapes in §2.2 are the backend wire format, not what the
  actor writes.
- **Persona-conduct rules** (embedded in the skill): act at the persona's
  patience/skill/reading level; narrate in persona voice; stay on the target
  site; time-box each scenario (~3 min); on a blocking failure mark the
  scenario `blocked` and continue; never fabricate steps or results.
- **`validate-feature`**: feature-first entry — resolve feature via
  `list_features`, then same run flow.
- **`list-features`** / **`check-run-status`**: thin wrappers over their
  tools.
- **`agents/feature-validator.md`**: updated to the same contract (may be used
  for headless orchestration later; not on the E2E critical path).
- **Hook**: SessionStart auth-file check unchanged.

### 4.3 Cleanup

Remove the dead `ARCHETYPE_PORTAL_URL`/`ARCHETYPE_API_KEY`/`.mcp.json` scheme
from skills; single auth scheme = device-flow Bearer via MCP server. Bump
plugin version to 0.1.0 and align server version.

## 5. Demo product (`demo-app/`)

"Lumina Notes" — static fake SaaS (indigo branding, product name prominent for
vision verification), no build step, served with `python3 -m http.server 8321`
(wrapped in `demo-app/serve.sh`). Single page + anchors (`/#plans`,
`/#signup`) with SPA-style pageview pushes. Planted deterministic flaws:

1. `#cta-trial` button: 900 ms artificial delay, no loading state.
2. Pricing behind ambiguous nav label "Plans & More".
3. `#signup-form`: validation error wipes all fields.

Stable element ids are shared with the rrweb fixtures (§3.5).

## 6. Error handling

| Failure | Behavior |
| :--- | :--- |
| Expired/missing token | Tools return "run login" error; wizard re-runs (existing) |
| Persona LLM failure (first run) | `502 persona_generation_failed`, run doc not created; retry safe |
| Scenario LLM failure | deterministic template fallback (never blocks a run) |
| Plugin dies mid-run | test stays `running`; existing watchdog sweeps stale tests |
| Duplicate result POST | `409` after test completed; retry allowed after `failed` |
| Oversized payloads | per-screenshot 1 MB / 6-screenshot cap (≈6 MB worst case, safe under Mongo's 16 MB doc limit alongside step text); 8 MB replay session cap |
| Redis absent | unaffected (no event-bus dependency in this path) |
| Analytics failure post-ingest | best-effort: results remain, `analyticsReady: false` |

## 7. Testing

Backend (`_tests/`, repo conventions — real services, no mocks): parser unit
tests (fixtures → expected summaries, pure); plugin-run service tests (tier 2
Mongo + tier 1 Gemini); endpoint tests via Flask client with `DEV_MODE=1`
X-User-Id bypass (ensure `FLASK_ENV` is not `production` in the test env —
the bypass is dual-gated); result-ingestion round-trip asserting
`session_log` shape compatibility (monitor snapshot builds from it).

Implementation should be phased so each phase is independently testable:
parser + fixtures → replay/persona services + routes → plugin tools + skills
→ demo app → E2E harness.

End-to-end (the acceptance gate — `docs/GOAL_AND_TEST_CRITERIA.md` A1–A5,
B1–B2, C; harness verified in `docs/E2E_HARNESS_NOTES.md`):

1. Start backend `:5001` (Atlas + Gemini via `.env`) and demo app `:8321`.
2. Launch inner Claude Code in tmux: `claude --plugin-dir <plugin>` with
   `ARCHETYPE_BACKEND_URL=http://localhost:5001`.
3. `/archetype:validation` → elicitation wizard renders → screenshot (A3).
   Auth0 approval leg driven by the outer session's Chrome (verified: both
   sessions can hold connections; only the inner session touches Chrome
   during the test) — user is the one-time fallback if an Auth0 login form
   blocks automation.
4. `/archetype:validation "test the signup flow" url=http://localhost:8321` →
   real run; outer session captures Chrome screenshots periodically (A4).
5. Verify Mongo after completion: `Replay.sessions` (seeded+parsed),
   `user_personas` (replay persona), `test` (completed), `session_log`
   (steps), `feedback` docs (B1–B2); backend logs monitored throughout.
6. Vision subagent reads all screenshots → structured verdict on wizard,
   Chrome activity, and feedback correctness (C). Prerequisite: Screen
   Recording permission granted to the terminal app.

## 8. Out of scope (recorded future work)

Live fleet events for the web monitor · frontend replay-upload onboarding
wizard · real PostHog snapshot-API ingestion (parser already speaks the
format) · token refresh (re-login on expiry for now) · multi-persona pools
per run · trained (non-LLM) persona models.
