# Figma trace runner: persona tests that run inside the Figma plugin — design

Date: 2026-11-09
Status: approved in brainstorming (sections 1–4); spec review passed (4 rounds)

## Problem

The Archetype Figma plugin launches a study and then only watches. The runs are
executed by `scripts/study_runner.py --watch`, which needs Claude Code, this
plugin signed in to the designer's Archetype account, Python and Playwright on
some machine. A designer who only installs the Figma plugin sees "Waiting for a
runner" forever. Competing tools (Versive, Sentia, Uxia, AnthrAI, Floto) need
nothing beyond their plugin.

A Figma plugin cannot drive the prototype viewer or open a browser, and the
Embed API cannot simulate clicks. It can read every frame, layer and prototype
reaction, export layers as images, and call our backend.

## Goal

A designer installs only the Figma plugin, launches a study, and every persona
runs to a scored report while the panel is open. Each run is recorded exactly
like a browser run (protocol v2 steps, success checks, results), so the backend
report, trace view and metrics work unchanged.

## Decisions (from brainstorming)

| Question | Decision |
|---|---|
| Where the loop runs | In the plugin panel (option C). The panel is the browser; the backend is the brain. |
| Run mode | All queued runs of a wave run at once, in parallel. |
| Fidelity | Everything the Figma prototype engine does that the Plugin API exposes: navigate, swap, overlays, back, scroll, interactive components (`CHANGE_TO`), variables, `SET_VARIABLE`, `SET_VARIABLE_MODE`, conditionals, hover, press, drag, key and after-delay triggers. |
| View-only files | Launch is blocked: "Duplicate to your drafts to test". Rendering state needs temporary copies, which needs edit access. |
| What the persona can act on | Everything visible (button-like layers and text), wired or not. Acting on an unwired element changes nothing and is logged as a misclick. |
| Split between panel and backend | One turn endpoint; the backend runs the brain, records the step and owns patience and finalization. |
| Turn transport | Asynchronous: `POST /turn` returns 202 and the brain runs in Celery; the panel polls `GET /turn/<n>`. Production runs 2 gunicorn workers (4 on ECS), so a synchronous model call per persona would block the API for everyone. |

## Architecture

A plugin has two halves. The **main thread** can read and write the document.
The **panel** (UI iframe) is the only half with network access. The engine is
pure TypeScript and runs in the panel, one instance per persona. The main thread
reads the prototype once and renders states on request; layout is always
measured from what Figma rendered, never computed by us.

### Plugin units (`figma/src`)

| Unit | Thread | Interface | Job |
|---|---|---|---|
| `main/protoReader.ts` | main | `readProto(api, page) → ProtoDoc` | Reads the flow into a plain, serialisable `ProtoDoc` (details below). Grows out of `document.ts`, which keeps producing the preflight `DocSnapshot`. |
| `lib/proto/model.ts` | shared | types | `ProtoDoc`, `TraceState`, `TraceAction`, `TraceOutcome`, `RawLayer`, `Element`. No Figma types. |
| `lib/proto/engine.ts` | panel | `start(doc, startFrameId) → TraceState`; `apply(doc, state, action, layers) → { state, outcome }`; `settle(doc, state) → { state, fired, looped }` | The interpreter (rules below). Pure and deterministic. `layers` is the measured layer list of the screen the action was taken on, used for hit-testing. |
| `main/renderer.ts` | main | `render(doc, state) → { image: Uint8Array, layers: RawLayer[], viewport, notes }` | Draws a state on scratch copies, measures every layer of the copies and maps each back to its logical layer key, exports the viewport, and deletes the copies in a `finally` (details below). Requests are serialised through one queue. |
| `lib/proto/elements.ts` | panel | `listElements(layers, state) → Element[]` | Turns measured layers into what the persona sees (rules below). Pure. |
| `lib/proto/url.ts` | shared | `stepUrl(shareKey, pageName, state)` | Step URL (rules below). |
| `ui/trace/bridge.ts` | panel | `call(type, payload, timeoutMs) → Promise` | Request/response over `postMessage` with a `requestId` per request and an error reply type, so parallel sessions get their own replies. Default timeout 30 s. |
| `ui/trace/session.ts` | panel | `runSession(run, deps) → SessionResult` | The loop for one persona (data flow below). |
| `ui/trace/runner.ts` | panel | `runStudy(studyId, deps)` | Claims every queued run of the current wave at once, runs their sessions in parallel, and when all have ended asks for the next wave until the backend says the study is done. Resumes owned sessions when the panel reopens. |

