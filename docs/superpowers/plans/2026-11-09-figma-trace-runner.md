# Figma Trace Runner Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persona tests run inside the Archetype Figma plugin. A prototype engine in the panel walks the flow; the backend brain picks each action through an asynchronous turn API. Runs are recorded like browser runs.

**Architecture:** The spec is `docs/superpowers/specs/2026-11-09-figma-trace-runner-design.md`. **Read it first; it is the source of truth for every behavior below.** The work splits into three parts:
- **Backend (Flask + Celery):** gains turn, abort and claim-owner support, a `trace` Celery queue and a vision brain.
- **Plugin panel:** gains a pure engine (`lib/proto/*`) and a session/runner (`ui/trace/*`).
- **Plugin main thread:** gains a reader and a renderer (`main/protoReader.ts`, `main/renderer.ts`).

**Tech Stack:**
- **Backend:** Python 3.13, Flask, Celery, the in-memory Mongo fake (`_tests/study_fakes.py`), Gemini via `LLMClient.query_multimodal`.
- **Plugin:** TypeScript, Preact, esbuild and Vitest for the Figma plugin; `tests/fake-figma.ts` for the Plugin API.

---

## Ground rules for every task

- **Worktrees:**
  - **Backend:** `…/scratchpad/trace/backend`, branch `feat/figma-trace-runner`, based on `origin/main`.
  - **Plugin:** `…/scratchpad/trace/plugin`, branch `feat/figma-trace-runner`, based on `origin/main`.
- **TDD:** write the failing test, see it fail for the right reason, implement, see it pass, commit. One commit per task. Match each repo's commit style: a plain imperative subject, a short body, and the trailer `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- **No hidden fallbacks** (the user's rule). A failure raises, returns the specified error, or is surfaced with a flag. Never `except: pass`, and never a silent default for data that must exist.
- **Tests that matter.**
  - Test behavior through public interfaces. Don't add tests that only restate types or check that something compiles.
  - Each task lists the cases that must exist; add more only when they catch a real failure mode.
  - The end-to-end tests in Chunk 5 are the main safety net.
- **Check suites:**
  - **Backend:** append every new backend test file to the multi-line `run:` of the "Pure tests" step in `.github/workflows/ci.yml`. To run the whole list, extract the `_tests/*.py` paths from that step:
    ```
    python3 -c "import yaml;w=yaml.safe_load(open('.github/workflows/ci.yml'));[print(t) for j in w['jobs'].values() for s in j['steps'] if s.get('name')=='Pure tests' for t in s['run'].split() if t.startswith('_tests/')]" > /tmp/pure.txt && xargs uv run python -m pytest -q -p no:cacheprovider < /tmp/pure.txt
    ```
    Then run `uv run python -m compileall -q -x '/\.venv/' .`
  - **Plugin:** run `cd figma && npm test` (Vitest) after each task, and `npm run typecheck && npm run build && npm run check:manifest` once per chunk, not per task.
  - **Plugin Python suite:** only for tasks that touch `scripts/`. Run it with `< /dev/null`, because a test spawns an MCP server that reads stdin.
