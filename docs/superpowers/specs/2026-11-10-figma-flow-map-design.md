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
| When the map is built | When a test run is launched: Launch on a new test, or each new wave. Not when the plugin opens. |
| Who confirms the completed map | Nobody has to. The completed map is used by default; an **Edit map** button lets the designer change any reading. |
| What the persona hears at a gap | That there is no page behind that element ("There's no page behind 'Holidays' in this product yet."), so it recognizes a feature need. |
| Usability findings in Figma tests | Not shown. Figma reports show flow results and feature needs instead. |
| Is the persona told it is testing an early design | No. It treats the screens as the real product; only the gap message says something is missing. |
| On the canvas | Nothing is drawn on the canvas. The **Follow persona** viewport moves and the paths stay until cleared (both kept from the earlier demo discussion). |

## The flow map

```jsonc
{
  "version": 3,                       // +1 on every rebuild or edit
  "docHash": "1f3f7a490a9908",        // the ProtoDoc it was built from
  "nodes": [ { "id": "2:2", "kind": "frame", "name": "Oxygen+ plans", "heading": "Air you never have to think about." },
             { "id": "3:1", "kind": "overlay", "name": "Bank sign in error", "heading": "We couldn't reach your bank" } ],
  "edges": [ { "id": "d1", "from": "2:2", "to": "2:293", "layerKey": "2:91", "label": "Choose Breathe",
               "trigger": "ON_CLICK", "by": "designer" } ],          // the drawn reactions that change screens
  "readings": [ { "id": "c7", "node": "2:293", "layerKey": "I2:3;1:17", "label": "Oxygen+", "role": "link",
                  "kind": "edge", "to": "2:2", "by": "model", "reason": "The nav item names the plans page." },
                { "id": "c9", "node": "2:293", "layerKey": "I2:3;1:15", "label": "Holidays", "role": "link",
                  "kind": "gap", "by": "model", "reason": "No frame covers holidays." },
                { "id": "c12", "node": "3:124", "layerKey": "3:171", "label": "Annual", "role": "button",
                  "kind": "control", "by": "model", "reason": "A billing period choice." } ],
  "completedAt": "2026-11-10T21:40:00Z", "model": "google:gemini-2.5-flash"
}
```

- **Nodes:** the ProtoDoc's frames and overlays.
  - Each node carries a `heading`: its largest visible text, at most 120 characters.
  - Variant, variable and scroll state stay inside the engine. They are not nodes.
- **Edges:** the drawn `NODE` actions that change the screen: `NAVIGATE`, `SWAP`, `OVERLAY`, `BACK`/`CLOSE` are implicit. They come from `ProtoDoc.reactions` with their trigger.
- **Readings:** one per **candidate**, a visible element with no reaction on itself or any ancestor that would catch the click.
  - **Which elements:** the candidates are listed per frame by `elements.ts`'s rules. Wiring still never decides what is listed. Only elements with role `button`, `link`, `input`, `card` or `icon`, or with a readable label, are candidates. Plain paragraphs are not.
  - **`kind`:** one of
    - **`edge`** (`to` is a node id; an edge to its own node is allowed and means "already here")
    - **`control`** (an input, radio, checkbox, toggle, select or segmented choice)
    - **`gap`** (the prototype has no screen for it)
  - **`by`:** `model` or `designer`.

## Building and completing it

### At launch: the panel

The map is built after the launch gate and the ProtoDoc read, and before any claim. That happens on a new test, and again before each new wave when the re-read finds the file changed.

1. **Candidates.** The main thread lists each node's candidates from the original nodes, without rendering. It collects key, label, role, its box in frame coordinates, and the 200 characters of visible text nearest to it.
2. **Commit.** It posts `POST /api/studies/<id>/flow-map` with `{docHash, nodes, edges, candidates}`.
   - The backend completes the map, stores it, and answers with the completed map.
   - If a map with the same `docHash` is already stored, it answers with that map without asking the model again, unless the panel sent `rebuild: true`.

### The backend completes it

- **One model call per node**, in parallel, through the shared `LLMClient`: `gemini-2.5-flash`, `thinking_budget=0`, no history, with a JSON schema.
  - **Input:** the node's name, heading and visible text (at most 1,500 characters), its candidates, and every node's `{id, name, heading}`.
  - **Output:** `{id, kind, to?, reason}` per candidate.
- **Validation:** every candidate must be answered exactly once, and `to` must be a known node id.
  - An invalid answer is asked for again once, with the error.
  - If it is still invalid, the commit fails with 502 `flow_map_unavailable` and that node's error.
  - Nothing is guessed.
- **Storage:** the map is stored on the study as `flow_map`. Each run records the map version it played under (`test_meta.flow_map_version`).