**Changes to existing plugin files:**
- **Study request and form:** `lib/study.ts` sends `execution: 'plugin'` and makes the share link optional. `screens/newtest.tsx` labels it optional.
- **Panel control:** `ui/effects.ts` hands the watch loop to `trace/runner.ts`. `lib/messages.ts` and `main/controller.ts` gain the trace messages.
- **Main thread:** `code.ts` turns `skipInvisibleInstanceChildren` off while `readProto` runs and during every render, then restores it in a `finally`; otherwise hidden layers inside instances that a variable or variant reveals are unreachable. `watchPage`'s `nodechange` handler ignores the scratch container's own CREATE and DELETE and every change inside it, by the container ids this session tracks (otherwise every render would trigger a full `readDocument` refresh).
- **Manifest:** `manifest.json`'s `networkAccess.reasoning` changes to say that during a test the plugin sends screenshots of the screens in the flow, plus their text, to Archetype and its AI model provider.
- **Plugin repo outside `figma/`:** `scripts/core-server.py`'s `dispatch_study` refuses plugin-mode studies with "this study runs inside Figma". `study_runner --watch` already lists only `execution=remote` studies, so it needs no change.

### `ProtoDoc` (what `protoReader` reads)

- **Frames:** every top-level frame on the page, plus the frames reachable through reactions on other pages via `getNodeByIdAsync`. For each frame: size, `overflowDirection`, `numberOfFixedChildren`, overlay settings (position `CENTER`, `TOP_LEFT`, `TOP_CENTER`, `TOP_RIGHT`, `BOTTOM_LEFT`, `BOTTOM_CENTER`, `BOTTOM_RIGHT`, `MANUAL`; background; close on outside click), `explicitVariableModes`.
- **Reactions:** every reaction of every layer, with all trigger types (`ON_CLICK`, `ON_PRESS`, `ON_DRAG`, `ON_HOVER`, `MOUSE_ENTER`, `MOUSE_LEAVE`, `MOUSE_UP`, `MOUSE_DOWN`, `AFTER_TIMEOUT`, `ON_KEY_DOWN`, `ON_MEDIA_HIT`, `ON_MEDIA_END`) and their delays, and all action types. Conditional blocks and variable expressions (including `VAR_MODE_LOOKUP`) are kept as trees.
- **Variants:** for every instance that a `CHANGE_TO` targets, the variant set's variants with their reactions. They come from `getMainComponentAsync` and the component set. A variant from a library that isn't loaded is imported with `importComponentByKeyAsync`. If the import fails, the reader records that variant as unavailable.
- **Variables:** local variable collections, modes and values, and the page's `explicitVariableModes`.
- **Fingerprint:** `docHash`, a hash of all of the above, used to notice when the file changes.

Layer geometry is not taken from `ProtoDoc`. The renderer measures it every step.

### Backend changes (`Archetype_Backend`)

