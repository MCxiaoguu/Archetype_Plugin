# Figma flow map: the prototype as a state diagram, testing as traversal

## Problem

A wireframe is never fully wired, but the trace runner treats it as if it were.

- **What Figma gives us:** Figma exposes only the connections a designer drew (`reactions`).
- **What the runner does with the rest:** every visible element is clickable (the trace runner's "Everything visible" decision). A click on an element with no connection gives `nothing_happened`. That outcome counts against the persona's patience as `no_change`, and the debrief reports it as a defect.
- **What it costs, from a local run on 2026-11-10 (Farside Oxygen+, 5 personas, 53 turns):**
  - 23 turns hit unwired elements:
    - the header's "Oxygen+" link, which has a matching frame, "Oxygen+ plans"
    - the logo, "Holidays", "Mission Control" and "Manifest", which have no frame
    - the checkout radios and "Annual", which are form controls
  - Four personas quit, saying "navigation unresponsive".
  - The report ranked "Unresponsive navigation links" a catastrophe.

  That is a judgement on the wireframe's incompleteness, not on the design.

## Goal

When a test run is launched, the prototype becomes a **flow map**: a state diagram the backend completes once and stores with the study. Testing becomes deterministic traversal of that map.

- **What the map holds:** the drawn connections, plus the backend's reading of every unwired element.
  - an **inferred transition** to a frame the prototype has
  - a **control** that accepts input
  - a **gap**: no page exists behind it
- **What the persona experiences:** a working product. When it reaches a gap, it is told plainly that nothing is behind it, so it can name the missing feature.
- **What the report shows:** paths, completion, drop-offs, feature needs and inferred transitions. It shows no usability findings.
- **The panel:** a Flow map shows the graph. During a run, highlights move between nodes as personas step through it. Past studies' paths load from the database.

## Decisions (from the user, 2026-11-10)

| Question | Decision |
|---|---|
| When the map is built | When a test run is launched: before every batch of claims (a new test, each wave, a resume, a lost wave). Not when the plugin opens. |
| Who confirms the completed map | Nobody has to. The completed map is used by default; an **Edit map** button lets the designer change any reading. |
| What the persona hears at a gap | That there is no page behind that element ("There's no page behind 'Holidays' in this product yet."), so it recognizes a feature need. |
| Usability findings in Figma tests | Not shown. Figma reports show flow results and feature needs instead. |
| Is the persona told it is testing an early design | No. The screens are the real product to it, so no prompt says "prototype" or "early design". Only the gap message says something is missing. |
| On the canvas | Nothing is drawn on the canvas. The **Follow persona** viewport moves and the paths stay until cleared (both kept from the earlier demo discussion). |

## The flow map

Each version is an immutable row in `Archetype_Test.study_flow_maps`, keyed `(study_id, version)` and unique on that pair.

```jsonc
{
  "studyId": "s_…", "version": 3, "baseVersion": 2,
  "inputHash": "9c1e…",               // hash of the nodes, edges and candidates sent; one build per hash
  "docHash": "1f3f7a490a9908",        // the ProtoDoc it was read from (for display only)
  "nodes": [ { "id": "2:2", "kind": "frame", "name": "Oxygen+ plans", "pageId": "0:1",
               "heading": "Air you never have to think about." },
             { "id": "3:1", "kind": "overlay", "name": "Bank sign in error", "pageId": "0:1",
               "heading": "We couldn't reach your bank" } ],
  "edges": [ { "id": "d1", "from": "2:2", "to": "2:293", "layerKey": "2:91", "label": "Choose Breathe",
               "trigger": "ON_CLICK", "action": "NAVIGATE" } ],
  "readings": [ { "id": "r7", "shareKey": "C:12:4;1:17", "nodes": ["2:2", "2:293", "3:124"],
                  "layerKeys": ["I2:3;1:17", "I2:300;1:17", "I3:125;1:17"],
                  "label": "Oxygen+", "role": "link",
                  "kind": "edge", "to": "2:2", "by": "model", "reason": "The nav item names the plans page." },
                { "id": "r9", "shareKey": "C:12:4;1:15", "label": "Holidays", "kind": "gap", "by": "model", "…": "…" },
                { "id": "r12", "shareKey": "L:3:124:3:171", "label": "Annual", "kind": "control", "by": "model", "…": "…" } ],
  "dropped": [ { "label": "Annual", "reason": "its target frame 9:9 is no longer in the file" } ],
  "completedAt": "2026-11-10T21:40:00Z", "model": "google:gemini-2.5-flash"
}
```

- **Nodes:** the ProtoDoc's frames (`kind: frame`) and the frames reached only as an overlay (`kind: overlay`, a frame whose every incoming drawn edge is `OVERLAY`).
  - Each node has a `heading`: its largest visible text, at most 120 characters.
  - Variant, variable and scroll state stay inside the engine. They are not nodes.
- **Edges:** every drawn `NODE` action with a destination, for display and paths.
  - `NAVIGATE`, `SWAP`, `OVERLAY` and `SCROLL_TO`.
  - Those inside variants, and inside `CONDITIONAL` branches, with `conditional: true`.
- **Readings:** one per **share key**. Candidates inside instances of one main component share one reading:
  - inside an instance: `shareKey` is `C:<mainComponentId>;<path inside it>`
  - otherwise: `L:<node>:<layerKey>`

  So a header repeated across 30 frames has one reading per item, and one edit changes it everywhere.
- **Reading fields:**
  - `kind`: one of
    - `edge` (`to` must be a **frame** node; an edge to the clicked node's own frame means "already here")
    - `control`
    - `gap`
  - `by`: `model`, `designer` or `bulk_gap`.

## Building and completing it

### Candidates: the main thread, from the original nodes, without rendering

A candidate is a layer that **has no reaction of its own**. The candidate list covers:

- **Which layers:** every layer of every node, **hidden ones included**, since a variable or variant may show them. That includes each `variantSets` variant's layers, keyed `<instanceKey>;<path>` exactly as `readVariant` keys them.
- **Which roles:** `elements.ts`'s role and label rules (button, link, input, card, icon, image with a readable name), **without** the viewport cut, `covered`, clipping or the 80-element cap.
- **Text:** a text layer is a candidate only as a single line of at most 6 words, such as a plain nav item. Paragraphs are not.
- **Per candidate:** key, share key, label, role, box in frame coordinates, and the 200 characters of visible text nearest to it.

### At launch: the panel

1. **When:** before **every** batch of claims (a new test, each wave, a resume and a lost wave), the panel lists the candidates.
2. **Commit:** it posts `POST /api/studies/<id>/flow-map` with `{baseVersion, docHash, nodes, edges, candidates}`.
   - **Same input:** if the latest version's `inputHash` matches, the backend answers `200 {status: "ready", map}` at once.
   - **New input:** otherwise it answers `202 {status: "building", buildId}` and starts the completion task. The panel polls `GET /api/studies/<id>/flow-map/builds/<buildId>`.
   - **Concurrent posts:** two panels posting the same `inputHash` share one build.
3. **Claims:** each claim body carries the `flowMapVersion` the panel will play. The backend refuses a version that isn't the study's current one with 409 `flow_map_stale`, and the panel re-reads the map and commits again.
   - The run stores the version: `test_meta.flow_map_version` and `SavedSession.flowMapVersion`.
   - A resumed run fetches its own version with `GET /flow-map?version=n`.

### The backend completes it

- **Where it runs:** a Celery task on the `trace` queue, `flow_map_build(study_id, build_id)`.
- **What carries over:**
  - Readings whose share key, label and role are unchanged since `baseVersion` are kept as they were.
  - `designer` readings are kept while their candidate exists.
  - A `designer` reading whose `to` frame is gone is dropped and listed in `dropped`.
  - Everything else is asked.
- **One model call per node** with unread candidates, in parallel, through the shared `LLMClient`: `gemini-2.5-flash`, `thinking_budget=0`, no history, with a JSON schema.
  - **Input:** the node's name, heading and visible text (at most 1,500 characters), its candidates, and every frame node's `{id, name, heading}`.
  - **Output:** `{shareKey, kind, to?, reason}` per candidate.
  - A share key read on several nodes is asked once, on the first.
- **Validation:** every candidate is answered exactly once, and `to` is a frame node id.
  - An invalid answer is asked again once, with the error.
  - 429s and timeouts back off and retry within a 180 s build deadline.
- **Partial results:** each node's result is kept on the build, so Try again asks only the nodes that failed.
- **Outcome:** the build ends `ready` with a new version, or `failed` with `{node, reason}`. Nothing is guessed.

### When the map can't be completed

At launch, or before a later wave (the runner phase `map_failed`), the panel shows "Couldn't read the flow of '<frame>': <reason>." with two buttons:

- **Try again**
- **Launch with drawn connections only**: an explicit choice. It commits the map with every unread candidate as a `gap`, marked `by: "bulk_gap"`, and a later rebuild asks those again.

There is no silent fallback.

### Editing

- **Where:** **Edit map** in the Flow map view lists the readings frame by frame. The designer sets each one to an edge to a chosen frame, a control, or a gap.
- **The request:** `PATCH /api/studies/<id>/flow-map/readings/<readingId>` with `{baseVersion, kind, to?}`.
  - It is compare-and-set: a `baseVersion` that isn't current gets 409 `flow_map_changed`, and the panel reloads.
  - It writes a new version with `by: "designer"`.
- **When an edit takes effect:** runs claimed after the edit play the new version. A run in progress keeps its own version.

## Traversal

The engine applies drawn reactions exactly as today. The map changes only what happens when a **click** or a **`type`** reaches a layer that no reaction handles.

- **`handled`:** `click()` returns `handled`: whether any of `MOUSE_DOWN`, `ON_PRESS`, `MOUSE_UP` or `ON_CLICK` bubbled to a layer that has that reaction (`reactionsFor`, current state).
  - It is true even when the reaction changed nothing visible, for example a null destination, a `CHANGE_TO` to the variant already shown, a false `CONDITIONAL`, or a delayed mouse reaction that only set a timer.
- **Lookup:** a reading applies only when the hit is not null, `handled` is false, and the action named an element. It is the reading for **that element's own layer** (`targets[e].layerKey`, through its share key) in the run's map version.
  - No other ancestor is consulted.
  - Its outcome replaces any `changed_state` or `opened_overlay` the pointer move produced.
  - No reading applies if the move itself navigated.
- **`type`:** `type` into an element whose reading is a `control` gives `accepted`. Otherwise it gives the usual `typed_nothing`.
- **Hover, press, keys and drags** are unchanged.

| Reading | What the engine does | Outcome | `act.result` | The persona's next turn says |
|---|---|---|---|---|
| `edge` to another frame | Navigates there as a drawn `NAVIGATE` would: history pushed, scroll reset, overlays closed, `resetInteractiveComponents` false | `navigated`, with `last.reading` | `ok` | "A new screen opened." (the same words as a drawn link) |
| `edge` to the clicked node's own frame | Nothing changes | `already_here` | `ok` | "You're already on this page." |
| `control` | Nothing changes on screen | `accepted` | `ok` | "You selected '<label>'." |
| `gap` | Nothing changes | `missing` | `ok` | "There's no page behind '<label>' in this product yet." |
| none, for an element of a candidate role with no reading | As today | `nothing_happened`, plus a `map_miss` run note | `no_change` | "Nothing happened." |
| none, otherwise (a paragraph) | As today | `nothing_happened` | `no_change` | "Nothing happened." |

- **The label:** it is always the clicked element's own label.
- **The contract:** `TurnLast.outcome` gains `already_here`, `accepted` and `missing`. `last.reading` (a reading id) is required with them and with an inferred `navigated`, and forbidden otherwise. The backend checks it against the run's map version.
- **Patience:**
  - In `run_protocol.advance()`, a step with `accepted`, `already_here` or `missing` is not unproductive: the progress-stall clause is skipped for it. The trace outcome reaches `advance()` on the step record, since `extra.trace` is written after `ingest_step`.
  - A gap or a control therefore never costs patience on its own, and runs stay bounded by `max_steps`.
- **Step lines:** `trace_brain._step_line` describes trace steps by their outcome's words, so a later turn or the debrief never describes a gap click as working.
- **What the persona is told:** it is never told a transition was inferred. The sample-data sentence loses its "early design" wording: "Names, numbers and other content on the screens are examples, not your own account, and are not a defect to report." No prompt says "prototype" or "early design".

## What the report shows for Figma plugin studies

This section applies to `execution: "plugin"` studies. Remote Figma studies run by the Claude actor are unchanged.

- **The debrief:**
  - It sends `findings: []` exactly; anything else is asked again.
  - It adds `feedback.needs: [{stepSeq, text}]`: what the persona looked for and didn't find, in its own words.
  - A need citing a non-gap step is grouped under that step's node.
- **The report:** it omits the findings section and gains `flow`:
  - **paths:** per run, the node sequence with each step's action label, outcome and reading id
  - **completion:** reached the goal frame or not
  - **drop-offs:** the node where a persona gave up or ran out of steps
  - **feature needs:** gap clicks grouped by reading, with personas and tries, plus the persona's words from that step's monologue and the debrief's needs
  - **inferred transitions used:** each reading the personas used, so the designer can wire it
  - **map misses:** the count of `map_miss` notes
- **The narrative:** recommendations, answers and benchmark are built from `flow.feature_needs` and the inferred transitions, citable through `_valid_refs`, instead of from finding clusters.
- **The fingerprint:** the report fingerprint includes the map versions played.

## The Flow map in the panel

- **Where:** a Flow map card on the Running and Report screens, and on a past study opened from History.
- **The graph:** nodes are laid out left to right in breadth-first order from the start node.
  - Drawn edges are solid lines, inferred edges dashed lines, and gaps short stubs ending in a dot.
  - A visited node shows the screenshot the persona saw there; otherwise it shows its name.
- **Live:**
  - Each persona is a colored token on its node. On each turn the token moves, the edge it took lights up, and the old and new nodes alternate their highlight briefly.
  - An `accepted` or `missing` outcome pulses the node, with the gap's label for a gap.
  - A give-up or a completion marks the persona's last node.
- **Follow persona:** click a persona to follow it. On each of its turns the main thread calls only `figma.viewport.scrollAndZoomIntoView([frame])`.
  - It never changes the selection or the current page; it doesn't use `showNode`.
  - When the frame is on another page, the card says "On page <name>", and the viewport stays.
- **Paths stay until cleared:** **Clear paths** hides them for that study until the panel reopens it. That is panel state only; loading the study again from the database shows them again.
- **Past studies:**
  - `GET /api/studies/<id>/flow-map` gives the current map, `?version=n` a given one, and 404 `flow_map_not_found` when the study has none.
  - `GET /api/studies/<id>/paths` gives each run's node sequence, from its steps. The step URL carries the frame and overlays, and steps gain the reading id and map version.

## Backend changes

| Change | Where |
|---|---|
| `study_flow_maps` with a unique index on `(study_id, version)`; builds | `infrastructure/database/indexes.py`, new `services/flow_map_service.py` |
| `POST /flow-map` (202 or 200), `GET /flow-map[?version]`, `GET /flow-map/builds/<id>`, `PATCH /flow-map/readings/<id>`, `GET /paths` | `api/routes_studies.py`; and in `app.py`, `FIGMA_PLUGIN_ROUTES` |
| The completion task on the `trace` queue; prompt, schema, validation, one re-ask, backoff | `tasks/trace_tasks.py`, `services/flow_map_service.py`, `simulation_core/flow_map_brain.py` |
| The claim's `flowMapVersion` (409 `flow_map_stale`), and the run's `flow_map_version` | `services/plugin_run_service.py` (`claim_run`) |
| The new outcomes and `last.reading`, checked against the run's version | `services/trace_turn_service.py` (`_clean_last`) |
| Patience for the new outcomes | `services/run_protocol.py` (`advance`), `services/trace_decide.py` (the record) |
| Outcome words and step lines; the sample-data sentence; `findings: []` and needs in the figma debrief | `simulation_core/trace_brain.py`, `services/trace_decide.py` |
| The report's `flow` section; no findings for plugin studies; narrative inputs; fingerprint | `services/study_report_service.py` |
| Docs | `docs/studies-api.md`, `docs/openapi.json` |

## Plugin changes

| Change | Where |
|---|---|
| Candidates from the original nodes (variants and hidden layers included, share keys) | `src/main/flowMap.ts` (new), `src/main/trace.ts` (`trace-candidates`) |
| Committing before every batch of claims; build polling; the `map_failed` phase and its two buttons | `src/ui/trace/launch.ts`, `src/ui/trace/runner.ts`, `src/lib/api.ts` |
| `handled` from `click()`; reading lookup by the element's layer; the new outcomes; `type` on controls | `src/lib/proto/engine.ts`, `pointer.ts`, `outcome.ts`, `model.ts` |
| `last.reading`, `flowMapVersion` in claims and `SavedSession` | `src/ui/trace/session.ts`, `runner.ts`, `src/lib/turn.ts`, `src/main/storage.ts` |
| The Flow map card, Edit map, Follow persona, Clear paths, past paths | `src/ui/screens/flowmap.tsx` (new), `src/lib/flowLayout.ts` (new), `src/main/canvas.ts` (follow) |
| The report view without findings, and with `flow` | `src/lib/report.ts`, `src/ui/screens/report.tsx` |
| The mock backend's maps, builds, versions, readings, outcomes and paths | `harness/mock-backend.mjs` |

## Error handling

| Failure | What happens |
|---|---|
| The build fails after its deadline | Launch, or the runner as `map_failed`, shows the node and the reason, with Try again or Launch with drawn connections only |
| The claim's `flowMapVersion` isn't current | 409 `flow_map_stale`. The panel commits again and claims with the new version. |
| PATCH or rebuild on a stale `baseVersion` | 409 `flow_map_changed`. The panel reloads the map. |
| A turn's `last.reading` isn't in the run's version, or is missing where required | 400. The session reports `engine_error` with the backend's message. |
| A reading's `to` isn't in the doc | `EngineError('invalid_doc')`, which aborts with `engine_error`. Builds never produce one: dropped readings are listed. |
| `GET /flow-map` for a study without one | 404 `flow_map_not_found` |
| `GET /paths` for a study with no plugin runs | `200 {runs: []}` |

## Testing

- **Unit, plugin:**
  - **`handled`:** a null destination, a `CHANGE_TO` to the current variant and a delayed `MOUSE_UP` are all `handled`, and get no reading.
  - **Lookup:** a paragraph inside a header instance gets no reading.
  - **Candidates:** hidden and variant layers are listed, a 7-word line is not, and share keys are equal across frames.
  - **Outcomes:** each reading's outcome, `type` on a control, and hover never uses readings.
  - **Follow persona:** sends only viewport moves.
- **Unit, backend:**
  - **Builds:** reuse by `inputHash`, readings carried over, a dropped designer reading, `bulk_gap` asked again, the deadline and partial retry, and one build per hash.
  - **Versions and claims:** immutable versions, claims with `flow_map_stale`, PATCH with `flow_map_changed`.
  - **`_clean_last`:** `last.reading`.
  - **`advance()`:** the new outcomes don't stall.
  - **Prompts:** step lines, and no "prototype" or "early design" in any prompt.
  - **Debrief:** `findings: []` and needs.
  - **Report:** `flow` and the narrative inputs.
  - **Paths.**
- **End to end, plugin (mock):** the fake Farside page with a scripted map.
  - "Use routing number instead" is a gap and gives `missing`.
  - A nav label is an edge to Dashboard, and a radio is a control.
  - The golden path completes, and no candidate gives `nothing_happened`.
  - A resume plays its own map version.
- **End to end, backend (in process):** a plugin study commits a map, a run uses an inferred edge and a gap, and the report's `flow` lists the feature need and the inferred transition.
- **Live:** the real Farside Oxygen+ file through the local server.
  - **Pass, deterministic:** the stored map reads Oxygen+ as an edge to "Oxygen+ plans" and Holidays and Mission Control as gaps, in every frame that shows them. The checkout radios and "Annual" are controls.
  - **Pass, behavioural:**
    - every gap click in the runs appears in `flow.feature_needs`
    - no persona gives up citing unresponsive navigation
    - the Flow map shows each persona's path

## Delivery phases

1. **Map:** versioned storage, the async build, candidates, the commit before claims, and the error path.
2. **Traversal:** `handled`, readings, the outcomes, the contract, patience and the persona's words.
3. **Report:** the figma debrief's needs, `flow`, no findings, the narrative inputs, and the panel's report view.
4. **Flow map card:** the live view, Follow persona, Clear paths, and past paths.
5. **Edit map.**

## Out of scope

- Drawing on the canvas.
- Inferring transitions for hover, press, key or drag triggers.
- Changing the web app's study report beyond what the backend's report returns.