### When the model can't complete the map

The launch stops with "Couldn't read the flow of '<frame>': <reason>." and two buttons:
- **Try again**
- **Launch with drawn connections only**: an explicit choice. It commits every candidate as a `gap` with `by: "designer"`.

There is no silent fallback.

### Editing

**Edit map** in the Flow map view lists the readings frame by frame. The designer can set each one to an edge to a chosen frame, a control, or a gap.

- **The request:** `PATCH /api/studies/<id>/flow-map/readings/<id>` with `{kind, to?}`. It sets `by: "designer"` and bumps `version`.
- **When an edit takes effect:** runs claimed after the edit use the new version. A run in progress keeps the version it started with.
- **Rebuilds:** a rebuild after a file change keeps designer readings whose candidate still exists.

## Traversal

The engine applies drawn reactions exactly as today. The map changes only what happens when a click finds no reaction: after bubbling and overlay blocking, where today's engine returns `nothing_happened`.

The engine looks up the reading for the hit layer, or for its nearest ancestor that has one, in the map version the run plays under.

| Reading | What the engine does | Outcome | `act.result` | The persona's next turn says |
|---|---|---|---|---|
| `edge` to another node | Navigates there the way a drawn `NAVIGATE` would: history, scroll reset, overlays closed | `navigated`, with `last.inferred: <reading id>` | `ok` | "It worked." (as for a drawn link) |
| `edge` to its own node | Nothing changes | `already_here` | `ok` | "You're already on this page." |
| `control` | The engine records the choice and the screen is unchanged | `accepted` | `ok` | "You selected 'Annual'." |
| `gap` | Nothing changes | `missing`, with `last.missing: <label>` | `ok` | "There's no page behind 'Holidays' in this product yet." |
| no reading (not a candidate, such as a paragraph) | As today | `nothing_happened` | `no_change` | "Nothing changed." |

- **Which triggers:** only clicks use readings. Hover, press, keys and drags work as they do today.
- **Patience:** `accepted`, `already_here` and `missing` are `ok` steps, so a gap or a control never costs patience and never causes a give-up on its own. Runs stay bounded by `max_steps`.
- **What the persona is told:** it is never told a transition was inferred. The prompt keeps the real-product framing: no "prototype" or "early design" wording.
- **The contract:** `TurnLast.outcome` gains `already_here`, `accepted` and `missing`. `last` gains the optional `inferred` (a reading id) and `missing` (a label of at most 120 characters). The backend validates both against the stored map version.

## What the report shows for Figma studies

For `source: "figma"` studies:

- **No usability findings.** The trace debrief is asked for no findings, and the report omits the findings section.
- **The debrief asks for needs instead:** "What did you look for and not find?", in the persona's own words, citing the step.
- **The report gains a `flow` section:**
  - **paths:** per run, the node sequence with each step's action label and outcome, and whether it was inferred or a gap
  - **completion:** reached the goal frame or not
  - **drop-offs:** the node where a persona gave up or ran out of steps
  - **feature needs:** gap clicks grouped by label and node, with how many personas and tries, plus the persona's own words from that step's monologue and the debrief's needs
  - **inferred transitions used:** each reading the personas used, so the designer can wire it
- **Persona outcomes:** completion and give-up reasons stay as they are.

## The Flow map in the panel

- **Where:** a Flow map card on the Running and Report screens, and on a past study opened from History.
- **The graph:** nodes are laid out left to right in breadth-first order from the start node.
  - Drawn edges are solid lines, inferred edges dashed lines, and gaps short stubs ending in a dot.
  - A visited node shows the screenshot the persona saw there; otherwise it shows its name.
- **Live:**
  - Each persona is a colored token on its node. On each turn the token moves, the edge it took lights up, and the old and new nodes alternate their highlight briefly.
  - An `accepted` or `missing` outcome pulses the node, with the gap's label for a gap.
  - A give-up or a completion marks the persona's last node.
- **Follow persona:** click a persona to follow it. On each of its turns the main thread calls `figma.viewport.scrollAndZoomIntoView` on the frame it is on. Nothing in the file changes.
- **Paths stay until cleared:** the paths drawn stay for the study until **Clear paths**. That is panel state only; the database is untouched.
- **Past studies:** `GET /api/studies/<id>/flow-map` gives the map, and `GET /api/studies/<id>/paths` gives each run's node sequence, built from its stored steps. The step URLs already carry the frame and overlays; steps gain the reading id.

## Backend changes