| Change | Where |
|---|---|
| `POST /api/plugin/runs/<id>/turn` and `GET /api/plugin/runs/<id>/turn/<n>`. | `api/routes_plugin.py`, new `services/trace_turn_service.py` |
| `POST /api/plugin/runs/<id>/abort` with `{owner, code, detail}`: sets a run that is still open and not finalizing to `aborted` with `abort_reason`, and finalizes its session log the way `expire_stale_run` does. Otherwise `409 run_ended`. Used by the panel for failures it detects. | same |
| Collection `Archetype_Test.trace_turns`: one document per `(run_id, turn)`, with the observation, the screenshot (until the turn is decided), status, attempts, the deadline, the result and the error. Indexed on `(run_id, turn)`, unique. Screenshots never travel as Celery arguments. | `services/trace_turn_service.py`, `infrastructure/database/indexes.py` |
| Celery task `trace_turn(run_id, turn)` on a dedicated queue `trace`, so turns never wait behind 15-minute Notte tasks. A worker for that queue is started in `Dockerfile_EC2`, `Dockerfile_ECS` and `docker-compose`, with `TRACE_CONCURRENCY` defaulting to 8. `tasks.trace_tasks` is added to `include` in `tasks/__init__.py`. | new `tasks/trace_tasks.py`, Dockerfiles |
| The trace persona brain: one vision call per turn (prompt below), and one debrief call per run. It uses `gemini-3-flash-preview` through the shared, history-free `LLMClient` for that model. The answer is JSON in the prompt, then parsed and validated, because `query_multimodal` has no JSON mode. | new `simulation_core/trace_brain.py` |
| `browser.engine` accepts `figma-trace`. | `services/plugin_run_service.py` `_BROWSER_ENGINES` |
| `execution` accepts `plugin`; for `source: figma` the allowed values become `remote` and `plugin`. In plugin mode `figma.file_key` and `task.url` may be null; the `figma` section carries `file_name` and `page_name`, added to `SECTION_FIELDS["figma"]` so `reject_client_fields` accepts them. `normalize_study_fields` reads the body's (or, on PATCH, the stored study's) top-level `execution` and passes it to `_clean_task`, which accepts a null `task.url` only in plugin mode. `_author_brief` and the briefing's `targetUrl` use the prototype's file and page name and the `figma-trace://` start URL when `task.url` is null. `list_studies`: `execution=remote` and `execution=plugin` filter by equality, `execution=local` uses `$nin: ["remote", "plugin"]`. | `services/study_service.py` (`normalize_study_fields`, `_clean_task`, `clean_origin`, `list_studies`), `services/plugin_run_service.py` (`_author_brief`) |
| `get_run_report` lets `figma-trace://` step URLs through `_safe_url` as text, so the run report keeps the frame each step was on. | `services/plugin_run_service.py` |
| The claim body accepts `owner`, an opaque id of the claiming panel, stored on the run. `turn` and `abort` require the same owner. | `services/plugin_run_service.py` `claim_run` |
| Run notes: the field `test_meta.trace_notes[]` holds `file_changed`, `timer_loop` (with frames) and `missing_font` (with font names). The service writes the same flags to each step document's `extra.trace` directly (not through `normalize_step`'s unknown-key path, which would nest them under `extra.unknown`). | `services/trace_turn_service.py` |
| The null-origin CORS allowlist adds claim, turn (POST and GET), abort and `POST /api/studies/<id>/runs/next`. | `app.py` `FIGMA_PLUGIN_ROUTES` |
| `docs/openapi.json` and `docs/studies-api.md` document the new routes, fields and values. | docs |

**Share link.** In plugin mode no browser opens the prototype, so the link is
optional. With a link, step URLs use its file key and the real proto URL form.
Without one, `figma.file_key` and `task.url` are null. Step URLs then use the
form `figma-trace://<page>/<frame>?node-id=<frame>&overlay=<ids>` (see Step URL). `frame_reached`
reads `node-id` from either form. The web report shows only `http(s)` URLs as
links (`safeHttpUrl`), so a `figma-trace://` URL appears as plain text, never as
a broken link.

## The engine

### State

`TraceState` holds:
- `frameId`, plus `overlays[]`, each with its frame, position and close-on-outside setting
- `history[]`, for back
- `scroll`: offsets for the page and for each nested scrollable frame
- `variants`: an override per instance key
- `variables`: values per collection and mode
- `modes`: explicit mode per collection
- `clockMs` and `timers[]`
- `pointer`: the layer under the pointer, and the press target
- `docHash`

**Viewport.** The viewport is fixed for the whole run, like a device, and equals the start frame's size:
- **Width:** the start frame's width.
- **Height:** the start frame's height, capped at 900 for frames 768 wide or more and at 844 below that.
- **Other frame sizes:** frames of another width are drawn from the top left. A wider frame scrolls horizontally.
- **Tall frames:** a top-level frame taller than the viewport scrolls vertically whatever its `overflowDirection`, as in the viewer.

### Pointer model

Every action that targets an element first moves the pointer to the centre of that element's box. Moving the pointer fires `MOUSE_LEAVE` on the old layer and `MOUSE_ENTER` on the new one, and reverts any `ON_HOVER` effect of the old layer.
- **While-hovering overlays:** an overlay opened by "while hovering" stays open while the pointer is over the trigger or over the overlay.
- **Press:** `ON_PRESS` effects ("while pressing") revert at `MOUSE_UP`, unless they navigated away.
- **Trigger delays:** a delayed `MOUSE_ENTER` or `MOUSE_LEAVE` reaction fires at the next `settle`, if the pointer is still where its trigger needs it.

### Hit-testing

The target of a click, press or drag is found **by point, as the viewer does.**
1. **Topmost layer:** the engine takes the topmost layer in `layers` whose box contains the point. `layers` are in z-order, and include invisible layers that carry reactions, such as transparent hotspot rectangles. Each measured box is already clipped to its ancestors that have `clipsContent`, so content scrolled out of a nested area can't be hit.
2. **Bubbling:** if that layer has no reaction for the trigger, the event bubbles up through its ancestors.
3. **Overlays:** while an overlay is open, only its layers can be hit. A click outside a close-on-outside overlay closes the overlay and does nothing else. Phase 3 confirms both rules against the real viewer before they're relied on.
4. **A sequence that navigates:** a click fires `MOUSE_DOWN`, `ON_PRESS`, `MOUSE_UP` and `ON_CLICK` in that order. If one of them shows a different frame or overlay, the rest are not fired.