- **Model routing** (from the plugin repo's `.claude/CLAUDE.md`): Fable orchestrates, Opus takes the engine, renderer, turn service and brain tasks (marked **[opus]**), and Sonnet takes the rest (marked **[sonnet]**).

## File map

**Backend (`backend/`)**

| File | Status | Responsibility |
|---|---|---|
| `services/study_service.py` | modify | `execution: "plugin"`, the `figma.file_name` and `figma.page_name` fields, a null `task.url` in plugin mode, and the `list_studies` filters |
| `services/plugin_run_service.py` | modify | the `figma-trace` engine, claim `owner`, `_author_brief` and `targetUrl` for plugin mode, `_safe_url` for `figma-trace://`, `abort_run` |
| `services/trace_turn_service.py` | create | the `trace_turns` store: post/get turn, ordering, idempotency, owner, deadline, completing the previous step, the pending step, finalizing |
| `simulation_core/trace_brain.py` | create | the turn prompt and the debrief prompt, the multimodal call, parse and validate, one re-ask |
| `tasks/trace_tasks.py` | create | the Celery task `trace_turn(run_id, turn)` |
| `tasks/__init__.py` | modify | include `tasks.trace_tasks`; route it to the `trace` queue |
| `api/routes_plugin.py` | modify | `POST /runs/<id>/turn`, `GET /runs/<id>/turn/<n>`, `POST /runs/<id>/abort`, and claim reading `owner` |
| `app.py` | modify | the `FIGMA_PLUGIN_ROUTES` additions |
| `infrastructure/database/indexes.py` | modify | a unique index on `trace_turns(run_id, turn)` |
| `Dockerfile_EC2`, `Dockerfile_ECS`, `docker-compose.yml` | modify | a worker for the `trace` queue |
| `docs/openapi.json`, `docs/studies-api.md` | modify | the new routes |
| `_tests/test_trace_turns.py` | create | the turn service and routes (tier 0) |
| `_tests/test_trace_e2e.py` | create | the in-process end-to-end test of a whole study |
| `scripts/trace_live_server.py` | create | a local server for the live end-to-end run: in-memory DB, eager Celery, dev auth, real Gemini. Never run in CI. |

**Plugin (`plugin/`)**

| File | Status | Responsibility |
|---|---|---|
| `figma/src/lib/proto/model.ts` | create | shared types |
| `figma/src/lib/proto/url.ts` | create | `stepUrl`, `parseStepUrl` |
| `figma/src/lib/proto/engine.ts` | create | the interpreter's entry points (`start`, `apply`, `settle`) and the dispatch of prototype actions |
| `figma/src/lib/proto/hitTest.ts` | create | point → target layer (z-order, invisible hotspots, `clipsContent`, overlay blocking, bubbling) |
| `figma/src/lib/proto/pointer.ts` | create | the pointer model (hover enter and leave, `ON_HOVER` and `ON_PRESS` reverts, delayed mouse reactions) |
| `figma/src/lib/proto/scroll.ts` | create | scroll ranges, nested areas, fixed children |
| `figma/src/lib/proto/expr.ts` | create | variable expression evaluation (split out of the engine to keep it small) |
| `figma/src/lib/proto/elements.ts` | create | measured layers → elements |
| `figma/src/main/protoReader.ts` | create | the page → `ProtoDoc` |
| `figma/src/main/renderer.ts` | create | state → image + measured layers |
| `figma/src/main/controller.ts`, `figma/src/code.ts`, `figma/src/lib/messages.ts` | modify | the trace messages, the `skipInvisibleInstanceChildren` handling, the container ignore |
| `figma/src/ui/trace/bridge.ts` | create | request/response over `postMessage` |
| `figma/src/ui/trace/session.ts` | create | one persona's loop |
| `figma/src/ui/trace/runner.ts` | create | wave orchestration and resume |
| `figma/src/lib/api.ts` | modify | `claimRun`, `postTurn`, `getTurn`, `abortRun`, `nextWave` |
| `figma/src/lib/study.ts`, `figma/src/ui/screens/newtest.tsx` | modify | plugin mode, the optional link |
| `figma/src/ui/effects.ts` | modify | start and resume the runner instead of only watching |
| `figma/manifest.json` | modify | the `networkAccess.reasoning` text |
| `figma/tests/fake-figma.ts` | modify | clone, plugin data, `exportAsync`, variables, fonts, `getMainComponentAsync` |
| `figma/harness/mock-backend.mjs` | modify | claim, turn, abort, next-wave (faithful to the contract) |
| `figma/harness/fixtures/farside-proto.json` | create | the Farside billing flow as a geometry-bearing fake page |
| `figma/tests/trace-*.test.ts` | create | unit and end-to-end tests |
| `figma/harness/trace-live.mjs` | create | the driver for the live end-to-end run against `trace_live_server.py` |
| `scripts/core-server.py`, `scripts/test_core_server.py` | modify | `dispatch_study` refuses plugin-mode studies |

---

## Chunk 1: Backend turn API (spec "Backend changes", "Data flow", "Error handling")

### Task B1: Plugin execution mode and null task URL **[sonnet]**

**Files:** modify `services/study_service.py` (`EXECUTIONS` at line 376, `clean_origin` at 381, `SECTION_FIELDS` at 430, `_clean_task` at 218, `normalize_study_fields` at 465, `list_studies` at 800) and `services/plugin_run_service.py` (`_author_brief` at 549, `create_study_run` at 2208). Test: `_tests/test_figma_channel.py`.

- [ ] **Step 1: Write the failing tests** in `test_figma_channel.py`:
  1. `POST /api/studies` with `source: figma`, `execution: plugin`, `figma: {start_node_id, target_node_id, file_name: "Farside billing", page_name: "Prototype"}` and no `task.url` or `figma.file_key` returns 201. The stored study has `execution == "plugin"` and `task.url is None`.
  2. The same body with `execution: local` returns 400 on `execution`.
  3. `execution: remote` with no `task.url` still returns 400 on `task.url` (no behavior change for remote).
  4. A PATCH of a plugin-mode study keeps `task.url` null, so `_clean_task` takes `execution` from the stored study.
  5. `list_studies(execution="plugin")` returns only plugin studies, and `execution="local"` excludes both remote and plugin.
  6. Wave 1 of a plugin-mode study, created as in `test_study_runs.py`'s `world`:
     - the briefing's `instructions.targetUrl` is `figma-trace://Prototype/<start>?node-id=<start>`, with `:` replaced by `-`
     - the `brief` text names "the Farside billing prototype" and not an empty URL
- [ ] **Step 2:** run them and see them fail.
- [ ] **Step 3: Implement.**
  - `EXECUTIONS = ("local", "remote", "plugin")`.
  - `clean_origin`: allow `remote` or `plugin` for figma, default `remote`; `file_key` may be absent in plugin mode; read `file_name` and `page_name` (each at most 120 characters).
  - `SECTION_FIELDS["figma"]` gains `file_name` and `page_name`.
  - `_clean_task(errors, task, execution)`: skip the URL requirement only when `execution == "plugin"`.
  - `normalize_study_fields`: pass the body's top-level `execution`, or the stored one on PATCH.
  - `list_studies`: equality for `remote` and `plugin`; `{"$nin": ["remote", "plugin"]}` for `local`.
  - `_author_brief` and `create_study_run`: when `task.url` is null and the study is plugin mode, build `targetUrl` with the same rules as the plugin's `stepUrl`, and word the brief around the prototype.
- [ ] **Step 4:** the tests pass, and the full pure list is green.
- [ ] **Step 5:** commit "Run Figma studies in plugin mode without a share link".

### Task B2: `figma-trace` browser engine and claim owner **[sonnet]**

**Files:** modify `services/plugin_run_service.py` (`_BROWSER_ENGINES` at line 1960, `clean_browser` at 2006, `claim_run` at 2347) and `api/routes_plugin.py` (claim route at line 289). Test: `_tests/test_study_runs.py`.

- [ ] **Step 1: Tests.**
  1. A claim with `browser: {engine: "figma-trace", version: "0.7.0", viewport: [1280, 900]}` and `owner: "p_abc"` stores `test_meta.browser.engine == "figma-trace"` and `test_meta.trace_owner == "p_abc"`.
  2. An `owner` that isn't a string of 1 to 64 characters `[A-Za-z0-9_-]` is a 400.
  3. A claim without `owner` is still accepted (for existing actors), and stores no owner.
- [ ] **Step 2: Implement.** `_BROWSER_ENGINES` gains `"figma-trace"`. `claim_run(user_id, run_id, browser, owner=None)` validates and stores the owner. The route passes `body.get("owner")`.
- [ ] **Step 3:** the tests pass; commit "Accept the figma-trace engine and a claim owner".

### Task B3: The trace turn store and routes **[opus]**

**Files:**
- create `services/trace_turn_service.py`
- modify `api/routes_plugin.py` and `infrastructure/database/indexes.py`
- create the test `_tests/test_trace_turns.py`, and add it to `ci.yml`

**The service's interface**, with the brain injected so tests use a stub:

```python
class TraceTurnError(Exception): ...            # 400 bad_request
class TurnOutOfOrder(TraceTurnError): ...        # 409 turn_out_of_order, .expected
class NotOwner(TraceTurnError): ...              # 409 not_owner

def post_turn(user_id: str, run_id: str, body: dict, *, enqueue) -> dict:
    """Validate and store the observation of turn n; enqueue(run_id, n) when it is new.
    Returns {"turn": n, "status": "thinking"|"ready"|"failed", ...stored result}."""

def get_turn(user_id: str, run_id: str, n: int, *, now=None) -> dict:
    """The turn record as the API shows it. An undecided turn past its deadline
    becomes failed/turn_timeout and the run is aborted (finalizing turns never are)."""

def abort_run(user_id: str, run_id: str, owner: str, code: str, detail: str) -> dict:
    """Open, non-finalizing run → aborted with abort_reason; session log finalized as expire_stale_run does."""
```

**The record** in `Archetype_Test.trace_turns`:

```python
{"run_id", "turn", "owner", "status": "thinking"|"ready"|"failed",
 "observation": {...},            # without the image
 "screenshot_b64": "...",         # removed once the turn is decided
 "attempts": 0, "deadline_at": iso, "created_at": iso, "updated_at": iso,
 "result": {"action": {...}, "state": {...}, "ended": {...} | None} | None,
 "error": {"code": str, "message": str} | None}
```

- [ ] **Step 1: Tests**, using the `world` fixture pattern from `test_study_runs.py`, the Flask client and `install(monkeypatch, …, trace_turn_service)`:
  1. **Validation.** `post_turn` validates the body:
     - `turn` is an int ≥ 1 and `owner` is required
     - `screen.url`, `screen.frameId` and `screen.viewport` are present
     - `screenshot_b64` is a non-empty string, at most 1.5 MB
     - `elements` is a list of at most 80 `{id: "e<n>", label, role, box: [4 numbers]}`, with role in the spec's set
     - `last` is required when `turn > 1`, and its outcome is in the spec's `TraceOutcome` list
     Each bad field gives a 400 that names the field.
  2. **Ordering.** Turn 1 on a claimed run gives 202 `thinking`, and `enqueue` is called once. Posting turn 1 again gives the stored record, and `enqueue` isn't called again. Posting turn 3 while 1 is undecided gives 409 `turn_out_of_order` with `expected: 1`. Turn 2 is accepted only once turn 1 is `ready`.
  3. **Owner.** An owner other than the claim's gives 409 `not_owner`, and so does a run claimed without an owner.
  4. **Run state.** A run that is not `running` gives 409 `run_ended`.
  5. **Deadline.** `get_turn` on an undecided turn past `deadline_at` (150 s) returns `failed`/`turn_timeout`, and the run is `aborted` with `abort_reason == "turn_timeout"`. A turn whose result has `ended.status == "finalizing"` is never timed out.
  6. **Abort.** `abort_run` on an open run gives `aborted` with that reason, and the session log is finalized. On a finalizing or terminal run it gives 409 `run_ended`. A wrong owner gives 409 `not_owner`.
  7. **Routes.** `POST /turn` returns 202 and the body above. `GET /turn/<n>` returns 200. `POST /abort` returns 200. 401 without auth. Exception text never appears in a 5xx: the new routes live in `api/routes_plugin.py`, which the existing guard test already scans through `glob("routes_*.py")`.
- [ ] **Step 2: Implement** the service, the routes (camelCase the response keys the way the steps route does), and the unique index on `(run_id, turn)`. `enqueue` is `trace_turn.delay` in the routes and a list-append in tests.
- [ ] **Step 3:** green; commit "Store trace turns and expose turn and abort routes".

### Task B4: The Celery task on a dedicated queue **[sonnet]**

**Files:** create `tasks/trace_tasks.py`; modify `tasks/__init__.py` (the `include` at line 15; add `task_routes`), `Dockerfile_EC2` (the start script near line 202), `Dockerfile_ECS` and `docker-compose.yml`.

- [ ] **Step 1: Test** in `test_trace_turns.py`. `celery_app.conf.task_routes` sends `tasks.trace_tasks.trace_turn` to queue `trace`. `tasks.trace_tasks` is in `include`. The EC2 and ECS start scripts start a worker with `-Q trace` and `--concurrency ${TRACE_CONCURRENCY:-8}`, checked by a regex on the files. That last check is a real guard: a missing worker would leave every turn `thinking`.
- [ ] **Step 2: Implement.** `trace_turn(run_id, turn)` calls `trace_turn_service.decide(run_id, turn, brain=default_brain())`; B5 fills in `decide`. Add `task_routes`, and a second celery worker line `celery -A tasks worker -Q trace --concurrency ${TRACE_CONCURRENCY:-8} &` in each start script. The default worker keeps the default queue.
- [ ] **Step 3:** green; commit "Run trace turns on their own Celery queue".

### Task B5: Deciding a turn, completing steps, finalizing **[opus]**

**Files:** `services/trace_turn_service.py` (add `decide`), with tests in `_tests/test_trace_turns.py`.

**The interface and the brain protocol:**

```python
class TraceBrain(Protocol):
    def turn(self, *, briefing: dict, observation: dict, screenshot_b64: str,
             recent_steps: list, note: str | None, recall: list, active_rules: list,
             last: dict | None) -> dict:
        """→ {"reflection": {...after of step n-1...}, "observe": {...}, "decide": {...}, "action": {...}}"""
    def debrief(self, *, briefing: dict, steps: list, ended: dict) -> dict:
        """→ the exact ingest payload of spec Data flow 8 (feedback nested, snake_case outcome)."""

def decide(run_id: str, n: int, *, brain: TraceBrain, now=None) -> None: ...
```

**`decide`'s algorithm**, implementing spec Data flow 5 and 8 exactly:
1. Load the turn and the run. Exit quietly if the turn is already decided; this is the idempotent retry.
2. If `n > 1`, take the pending step from `test_meta.trace_pending`.
3. Call `brain.turn(...)`, passing the `note`, `recall` and `active_rules` from the last `ingest_step` response, which is stored on the run as `test_meta.trace_last_ingest`.
4. **Validate the brain's answer.** The action type must be in the spec's list; the element must be one of this turn's element ids when the type needs one; the other fields must be in their ranges; `reflection` must pass `run_protocol.normalize_step`'s after-section rules. If anything is invalid, re-ask once with the error appended. If it's still invalid, mark the turn `failed`/`brain_invalid_action` and abort the run with that reason.
5. **Model errors.** On `LLMTimeoutError`, a 429 or a 5xx from the provider: retry with exponential backoff until `deadline_at`. Then mark the turn `failed`/`model_unavailable` and abort the run.
6. **Complete step n−1.** If `n > 1`, build it from the pending step and the panel's `last`:
   - `act.result`: `ok` or `no_change`, per the spec's outcome table
   - `act.target`: `last.target`
   - `act.error_message`: only for `unsupported`
   - `after`: the brain's `reflection`
   - `extra.trace`: `{outcome, frame, flags}`, written directly to the step document after `ingest_step`
   Store it with `ingest_step(user_id, run_id, {session_id, step})` and keep its response as `trace_last_ingest`.
7. **If patience ended the run** (`state.ended` in that response): discard this turn's decision. Mark the turn `ready` with `ended = {status: "finalizing", reason: endedReason}`, finalize as `abandoned` (step 10), then return.
8. **If the action is `give_up` or `done`:** mark the turn `ready` with `ended = {status: "finalizing"}`, then finalize as `abandoned` or `completed`.
9. **Otherwise:** store turn n as the new pending step (`observe`, `decide`, the target and the url), and mark the turn `ready` with `{action, state: public_state camelCased}`. Remove `screenshot_b64` from the turn document; the step keeps it through `ingest_step` on the next turn.
10. **Finalize.**
    - Set `test_meta.trace_finalizing = True`.
    - If a pending step exists that the run ended on, complete it with an empty `after` (the brain's last reflection).
    - Call `brain.debrief(...)`, validate it with `_validate_ingest_payload`, and re-ask once. If it's still invalid, abort with `debrief_invalid`.
    - Call `ingest_results(user_id, run_id, payload)`, then update the turn's `ended.status` to the final status.
    - Append `trace_notes` for the flags seen in the run (`file_changed`, `timer_loop`, `missing_font`), each once.

- [ ] **Step 1: Tests.** Use a `StubBrain` that returns scripted answers and records the prompts it was given.
  1. Turn 1 → `ready`, with the action stored and no step written yet.
  2. Turn 2 with `last.outcome == "nothing_happened"` writes step 1 with `act.result == "no_change"`, `act.target` set, no `error_message`, `after.friction` from the reflection, and `extra.trace.outcome == "nothing_happened"`.
  3. `last.outcome == "unsupported"` writes `error_message "unsupported: UPDATE_MEDIA_RUNTIME on Play (e3)"`.
  4. An invalid element id makes the brain re-ask once (the second prompt contains the error); valid → `ready`. Invalid twice → turn `failed`, run `aborted`/`brain_invalid_action`.
  5. A patience give-up review: once `ingest_step` returns a note, the next `brain.turn` call receives it. When `state.ended` is set, the decision is discarded, the run finalizes, `ingest_results` is called with `status: "abandoned"`, and `GET /turn` shows `ended.status == "abandoned"`.
  6. `done` → finalizing → `completed`. The `frame_reached` success check passes when the last step URL names the target frame, which proves the step URL format works end to end with `success_checks._frame_in_url`.
  7. A debrief invalid twice → `aborted`/`debrief_invalid`.
  8. A finalization that takes longer than 150 s (simulated with `now`) is not timed out by `get_turn`.
  9. Model rate limited until the deadline → `failed`/`model_unavailable`, and the run is aborted.
  10. `trace_notes` gains `timer_loop` once, even when two turns carry the flag.
- [ ] **Step 2:** implement `decide`. Wire `tasks/trace_tasks.py` to it.
- [ ] **Step 3:** green; commit "Decide trace turns, complete steps and finalize runs".

### Task B6: The real trace brain **[opus]**

**Files:** create `simulation_core/trace_brain.py`, with tests in `_tests/test_trace_turns.py` (pure) and a tier 2 smoke test in the same file (skipped without `GEMINI_API_KEY`).

- [ ] **Step 1: Tests (pure).**
  1. The turn prompt includes:
     - the persona's name, story and traits, and the archetype's `seedBeliefs` and `factorStatements`
     - the behavior rules, the patience note, the recall slate and the active rules
     - the last outcome, in words: "You clicked "Use routing number instead". Nothing happened."
     - the element list, as `e4 [button] "Continue" at (880,610)`
     - the visible text, and the screenshot as an `image_url` data URL
     It never mentions Figma, prototypes or wiring; that's the spec's "as if the real product".
  2. Parsing:
     - accepts a JSON object, optionally fenced
     - rejects an unknown action type, a missing `reflection` on turn > 1, and out-of-range `confidence`, `sentiment` or `progress`, each with a message the re-ask can use
  3. Debrief parsing produces the exact payload of spec Data flow 8:
     - findings and outcome nested under `feedback`
     - snake_case `quit_reason`, `abandoned_at_step`, `in_their_words`
     - `quit_reason` from `QUIT_REASON_ENUM`
     - `scenarioResults` items `{scenarioId, status pass|fail|blocked, actualResult}`
  4. The client is `plugin_run_service._shared_client("gemini-3-flash-preview")` (one client per model, history off), and the test asserts it's reused across calls.
- [ ] **Step 2: Implement** `GeminiTraceBrain(TraceBrain)` with `query_multimodal` and a `temperature` of 0.4 for turns and 0.2 for the debrief. Replace the B4 placeholder with `default_brain()` returning it.
- [ ] **Step 3 (tier 2, run once by hand):** with the key set, one real turn on a fixture screenshot returns a valid action. Record the run time in the commit body.
- [ ] **Step 4:** green; commit "Add the trace persona brain and debrief".

### Task B7: CORS, step URLs in reports, docs **[sonnet]**

**Files:** modify `app.py` (`FIGMA_PLUGIN_ROUTES` at line 19) and `services/plugin_run_service.py` (`_safe_url` at 1739, `_report_steps` at 1754), plus `docs/openapi.json` and `docs/studies-api.md`. Tests: `_tests/test_figma_channel.py` and `_tests/test_openapi_spec.py`.

- [ ] **Step 1: Tests.**
  1. A null-origin preflight is allowed for `POST /api/plugin/runs/<id>/claim`, `POST …/turn`, `GET …/turn/3`, `POST …/abort` and `POST /api/studies/<id>/runs/next`, and refused for `POST …/results`.
  2. `get_run_report` keeps `figma-trace://Prototype/2-20?node-id=2-20` as the step URL.
  3. `run_protocol._page_key` gives different keys for frames `2-20` and `2-30`.
  4. The OpenAPI spec validates and contains the three new operations.
- [ ] **Step 2: Implement.** Extend the routes tuple; let `_safe_url` pass `figma-trace://` URLs through as text; document the routes.
- [ ] **Step 3:** green; commit "Open the trace routes to the Figma panel and document them".

## Chunk 2: The engine (spec "The engine")

All files are under `plugin/figma/src/lib/proto/`, with tests in `plugin/figma/tests/`. These modules are pure: no `figma` global, no network.

### Task P1: Types and step URLs **[sonnet]**

**Files:** create `model.ts`, `url.ts` and `tests/trace-url.test.ts`.

- [ ] **Step 1: Write `model.ts`.** It holds every type the spec names: `ProtoDoc`, `ProtoFrame`, `ProtoReaction`, `ProtoTrigger`, `ProtoAction` (a discriminated union over every action type, including `CONDITIONAL` blocks and expression trees), `VariableCollection`, `VariantSet`, `TraceState`, `TraceAction` (the spec's action JSON), `TraceOutcome` (the spec's outcome list), `RawLayer` and `Element`. There's no test for the types alone.
- [ ] **Step 2: Tests for `url.ts`.**
  - `stepUrl(null, "My Page", {frameId: "2:20", overlays: ["3:1"]})` gives `figma-trace://My%20Page/2-20?node-id=2-20&overlay=3-1`.
  - With a share key: `https://www.figma.com/proto/<key>/My%20Page?node-id=2-20&overlay=3-1`.
  - `parseStepUrl` round-trips both forms, and the panel's existing `nodeIdFromUrl` (in `lib/ids.ts`, used by `lib/frames.ts`'s `frameForUrl`) reads the frame from both.
- [ ] **Step 3:** implement; green; commit "Add trace model types and step URLs".

### Task P2: Navigation, overlays, scroll, pointer and hit-testing **[opus]**

**Files:** create `engine.ts`, `hitTest.ts`, `pointer.ts`, `scroll.ts` and `tests/trace-engine-nav.test.ts`. The split keeps each file to one concern; `engine.ts` only dispatches.

- [ ] **Step 1: Table-driven tests.** Use small hand-built `ProtoDoc` fixtures and measured `RawLayer[]` lists:
  - `NAVIGATE` pushes history. `resetScrollPosition` and the deprecated `preserveScrollPosition` behave as the spec says. `resetInteractiveComponents` clears the variant overrides under the destination.
  - `SWAP` replaces without history. `BACK` pops, and on empty history gives `back_empty`.
  - `OVERLAY` at each of the 8 positions sets the overlay's origin.
    - `MANUAL` is relative to the trigger box.
    - `CLOSE` closes the top overlay.
    - A click outside a close-on-outside overlay closes it and fires nothing underneath.
    - With an overlay open, a click on the layers underneath hits nothing and gives `nothing_happened`.
  - **Hit-testing by point:**
    - a transparent hotspot rectangle above an image fires its reaction
    - a click on a child without a reaction bubbles to its parent's
    - a point outside a box clipped by `clipsContent` doesn't hit it
    - a `MOUSE_DOWN` that navigates stops the rest of the click sequence
  - **Pointer:**
    - `hover` fires `MOUSE_LEAVE` and then `MOUSE_ENTER`
    - an `ON_HOVER` overlay stays open while the pointer is over the trigger or the overlay, and closes on leave
    - `ON_PRESS` reverts at release
    - `MOUSE_ENTER` with a delay fires at `settle` only while the pointer is still there
  - **Scroll:**
    - a frame taller than the viewport scrolls whatever its `overflowDirection`
    - at the end of the range → `scroll_at_end`
    - a nested scroll area moves only on its own axis
    - fixed children don't move
  - **Other outcomes:** `URL` → `left_prototype`; `UPDATE_MEDIA_RUNTIME` → `unsupported`; an unknown action type → `unsupported`.
- [ ] **Step 2:** implement `start`, `apply` and the navigation parts of `settle`.
- [ ] **Step 3:** green; commit "Interpret prototype navigation, overlays, scroll and pointer events".

### Task P3: Variables, conditionals, variants, keys and timers **[opus]**

**Files:** create `expr.ts`, modify `engine.ts`, and create `tests/trace-engine-state.test.ts`.

- [ ] **Step 1: Tests.**
  - **`expr.ts`:** every operator in the spec, including `VAR_MODE_LOOKUP`. Also aliases, and type errors: adding a string to a boolean gives an explicit `ExprError`, never a silent coercion.
  - **`SET_VARIABLE`** updates `state.variables` for the right collection and mode.
  - **`SET_VARIABLE_MODE`** updates `state.modes`.
  - **`CONDITIONAL`** runs the first true block; when none is true it falls to the else block if there is one, otherwise nothing.
  - **`CHANGE_TO`** sets the variant override. After it, a click resolves against the new variant's reactions, through the variant's layers measured for that render. A variant marked unavailable → `unsupported`.
  - **`press_key`** matches `keyCodes`. `type` fires key reactions on the focused layer, otherwise `typed_nothing`.
  - **Timers:**
    - `settle` fires an `AFTER_TIMEOUT` of 800 ms automatically, and a 5 s one only on `wait(5)`
    - `wait` with no due timers → `waited`
    - a loop of 2 s timers stops at 20, keeps the reached state and reports `looped` with the frames involved
- [ ] **Step 2:** implement.
- [ ] **Step 3:** green; commit "Evaluate prototype variables, conditionals, variants, keys and timers".

### Task P4: Elements **[sonnet]**

**Files:** create `elements.ts` and `tests/trace-elements.test.ts`.

- [ ] **Step 1: Tests**, from measured `RawLayer[]`:
  - only layers inside the viewport are listed, in reading order (top to bottom, then left to right), with ids `e1…`
  - text gives a `text` or `link` role, and an instance or framed control with a label gives `button`
  - generic names (`Rectangle 12`, `Frame 48`, `icons8-help-32 1`, `image 4`) never become labels: the text inside is used, otherwise the role word
  - an invisible layer with reactions → "unlabeled area", unless its name is readable
  - unwired visible layers are included
  - the list is capped at 80, trimming text blocks first and then the smallest elements
  - the mapping from element id to layer key and click point is returned alongside the list
- [ ] **Step 2:** implement.
- [ ] **Step 3:** green; commit "List what the persona sees from measured layers".

## Chunk 3: The main thread (spec "ProtoDoc", "Rendering")

### Task P5: The page reader and its fakes **[opus]**

**Files:** create `src/main/protoReader.ts` and `tests/trace-reader.test.ts`; modify `tests/fake-figma.ts`, adding `getMainComponentAsync`, `importComponentByKeyAsync`, the variables API (`getLocalVariableCollectionsAsync`, `getVariableByIdAsync`, `explicitVariableModes`, `boundVariables`), plugin data, and absolute boxes.

- [ ] **Step 1: Tests**, against a fake page built from the new `harness/fixtures/farside-proto.json`: the Farside billing flow with boxes, one variable collection with two modes, one interactive component with two variants, and one reaction on another page.
  - every reaction, with its trigger delays, is read into the `ProtoDoc`
  - a frame reached on another page is included, via `getNodeByIdAsync`
  - `CHANGE_TO` variants are read with their reactions; a library variant that fails to import is marked unavailable
  - the variables and the page and frame `explicitVariableModes` are read
  - each frame's overlay settings (position, background, close on outside click) are read
  - `skipInvisibleInstanceChildren` is false during the read and restored after, including when the read throws
  - `docHash` is stable across reads and changes when a reaction changes
- [ ] **Step 2:** implement.
- [ ] **Step 3:** green; commit "Read the prototype into a ProtoDoc".

### Task P6: The renderer **[opus]**

**Files:** create `src/main/renderer.ts` and `tests/trace-renderer.test.ts`; modify `tests/fake-figma.ts`, adding `clone`, `exportAsync` (it returns bytes that encode the copy's tree, so tests can assert what was rendered), `loadFontAsync`, `hasMissingFont`, `setExplicitVariableModeForCollection`, `setBoundVariable`, `commitUndo` and `locked`.

- [ ] **Step 1: Tests.**
  - a render creates one container at x = −100 000, locked and marked, copies the frame and its overlays into it, and removes the container in `finally`, also when `exportAsync` throws
  - the originals are never mutated
  - variant overrides, modes and `SET_VARIABLE` values are applied to the copies: text, visibility and fill bindings
  - a missing font leaves the text as designed and returns `notes: [{missing_font: …}]`
  - the measured layers come from the copies, in z-order, clipped by `clipsContent` ancestors, with logical keys mapped back to the original ids (and the instance-path keys inside a swapped variant)
  - the scroll offset is applied, with fixed children pinned
  - the export is a JPEG at quality 80 and 1x, of the viewport only
  - `commitUndo` is called after the removal
  - the container ids are recorded for the change watchers
- [ ] **Step 2:** implement.
- [ ] **Step 3:** green; commit "Render trace states from scratch copies and measure them".

### Task P7: Messages, controller and `code.ts` **[sonnet]**

**Files:** modify `src/lib/messages.ts`, `src/main/controller.ts` and `src/code.ts`. Test in `tests/main.test.ts` (extend).

- [ ] **Step 1: Tests.**
  - `trace-read`, `trace-render`, `trace-save`, `trace-load` and `trace-scratch-check` each carry a `requestId`, and the reply echoes it (`trace-result` or `trace-error {requestId, message}`)
  - a malformed payload gives `trace-error`, not an exception that only reaches `figma.notify`
  - `trace-scratch-check` returns `{ok: false, reason}` in a file where creating a node throws (view-only)
  - `watchPage`'s handler ignores CREATE and DELETE of tracked container ids and every change inside them
  - the file-change watcher reports a change to a `ProtoDoc` frame
  - `figma.on('close')` removes a leftover container
- [ ] **Step 2:** implement.
- [ ] **Step 3:** green; then `npm run typecheck && npm run build && npm run check:manifest`; commit "Wire the trace messages into the main thread".

## Chunk 4: The panel (spec "Data flow" 1–10)

### Task P8: Bridge and API client **[sonnet]**

**Files:** create `src/ui/trace/bridge.ts`; modify `src/lib/api.ts`. Tests in `tests/trace-bridge.test.ts` and `tests/api.test.ts` (extend).

- [ ] **Step 1: Tests.**
  - two parallel `call`s get their own replies, even out of order
  - a 30 s timeout rejects with a typed `BridgeTimeout`
  - `trace-error` rejects with the message
  - `api.claimRun`, `postTurn` (202 → `{status: "thinking"}`), `getTurn`, `abortRun` and `nextWave` use the exact paths and bodies of the spec
  - a 409 is surfaced with its `code` (`turn_out_of_order` with `expected`, `not_owner`, `run_ended`, `wave_in_progress`)
- [ ] **Step 2:** implement.
- [ ] **Step 3:** green; commit "Add the trace bridge and API calls".

### Task P9: Session **[opus]**

**Files:** create `src/ui/trace/session.ts` and `tests/trace-session.test.ts`.

- [ ] **Step 1: Tests.** Use a fake bridge that renders from fixtures and a fake API that scripts the turn responses.
  - **The loop:** settle → render → elements → `postTurn` → poll `getTurn` every 1 s backing off to 3 s → apply → save. It stops on `ended`.
  - **Recovery:**
    - render fails twice → `abortRun(render_failed)`
    - `thinking` for 180 s → `abortRun(turn_timeout)`
    - once `ended` is set, it never aborts
    - `turn_out_of_order` → re-read `expected − 1` and continue
    - `not_owner` or `run_ended` → stop
    - a 503 `auth_unavailable` → pause and keep the token
    - a network error → pause and retry
  - **What it reports:** `last` carries the outcome and the target label; `flags` carry `timer_loop` from `settle`, `missing_font` from the render, and `file_changed` from the watcher.
  - **Background tab:** the session measures how late its timers fire. A poll timer that fires more than 10 s late raises the "Keep this tab visible, or use the desktop app" notice through the session's status callback, once per run.
- [ ] **Step 2:** implement.
- [ ] **Step 3:** green; commit "Run one persona session through the turn API".

### Task P10: Runner, study mode and the UI **[opus]**

**Files:** create `src/ui/trace/runner.ts` and `tests/trace-runner.test.ts`; modify `src/lib/study.ts` and `src/ui/screens/newtest.tsx` (plugin mode, the optional link, `file_name` and `page_name`), `src/ui/effects.ts` (launch gate, then the runner instead of the watch loop) and `src/ui/state.ts` if the Running screen needs new fields.

- [ ] **Step 1: Tests.**
  - `buildStudyRequest` sends `execution: "plugin"`, with no `file_key` or `task.url` when the link is empty, and with them when a link is given
  - the form no longer requires a link
  - the launch gate blocks with "Duplicate to your drafts to test" when `trace-scratch-check` fails
  - when the `ProtoDoc` needs a library variant import, launch first shows "Testing this flow adds <component> from <library> to this file, as using it in Figma would", and the launch continues only after the designer confirms
  - **The runner:**
    - claims every queued run of the wave with one `owner`, and runs the sessions in parallel
    - when all have ended, calls `nextWave`, waiting through `wave_in_progress` for up to 5 minutes before showing Try again, and stops at `done`
  - **Resume:**
    - only runs whose saved owner matches and that the backend still shows `running` are resumed
    - runs with no saved state are left alone
    - a changed `docHash` flags every resumed run with `file_changed`
    - a run whose saved frame is gone is aborted with `file_changed`
  - the Running screen shows each persona's current frame name and step count from the session state (no extra polling)
- [ ] **Step 2:** implement.
- [ ] **Step 3:** green; commit "Run whole studies inside the panel".

### Task P11: Plugin repo glue **[sonnet]**

**Files:** modify `scripts/core-server.py` (`dispatch_study`), `scripts/test_core_server.py`, `figma/manifest.json` and `figma/README.md` ("How runs execute": runs happen in the panel; the runner is no longer needed for Figma studies).

- [ ] **Step 1: Test.** `dispatch_study` on a plugin-mode study refuses with "this study runs inside Figma", and starts no runner.
- [ ] **Step 2: Implement**, and update the manifest's reasoning text with the spec's wording.
- [ ] **Step 3:** the plugin Python suite with `< /dev/null`, plus figma `npm test`; commit "Point plugin-mode studies at the Figma panel".

## Chunk 5: End-to-end tests and the live run

These are the tests that prove the feature works. They run real code across modules.

### Task E1: Backend end to end, in process **[opus]**

**Files:** create `_tests/test_trace_e2e.py`, and add it to `ci.yml`.

- [ ] **Step 1: The test.** It drives a real study through the Flask test client with the in-memory DB, Celery in eager mode (`task_always_eager`), and a scripted brain that follows a click path:
  1. Create a plugin-mode figma study with no link, then factors and archetypes (fake models as in `test_study_runs.py`), then `POST /runs`.
  2. Claim every queued run with one owner.
  3. For each run, a scripted "panel" posts turns along the Farside billing path: a misclick on "Use routing number instead", then the golden path. Each turn carries a small JPEG and fixture elements, and polls `GET /turn`.
  4. One run gives up through patience, and one finishes `done` on "Bank connected".
  5. Then `POST /api/studies/<id>/runs/next` loops until `done`.
- **Assertions:**
  - The steps stored per run have the right `act.result`, `act.target` and `extra.trace`.
  - `ingest_results` stored the debrief: findings under `feedback`, and `outcome.quit_reason` for the abandoned run.
  - `frame_reached` passes for the completed run and fails for the abandoned one.
  - `GET /api/studies/<id>/report` builds, with both runs counted as persona outcomes.
  - A third run aborted with `render_failed` is excluded from the report.
  - Every response a null-origin request reaches carries the CORS headers.
- [ ] **Step 2:** fix whatever it finds, in the module at fault, test first.
- [ ] **Step 3:** green; commit "Test a whole trace study end to end in the backend".

### Task E2: Plugin end to end, in process **[opus]**

**Files:** modify `harness/mock-backend.mjs` to implement claim, turn, abort and next-wave exactly to the spec contract (ordering, owner, deadline, 202 and poll), with a scripted brain. Create `tests/trace-e2e.test.ts`.

- [ ] **Step 1: The test.** The real `protoReader` and `renderer` run on the fake Farside billing page, the real engine, elements, bridge (in-process transport), session and runner run in the panel, and the mock backend sits over HTTP on `127.0.0.1`.
- **Assertions:**
  - The golden path reaches "Bank connected", with the step URL naming it.
  - A misclick on "Use routing number instead" is logged with outcome `nothing_happened`.
  - "Sign in with your bank" opens the "Bank sign in error" overlay, and "Try again" closes it.
  - Plans is a dead end that the scripted brain gives up on.
  - Two personas run in parallel without crossing replies.
  - A forced render failure aborts only its run.
  - Closing and reopening the panel resumes the owned run from its saved turn.
  - After the run, the fake page holds no scratch container and every original node is untouched.
- [ ] **Step 2:** fix what it finds, test first.
- [ ] **Step 3:** green; commit "Test a whole trace study end to end in the plugin".

### Task E3: Live end to end, with the real Figma file and the real model **[opus; run by the orchestrator]**

**Files:** create `backend/scripts/trace_live_server.py` and `plugin/figma/harness/trace-live.mjs`. Neither runs in CI.

- [ ] **Step 1: The local server.** `trace_live_server.py` boots `create_app()` on `127.0.0.1:5013` with:
  - the in-memory fake DB, installed the way the tests do it
  - Celery in eager mode
  - `DEV_MODE=1` and `FLASK_ENV=development` for the dev auth bypass
  - the real `GeminiTraceBrain`, with the key from the local `.env`
  - fake factor and archetype models replaced by the real ones
  It refuses to start if `MONGODB_URI` would be used: it asserts that the fake is installed before `create_app`.
- [ ] **Step 2: Capture the real prototype.** The orchestrator runs the built `protoReader` and `renderer` bundle through the Figma MCP `use_figma` tool on the real "Farside Oxygen+" file (`ih93y27MPAFYUupxyEMLUR`). It records the `ProtoDoc` and the measured layers and image of each state the flow can reach: frames, overlays and scroll positions, since that flow has no variables. The recording is saved to `scratchpad/trace/live/`.
- [ ] **Step 3: Drive the live run.** `trace-live.mjs` runs the real runner and session, with a render source that replays the recorded states (keyed by frame, overlays and scroll; it fails loudly on an unrecorded state), against the live server.
- [ ] **Step 4: Run it.** Launch a 4-archetype study and let real Gemini personas run to a report. Check the report by hand:
  - every run reaches a terminal status
  - completed runs end on "Subscription active"
  - misclicks show as friction
  - the debrief findings cite real step URLs
- [ ] **Step 5:** fix what it finds, test first, in the unit or end-to-end tests, then rerun. Commit the scripts.

**Not in this plan:** trace support in the interactive browser harness (`npm run harness`, `harness/host/host.js`). The automated end-to-end tests (E2) run the reader and renderer against `fake-figma.ts` directly, and the live run (E3) uses the real Figma file. Adding the harness is a follow-up if it's wanted for demos.

### Task E4: Final verification and PRs **[orchestrator]**

- [ ] Run the full backend pure list, the plugin Python suite, figma `npm test`, typecheck, build and check:manifest. All must be green.
- [ ] Open the PRs: backend into `dev`, and the plugin into `main` (`feat/figma-trace-runner`). Each PR body links the spec, summarizes the E1, E2 and E3 results, and lists what the user should check by hand in the Figma desktop app.
- [ ] Do not merge, and do not deploy. Ask the user.