| Change | Where |
|---|---|
| `POST /api/studies/<id>/flow-map` (commit or rebuild), `GET` the same, `PATCH .../readings/<id>` | `api/routes_studies.py`, new `services/flow_map_service.py` |
| Completing the map (prompt, schema, validation, one re-ask, parallel calls) | `services/flow_map_service.py`, `simulation_core/flow_map_brain.py` |
| The study's `flow_map`, and each run's `flow_map_version` at claim | `services/study_service.py`, `services/plugin_run_service.py` (`claim_run`) |
| The new outcomes and `last.inferred`/`last.missing`, checked against the stored map | `services/trace_turn_service.py` (`_clean_last`) |
| Outcome words; no findings in the figma debrief, needs instead | `simulation_core/trace_brain.py` |
| Step records carry the reading id; the new outcomes count as `ok` | `services/trace_decide.py` |
| The report's `flow` section; the findings section omitted for figma studies | `services/study_report_service.py` |
| `GET /api/studies/<id>/paths` | `api/routes_studies.py`, `services/flow_map_service.py` |

## Plugin changes

| Change | Where |
|---|---|
| Candidates per node from the original nodes | `src/main/flowMap.ts` (new), `src/main/trace.ts` (`trace-candidates`) |
| Building and committing the map at launch and on a changed file; the error buttons | `src/ui/trace/launch.ts`, `src/ui/trace/runner.ts`, `src/lib/api.ts` |
| Readings in traversal; the new outcomes | `src/lib/proto/engine.ts`, `src/lib/proto/outcome.ts`, `src/lib/proto/model.ts` |
| `last.inferred` and `last.missing` | `src/ui/trace/session.ts`, `src/lib/turn.ts` |
| The Flow map card, Edit map, Follow persona, Clear paths, past paths | `src/ui/screens/flowmap.tsx` (new), `src/lib/flowLayout.ts` (new), `src/main/canvas.ts` (follow) |
| The report view without findings, and with the flow section | `src/lib/report.ts`, `src/ui/screens/report.tsx` |
| The mock backend's map, readings, outcomes and paths | `harness/mock-backend.mjs` |

## Error handling

| Failure | What happens |
|---|---|
| The model can't complete a node after one re-ask | The launch stops with the node and the reason. Try again, or Launch with drawn connections only. |
| The file changes between waves | The map is rebuilt for the new `docHash` before the next wave's claims, keeping the designer's readings. |
| A turn's `last.inferred` or `last.missing` doesn't match the run's map version | 400 from the backend, which the session reports as `engine_error` with the backend's message |
| A reading names a node the doc no longer has | The engine raises `EngineError('invalid_doc')`, which aborts with `engine_error`. It doesn't happen in practice, because a changed doc rebuilds the map. |
| `GET /paths` for a study with no figma runs | `200 {runs: []}` |

## Testing

- **Unit, plugin:**
  - candidates: wiring never changes which elements are listed, paragraphs are skipped, and instance-child keys are handled
  - each reading's outcome, including an ancestor's reading
  - hover never uses readings
  - flow layout
  - Follow persona sends only viewport moves
- **Unit, backend:**
  - completion validation: missing or doubled candidates, unknown `to`, and the one re-ask
  - map version per run
  - `_clean_last` with the new outcomes
  - the debrief without findings
  - the report's `flow` section
  - `paths`
- **End to end, plugin (mock):** the fake Farside page completes with a scripted map.
  - "Use routing number instead" is a `gap` and reads `missing`.
  - A nav label is an `edge` to Dashboard.
  - A radio is a `control`.
  - The golden path still completes, and no `nothing_happened` is left on a candidate.
- **End to end, backend (in process):** a plugin study commits a map, a run uses an inferred edge and a gap, and the report's `flow` lists the feature need and the inferred transition.
- **Live:** the real Farside Oxygen+ file through the local server.
  - "Oxygen+" is an inferred edge to "Oxygen+ plans", and "Holidays" a gap.
  - The checkout radios and "Annual" are controls.
  - **Pass:**
    - no persona gives up citing unresponsive navigation
    - the report lists "Holidays" and "Mission Control" as feature needs, and "Oxygen+" as an inferred transition to wire
    - the Flow map shows each persona's path

## Delivery phases

1. **Map:** the backend's commit, completion and storage, and the panel's candidates and commit at launch, with its error path.
2. **Traversal:** readings in the engine, the new outcomes, the contract and the persona's words.
3. **Report:** the figma debrief's needs, the `flow` section, no findings, and the panel's report view.
4. **Flow map card:** the live view, Follow persona, Clear paths, and past paths from `GET /paths`.
5. **Edit map.**

## Out of scope

- Drawing on the canvas.
- Inferring transitions for hover, press, key or drag triggers.
- Changing the web app's study report beyond what the backend's report returns.