### Actions the persona can take

```jsonc
{ "type": "click" | "hover" | "drag" | "press_key" | "scroll" | "wait" | "back" | "type" | "give_up" | "done",
  "element": "e4",                     // click, hover, drag, type; optional for scroll (a nested scroll area)
  "direction": "up" | "down" | "left" | "right",   // scroll
  "amount": "page" | "half",           // scroll, default "page" (90% of the viewport)
  "key": "Enter",                      // press_key: a KeyboardEvent.key name, mapped to Figma keyCodes
  "seconds": 3,                        // wait, 1 to 30
  "text": "mara@example.com",          // type, up to 200 characters
  "reason": "…",                       // give_up
  "claim": "…" }                       // done: what the persona believes it achieved
```

| Action | Fires |
|---|---|
| `click(e)` | `MOUSE_DOWN`, `ON_PRESS`, `MOUSE_UP`, `ON_CLICK` at the element's centre, by hit-testing. |
| `hover(e)` | The pointer move. |
| `drag(e)` | `ON_DRAG`. |
| `press_key(k)` | `ON_KEY_DOWN` reactions whose key codes match. |
| `scroll(dir)` | Moves the page, or the nested area given by `element`, within its scroll range. Fixed children stay pinned. |
| `wait(s)` | Advances the clock and fires due `AFTER_TIMEOUT` timers. |
| `back` | Pops history, like a browser back button. |
| `type(e, text)` | Fires the `ON_KEY_DOWN` reactions on the focused layer. Figma has no text inputs. |
| `give_up`, `done` | End the run, which the backend handles. |

### Outcomes (`TraceOutcome`)

| Outcome | Meaning | `act.result` |
|---|---|---|
| `navigated` | A new frame is showing (navigate, back, conditional) | `ok` |
| `swapped` | The current frame or top overlay was replaced | `ok` |
| `opened_overlay`, `closed_overlay` | | `ok` |
| `changed_state` | A variant, variable or mode changed what is shown | `ok` |
| `scrolled` | The view moved | `ok` |
| `timers_fired` | `wait` fired one or more timers | `ok` |
| `nothing_happened` | The action hit no reaction (a misclick) | `no_change` |
| `scroll_at_end` | Already at the end in that direction | `no_change` |
| `back_empty` | `back` with no history | `no_change` |
| `waited` | `wait` with no due timers | `no_change` |
| `typed_nothing` | `type` with no key reactions | `no_change` |
| `left_prototype` | A `URL` action opened a link outside; the screen stays and the next turn says so | `no_change` |
| `unsupported` | `UPDATE_MEDIA_RUNTIME`, an unavailable library variant, or an unknown action type | `no_change` |

A step's `act.target` is the element's label and id, for example `"Continue (e4)"`. Its `act.error_message` is set only for `unsupported`, as `"unsupported: <type> on <label>"`. That keeps misclicks out of the error metrics and the `repeated_error` trigger. Misclicks still count as friction through the persona's own reaction.

### Actions → state

- **`NODE`+`NAVIGATE`:** pushes history and shows the destination. Scroll resets when `resetScrollPosition` is true, or when the deprecated `preserveScrollPosition` is false. Variant overrides under the destination reset when `resetInteractiveComponents` is true.
- **`NODE`+`SWAP`:** replaces the current frame, or the top overlay, without adding history.
- **`NODE`+`OVERLAY`:** pushes an overlay at its configured position. A `MANUAL` overlay is placed relative to the trigger's box.
- **`NODE`+`SCROLL_TO`:** scrolls so the node is in view.
- **`NODE`+`CHANGE_TO`:** sets the instance's variant override. The new variant's reactions apply from then on.
- **`BACK`:** pops history. **`CLOSE`:** closes the top overlay.
- **`SET_VARIABLE`:** evaluates the expression and assigns the result. Supported operators: arithmetic, comparison, `AND`, `OR`, `NOT`, negation, string concatenation, aliases, `VAR_MODE_LOOKUP`.
- **`SET_VARIABLE_MODE`:** sets the explicit mode for that collection.
- **`CONDITIONAL`:** runs the actions of the first block whose condition is true.
- **`URL`:** `left_prototype`. **Media actions and unknown types:** `unsupported`.

### Settling timers

Before every render, `settle` fires `AFTER_TIMEOUT` timers of 2 s or less, plus pending delayed mouse reactions, because a person would not act sooner. Longer timers fire only on `wait`.
- **Loop guard:** a settle stops after 20 fired timers. It keeps the state it reached and reports `looped` with the frames involved.
- **Recording:** the step and the run notes record `timer_loop`, and the run continues. Looping animations, spinners and carousels are common, so this is not an error.

## Rendering and the elements the persona sees

### The scratch container

The renderer never creates a page: Starter-plan files are limited in pages, and a designer could open a scratch page by accident. Instead it uses a container frame on the current page:
- **Lifetime:** the container lives only for the length of one render. It is created at the start of the render and removed, with the copies inside it, in that render's `finally`. So nothing lingers on the canvas between steps, "Zoom to fit" isn't thrown off, and `figma.commitUndo()` after the removal keeps a designer's Cmd+Z from bringing copies back for more than a moment.
- **Placement and marking:** it sits at x = −100 000, locked, and is marked with plugin data `archetype.trace = "scratch"`.
- **Ignored by other code:** `readProto`, the preflight reader, `watchPage`'s `nodechange` handler and the file-change detector all skip it. The handlers ignore the container's own CREATE and DELETE too. They track the ids of containers this session created, because a deleted node's plugin data can no longer be read.
- **Leftovers:** a container left over from a crash is removed at launch, when the last session ends, and on `figma.on('close')`.
- **Launch gate:** creating and removing an empty container at launch tests for edit access.
- **Library variants:** importing a library variant with `importComponentByKeyAsync` adds that component to the designer's file, as using it in Figma would. The panel says so before launch when the flow needs one.

### One render

1. **Copy.** Copies the current frame, and each open overlay, into the container.
2. **Apply state to the copies.**
   - Variant overrides: `setProperties`, or `swapComponent` to the stored variant.
   - Modes: `setExplicitVariableModeForCollection` on the copies, for the page's and frame's explicit modes and the state's modes.
   - Values assigned by `SET_VARIABLE`: the bound property is unbound on the copy and the computed value is written (text characters, visibility, fills, numeric properties).
   - Overlays: positioned and given their backgrounds.
   - Scroll: the scroll offset is applied, with fixed children pinned.
3. **Fonts.** Writing text first loads every font in the node with `loadFontAsync`. If a font is missing (`hasMissingFont`), the text is left as designed. The render returns `notes: [{missing_font: …}]`, and the panel shows a banner.
4. **Measure.** Walks the copies in z-order. For each layer it records a `RawLayer`: logical key, type, name, text, box in viewport coordinates, whether it is visible, whether it has reactions, its role hints, and its parent key.
   - The **logical key** is the original layer id, matched by walking the original and the copy in parallel.
   - Inside a swapped instance, the key is the instance's key plus the child's path in the variant.
5. **Export.** Exports the viewport as JPEG at 1x; Figma's export has no quality setting, so it uses Figma's own. A screenshot over the turn's 1.5 MB cap fails the render with its size. For the replay, `ingest_step` keeps at most six screenshots of 1 MB per run, as for every plugin run.
6. **Delete** the copies.

### Element list (`elements.ts`)

From the measured layers, the persona gets everything visible inside the viewport:
- **What's listed:** text blocks, instances, and frames or shapes that look actionable (filled or stroked with a label, or named like a control).
- **Wired but invisible:** layers that carry reactions but draw nothing, such as hotspots over screenshots, are listed as "unlabeled area" unless their name is readable. Without them, prototypes built from screenshots couldn't run. This tells the persona those areas exist, which is the price of supporting such prototypes.
- **Wiring is never exposed.** Each element is `{id: "e<n>", label, role, box}`, in reading order, with roles `button`, `link`, `text`, `card`, `input`, `icon` and `image`.
- **Labels:** the text inside the layer, otherwise a readable layer name. A generic name such as `Rectangle 12` or `icons8-help-32 1` gets the role word, for example "icon".
- **Size limit:** at most 80 elements. Text blocks are trimmed first, then the smallest elements.
- **Below the fold:** elements below the viewport are not listed. Scrolling is how the persona finds them, as on a real page.

### Step URL

- **With a share link:** `https://www.figma.com/proto/<key>/<page>?node-id=<frame>&overlay=<ids>`.
- **Without one:** `figma-trace://<page>/<frame>?node-id=<frame>&overlay=<ids>`.

In both, node ids use `-` instead of `:`, as Figma does, and the page name is percent-encoded with `encodeURIComponent`, because `new URL("figma-trace://My Page?…")` throws and the panel's `nodeIdFromUrl` would then lose the persona's screen. Putting the frame in the path of `figma-trace://` URLs gives `_page_key` (host plus path) one page per frame, so `pages_visited`, backtracks and lostness mean something for these runs.

## Data flow

1. **Launch gate.** The panel runs the scratch container check. If it fails, launch is blocked with "Duplicate to your drafts to test".
2. **Create.** As today, with `source: "figma"` and `execution: "plugin"`, then factors → archetypes → first wave. The panel stores the owner, the start frame, the page id and the library-import choice with the study in `clientStorage`; each run's saved state carries its own `ProtoDoc` hash.
3. **Claim.** For every queued run: `POST /runs/<id>/claim` with `{browser: {engine: "figma-trace", version, viewport}, owner}`. `owner` is a random id kept by this panel. The briefing is the same one actors get today. A repeated claim by the run's own owner returns the same briefing, so a claim retried after a lost response isn't refused as `already_claimed`. Right after each claim the panel saves `{owner, runId, turn: 0, state: <start state>, lastOutcome: null}` and starts that run's session without waiting for the other claims.
4. **Turn n.** The panel settles, renders, lists the elements and posts:

```jsonc
POST /api/plugin/runs/<id>/turn
{ "owner": "p_7f3a…", "turn": 7,
  "screen": { "url": "figma-trace://Prototype/2-20?node-id=2-20&overlay=3-1", "title": "Connect bank",
              "frameId": "2:20", "overlays": ["3:1"], "viewport": [1280, 900],
              "scroll": { "x": 0, "y": 340, "maxX": 0, "maxY": 1520 } },
  "screenshot_b64": "<JPEG>",
  "elements": [{ "id": "e4", "label": "Continue", "role": "button", "box": [880, 610, 120, 44] }],
  "visible_text_excerpt": "Connect your bank · Instant · Enter details",
  "last": { "action": { "type": "click", "element": "e2" }, "outcome": "nothing_happened",
            "target": "Use routing number instead (e2)" },
  "flags": [],                              // file_changed, timer_loop, missing_font when they apply
  "elapsed_s": 41.2, "client_ts": "2026-11-09T21:04:11Z" }
→ 202 { "turn": 7, "status": "thinking" }
```

The backend accepts turn n only when n is one past the last decided turn. The exception is a re-post of the current turn, which is idempotent: it returns the existing record and never calls the model again. Any other n gets `409 turn_out_of_order` with `expected`. A wrong owner gets `409 not_owner`.

5. **The brain task, one model call per turn.**
   - **The prompt contains:**
     - the persona briefing and archetype beliefs
     - the recall slate and the active rules returned by the latest `ingest_step`
     - the patience `note` from the latest `ingest_step`, if any, such as the give-up review
     - the last action and its outcome
     - the screenshot, the elements and the visible text
   - **The answer contains:**
     - `reflection`: the `after` block of step n−1 (friction, sentiment, progress, hesitation, trust request, remember)
     - `observe`: page type, summary, what stood out
     - `decide`: monologue, intent, action text, confidence, rule applied
     - one `action`
   - **Then the task:**
     1. Validates the action. The element id must be in this turn's list.
     2. Completes step n−1 with that `reflection` and the panel's outcome, and stores it through `ingest_step`.
     3. Stores turn n as the run's pending step.
   - **Known trade-off:** the patience state the model saw is the one after step n−2. A give-up review raised by step n−1 reaches the model one turn later. This keeps one model call per turn. If `ingest_step` reports `state.ended` (patience exhausted twice), turn n's decision is discarded and the run is finalized as `abandoned`.
6. **Poll.** `GET /runs/<id>/turn/7` every 1 s, backing off to 3 s.

```jsonc
{ "turn": 7, "status": "ready", "action": { "type": "click", "element": "e4" },
  "state": { "seq": 6, "maxSteps": 40, "unproductive": 1, "maxUnproductiveSteps": 6, "progress": 55,
             "sentimentTrend": "steady", "reviewGiveUp": false, "ended": false, "endedReason": null },
  "ended": null }
// status "failed":  { "turn": 7, "status": "failed", "error": { "code": "brain_invalid_action", "message": "…" },
//                     "ended": { "status": "aborted", "reason": "brain_invalid_action" } }
// ended, when set:  { "status": "finalizing" | "completed" | "abandoned" | "aborted", "reason": "…" }
```

A turn that ends the run is marked decided with `ended.status: "finalizing"` before the debrief starts; `GET /turn` later shows the final status. The 150 s deadline applies only to undecided turns, and once `ended` is set the panel stops that session and never aborts it.

7. **Apply and save.** The panel maps the element back to its point and applies the action. It then saves `{owner, runId, turn, state, lastOutcome}` to `clientStorage` under the study.
8. **End.** When the model answers `done` or `give_up`, or patience ends the run:
   - The task marks the turn decided with `ended.status: "finalizing"` and sets the run's finalizing marker, so neither the deadline nor `/abort` can touch it.
   - It completes the last step and makes the debrief call.
   - The debrief produces exactly the payload the Claude actor's `report_result` sends. Nesting and snake_case keys are as `_validate_ingest_payload` and `_outcome_and_metrics` read them:

```jsonc
{ "sessionId": "<from the claim briefing>",
  "status": "completed" | "abandoned",
  "steps": [],                                   // every step was already stored turn by turn
  "feedback": {
    "verdict": "pass" | "fail" | "mixed",
    "summary": "…",
    "personaReaction": "…",
    "scenarioResults": [{ "scenarioId": "…", "status": "pass" | "fail" | "blocked", "actualResult": "…" }],
    "findings": [{ "scenarioId": "…", "category": "…", "severity": "…", "description": "…",
                   "evidenceStepSeq": 6,
                   "evidence": { "url": "<step url>", "selector": "<layer path>", "quote": "…" } }],
    "outcome": { "completed": false, "quit_reason": "<QUIT_REASON_ENUM value>",
                 "abandoned_at_step": 8, "in_their_words": "…" } } }
```

   - The payload is validated with `_validate_ingest_payload` before it's stored. A malformed debrief is asked for once more. If it's still malformed, the run is aborted with `debrief_invalid`.
   - Results are stored through `ingest_results`, including its post-session analytics. Only then does `GET /turn` show the final `ended.status`. The panel never posts results.
9. **Next wave.** When every session of the wave has ended, the panel calls `POST /api/studies/<id>/runs/next` and claims the new runs. This repeats until the backend answers `done`. On `wave_in_progress` the panel reads the study's runs, claims any queued ones (a next wave that committed but whose answer was lost), and names the open runs it isn't running; after 5 minutes it shows Try again.
10. **Resume.** When the panel reopens on a running study, it continues only runs it owns: the saved owner matches, and the backend still shows the run `running`. A finished study starts no runner. If the designer is on another page than the study's, the panel asks to go to that page first. Runs with no saved state are left alone, because another panel may own them; the 20-minute watchdog covers truly orphaned ones. Before resuming, the panel re-reads the `ProtoDoc` and compares its hash with each run's saved state. If the file changed, every resumed run gets the `file_changed` flag, and a run that must catch up on turns the backend already decided is aborted with `file_changed`, because its stored actions may name different layers now. A run whose saved frame or overlay no longer exists is aborted with `file_changed`.

## Error handling

Every failure is visible; nothing falls back silently. A failure that is not the
persona's doing ends the run as `aborted` with an `abort_reason`, which the
report excludes from persona outcomes. `failed` is never used for these.

| Failure | Who detects | Behavior |
|---|---|---|
| No edit access | panel | Launch blocked: "Duplicate to your drafts to test". |
| Render throws or exports an empty image | panel | One retry, then `POST /abort` with `render_failed: <reason>`. |
| The model's answer is malformed, or names an element that isn't listed | backend | It asks again once, with the error. Then the turn is `failed`, and the backend aborts the run with `brain_invalid_action`. The panel stops that session; it doesn't re-post. |
| Model rate limit or timeout | backend | The task retries with backoff until the turn's deadline (150 s from creation). Then the turn is `failed` and the run is aborted with `model_unavailable`. |
| Task lost or worker down | backend | `GET /turn` checks the deadline, which applies only to undecided turns. An expired, undecided turn becomes `failed`, and the run is aborted with `turn_timeout`. A turn marked `finalizing` is never timed out. |
| No answer to the panel's poll | panel | After 180 s with the turn still `thinking`, it posts `POST /abort` with `turn_timeout`. Once `ended` is set, the panel never aborts. |
| Bridge request times out (30 s) | panel | One retry. A render then follows the render rule above. |
| 401 | panel | The existing sign-in flow. A 503 `auth_unavailable` pauses the sessions and keeps the token. |
| 409 `run_ended` or `not_owner` | panel | That session stops. |
| 409 `turn_out_of_order` | panel | The panel re-reads `GET /turn/<expected − 1>` and continues from there. |
| `POST /runs/next` answers 409 `wave_in_progress` | panel | Finalizing runs stay `running` until `ingest_results` and its analytics finish, so the runner waits and retries, as `launch.ts` does for that code, for up to 5 minutes. After that it shows the error with a Try again button. |
| Network loss | panel | Sessions pause, and the panel shows "Lost touch with Archetype". |
| Unsupported feature | engine | Outcome `unsupported`, as above. |
| Timer loop | engine | Flag `timer_loop`, and the run continues. |
| Missing font | renderer | Flag `missing_font`, the text is left as designed, and a banner shows. |
| Flow edited mid-run | panel | `PageNode.on('nodechange')` on each page that holds `ProtoDoc` frames. `figma.on('documentchange')` would need `loadAllPagesAsync()` under `dynamic-page` access. A change to a `ProtoDoc` frame outside the scratch container adds the `file_changed` flag and a banner. The engine keeps the launch-time `ProtoDoc`; renders use live nodes. |
| Panel in a background browser tab | panel | Browsers slow timers in hidden tabs. The panel measures how late its timers fire and shows "Keep this tab visible, or use the desktop app". |

## Testing

Test first, as in the rest of the repo.

- **Engine** (Vitest, table driven): every action, trigger and outcome above.
  Also: expression operators including `VAR_MODE_LOOKUP`, every overlay position with close-on-outside, back and swap, scroll with fixed children and at the ends, timer settling and the loop guard, conditionals, variable modes, `CHANGE_TO` with the new variant's reactions, `resetInteractiveComponents`, the pointer model, and hit-testing by point (a transparent hotspot over an image, an overlay blocking the layers below).
- **Elements:** labels never show generic names, roles, the viewport cut, the 80-element cap, invisible wired layers, and unwired elements included.
- **protoReader:** reactions, delays, variables and modes, variants from another page and from a library, overlay settings, `skipInvisibleInstanceChildren` handled.
- **Renderer:** copies land in the scratch container, overrides and modes are applied, measured boxes come from the copies with keys mapped back to the originals, copies are removed even when export throws, originals are untouched, and the missing-font note.
- **Bridge, session and runner** with a mocked API:
  - parallel requests get their own replies
  - a whole wave runs in parallel, with polling and backoff
  - out-of-order recovery, owner checks, and resume of owned runs only
  - the next-wave loop, including waiting out `wave_in_progress` while runs finalize
- **Backend** (pytest, tier 0):
  - turn idempotency and ordering, the deadline and `turn_timeout`, and the owner check
  - a finalizing run is never timed out or aborted, and a slow debrief plus analytics still ends `completed` or `abandoned`
  - `figma-trace://` step URLs: `frame_reached`, `_page_key` per frame, and `_safe_url` keeping them as text
  - completing the previous step (`ok` and `no_change`, `act.target`, and `error_message` only for `unsupported`)
  - the patience review delivered in the next turn, and `state.ended` finalizing as `abandoned`
  - the brain validation retry, the debrief schema against `_validate_ingest_payload`, and `debrief_invalid`
  - abort codes; the `figma-trace` engine; `execution: "plugin"` with null `file_key` and `task.url`; the `list_studies` filter
  - the CORS allowlist and the `trace` queue routing
- **Plugin repo:** `dispatch_study` refuses plugin-mode studies (`test_core_server.py`).
- **Test infrastructure:**
  - `tests/fake-figma.ts` gains clone, plugin data, `exportAsync`, variables and modes, `getMainComponentAsync`, `importComponentByKeyAsync` and fonts.
  - The harness host serves `ProtoDoc` and renders.
  - `harness/mock-backend.mjs` gains claim, turn, abort and next-wave.
- **End to end:** the harness runs a study on the Farside billing fixture. The golden path completes, a misclick is logged, the overlay opens, and the broken link shows. Then a manual run on the Farside Oxygen+ file.

## Delivery phases

Each phase is its own set of commits with green checks:
1. **Backend turn API with a stub brain:** routes, `trace_turns`, the `trace` queue, abort, owner, the new `execution` and engine values, and CORS. The stub returns fixed actions.
2. **Engine and elements:** pure modules and their tests.
3. **Reader and renderer:** plus the fake-figma extensions.
4. **Bridge, session and runner** in the panel, against the mock backend.
5. **The real trace brain and debrief:** prompts, parsing and validation.
6. **Integration:** the manifest text, docs, the harness end-to-end, and the manual run on a real file.

## Out of scope

- A hosted runner or server-side simulation (options A and B).
- Runs in view-only files.
- Video playback inside prototypes.
- Changes to the study report page. The notes and counts are stored, and showing them is a follow-up.
