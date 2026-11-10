# Archetype for Figma

**Test this flow with synthetic users, right where the flow lives.**

A free Figma plugin for designers who want to know who gets lost in a prototype
before engineering builds it. Pick the screen a flow starts on and the screen that
means done, say in your own words who your user is, and launch. Archetype builds
a handful of personas that differ in one trait each (the impatient one, the one
who will not hand over a phone number, the one who has never seen a product like
yours), sends them through your clickable prototype, and brings back who got
through, where they gave up, and why. Then it pins the findings to the frames
they happened on.

`figma-plugin` · `synthetic-users` · `prototype-testing` · `ux-research` ·
`persona-testing` · `usability` · `preact` · `typescript` · `MIT`

The plugin is deliberately thin: a launcher and a viewer on top of the Archetype
studies API. The account is the product; the listing is free.

## What it does

| Screen | What you see |
| :-- | :-- |
| Sign in | One button. Archetype opens in your browser with a short code; approve it there and the panel carries on by itself. |
| New test | Start and goal screens (from your selection or a list), the goal, who your user is, an optional product line, an optional share link, and how deep: Single persona (one typical user from your description, one try), Quick or Thorough. A preflight runs on every change. |
| Running | Three stages (understanding your users, building personas, running), then one row per persona with its status, the screen it is on and its turn, while the panel itself walks each persona through the prototype. It says when it starts the next round of tries, when it lost touch with Archetype, and, for a test reopened on another page, which page the test runs on, with a button to go there. |
| Report | How many tries reached the goal, the headline, each persona with the report's own confidence words ("99% likely lower completion"), the top findings with severity and the frames they happened on, where people gave up by screen, and what to change first. |
| Past tests | Every test launched from this file, newest first. Reopening the plugin returns to the last one. |

**Preflight, instant and free.** Before anything leaves the file the plugin walks
the prototype's connections from your start screen:

- whether the goal is reachable at all, and the shortest path;
- whether the flow navigates to the goal: a goal that only opens as an overlay keeps the address of the
  screen under it, so the `frame_reached` check could never see it (this, an unreachable goal and a start or
  goal that is a component set, which the pickers never offer, are the only things that block launch);
- dead ends a persona can reach and never leave;
- hotspots that point at frames that no longer exist;
- hotspot layers named `Rectangle 12`, `Frame 3`, `image 4`, `icons8-trophy-32 1` and friends. The prototype viewer's
  screen reader mode exposes each hotspot as a link named after its layer, so personas and real screen reader
  users both hear "link Rectangle 12". The plugin suggests a name from the text inside the layer when it can.

**Results on the canvas.** Every frame chip in the panel selects and zooms to its
frame. **Pin findings** writes one annotation per affected frame (labels start
with `Archetype:`), and **Clear pins** removes only those, never yours. When
Figma refuses annotations (view only access), the findings stay in the panel.

## Install it in the Figma desktop app

```sh
cd figma
npm ci
npm run build          # writes dist/code.js and dist/ui.html
```

Then in the Figma desktop app: **Plugins, Development, Import plugin from
manifest...**, and pick `figma/manifest.json`. Run it from **Plugins,
Development, Archetype**. Use `npm run watch` while you work; Figma reloads the
plugin each time you run it.

Pointing at a local backend: open the gear, set the API to
`http://localhost:5013` (already in `devAllowedDomains`), and under Development
paste any token (local backends run with the development bypass).

## Edit access, and the optional share link

Tests run inside the panel, so nobody else has to open your prototype and no
sharing is needed. The panel does need **edit access** to the file: to draw each
screen a persona sees, it makes a temporary copy of the screen beside the canvas
(locked, at x = -100 000), exports it and deletes it again right away. The
copies change nothing in your file. In a view-only file the launch stops with
"Duplicate to your drafts to test".

A share link is optional. With one, step URLs in the report use the file's key
and the real prototype URL form, so they open the prototype. Without one they
use `figma-trace://` URLs, which the report shows as plain text. Links from
`figma.com/design/...`, `figma.com/file/...` and `figma.com/proto/...` all work.

## How runs execute

The plugin never drives a browser. A Figma study runs inside the panel itself:
the panel creates a study with `execution: "plugin"` and `source: "figma"`,
asks the backend to identify factors and build personas, and queues the first
wave. For every queued run, the panel then walks the prototype on its own —
reading reactions, variants, variables and overlays the way the Figma
prototype viewer would — and posts each screen it reaches to the backend. The
backend's model looks at that screen (a screenshot, the visible text and the
actionable elements) and decides the persona's next action; the panel applies
that action, renders the next screen and posts again. This repeats, one turn
at a time, until the persona finishes, gives up, or patience runs out. No
runner is needed, and none watches a Figma study: `study_runner.py --watch`
still exists for other `execution: "remote"` studies, but it never claims a
Figma study's runs.

The panel must stay open while a test runs, because it is doing the walking.
Closing it pauses every session it owns until it reopens, on the test's page;
a run left closed for 20 minutes is ended by the backend's watchdog. On the
web, keep the tab visible — browsers slow or stop timers in a background tab,
and the panel warns you when it notices itself running late. All queued runs
of a wave run in parallel in the same panel, and the panel asks for the next
wave itself once every run of the current one has ended. Each wave plays the
prototype as the file is when the wave starts; when you edit the file while a
test runs, the steps after the edit are flagged, so the report can tell them
apart.

**The flow map.** A wireframe is never fully wired, so before it claims any
run (at launch, and before each later wave) the panel commits the prototype's
flow map: every frame, its drawn connections, and every element that has no
connection of its own but looks clickable. The backend reads each of those
once, as a link to a frame the prototype has, a control that takes input, or
a gap with no page behind it, and stores the map as a new version when the
file changed. A persona's click that no drawn connection handles then plays
that reading: it opens the frame, selects the control, or tells the persona
there is no page behind it yet. A run plays the map version it was claimed
on for its whole life. When the backend can't read a screen, the panel says
which and why, with **Try again** and **Launch with drawn connections only**
(every unread element a gap).

## Privacy: what leaves the file

| Sent to Archetype | Never sent |
| :-- | :-- |
| The goal, the user description and the product line you type | Screens no persona reaches, other files |
| The file and page names, the start and goal frame ids, and the names of up to 20 screens on the paths from start to goal | Comments, the layer tree, variable values |
| At launch and before each wave, the flow map: every frame's name, page, largest text and up to 1,500 characters of its visible text; the drawn connections (which layer leads where, on which trigger); and for every element without a connection that looks clickable, its label, role, box and the 200 characters of text nearest to it | |
| During a test, for every step: a screenshot of the screen the persona sees, its name and step URL (page name and frame ids), its visible text, and the labels, roles and boxes of what can be clicked | Anything from your clipboard |
| When a step's action can't be played: what it was, which can name a variable, a variable collection or a mode (for example "Can't set Bank linked, a boolean variable, to a string") | |
| When a timer opens a link: the link's address, up to 200 characters | |
| The share link, if you paste one | |

The screenshots and text of each step go to Archetype and its AI model provider,
which decides what the persona does next; the flow map goes to them too, once
per change of the file, to read the unwired elements. The preflight, the
prototype interpreter and mapping results back to frames run inside Figma.
The plugin stores its settings, your Archetype token, a short history of tests
and the progress of running tests (so a closed panel can resume them) in Figma's
`clientStorage` on your machine, and one random id in the file's plugin data so
the history follows the file.

## Architecture

```
            Figma desktop
┌──────────────────────────────────────────────────────────────┐
│  main thread  (src/code.ts, src/main/*)                      │
│   reads the page: frames, sections, flow starts, reactions   │
│   reads the prototype (ProtoDoc), renders trace screens on   │
│   scratch copies, selects and zooms, annotations, storage    │
│                     ▲            │                           │
│          postMessage│            │ DocSnapshot, renders      │
│                     │            ▼                           │
│  panel iframe, null origin  (src/ui/*, Preact)               │
│   state machine, preflight, report view  (src/lib/*, pure)   │
│   trace runner: engine (src/lib/proto/*), sessions, waves    │
└──────────────────────────────┬───────────────────────────────┘
                               │ fetch, Bearer token
                               ▼
     Archetype API: /api/oauth/device/*, /api/studies/*,
                    /api/plugin/runs/<id>/claim, /turn, /turn/<n>, /abort
                    (the backend's model decides each persona step)
```

| Path | Role |
| :-- | :-- |
| `manifest.json` | `editorType: ["figma"]`, `documentAccess: "dynamic-page"`, network access limited to the Archetype API. |
| `src/code.ts` | Entry: shows the panel with theme colors, wires selection and page change events. |
| `src/main/document.ts` | Turns the current page into a plain `DocSnapshot`: top level frames (sections included), every layer with reactions mapped to its frame, destinations resolved, conditional actions flattened. |
| `src/main/protoReader.ts` | Reads the prototype into a `ProtoDoc` for the trace engine: frames, every reaction, the variants a CHANGE_TO can show, the local variables. |
| `src/main/renderer.ts` | Renders a trace state on scratch copies of the screens, measures every layer and exports the viewport as a JPEG, then removes the copies. |
| `src/main/trace.ts` | Answers the panel's trace requests (read, render by doc hash, the flow map's candidates, follow a persona, save and load sessions, the edit access check, cleanup) and reports edits to the prototype's frames. |
| `src/main/flowMap.ts`, `measure.ts` | The flow map's nodes, drawn edges and candidates, read from the original nodes (each variant's layers and hidden ones included) and keyed as the renderer keys what it measures. |
| `src/main/watch.ts`, `scratch.ts` | Telling the designer's edits from the renderer's own copies; the scratch marks, the containers renders hold, and the one queue reads and renders run through. |
| `src/main/canvas.ts` | Show on canvas, pin and clear annotations, and Follow persona (a viewport move, nothing else). |
| `src/main/storage.ts` | Settings, token, per file history and draft, and the saved progress of running tests. |
| `src/lib/proto/*` | The prototype engine, pure: navigation, overlays, scroll, pointer and keys, timers, variables and conditions, variants, what a persona can act on, step URLs, and the flow map's readings where no reaction handles a click. |
| `src/ui/trace/*` | The trace runner: the bridge to the main thread (one render at a time), a persona's session, the runner of a study's waves, and the launch gate and runner wiring. |
| `src/lib/ids.ts`, `links.ts` | Colon and dash node ids, share link parsing, and the prototype URL. |
| `src/lib/graph.ts`, `preflight.ts`, `names.ts` | The reaction graph, breadth first reachability, dead ends, broken links, generic names. |
| `src/lib/study.ts`, `launch.ts` | The `POST /api/studies` body and the resumable launch sequence (factors, personas, wave 1). |
| `src/lib/api.ts` | The API client: bearer auth, 401 handling, timeouts, device flow polling with `slow_down`. |
| `src/lib/poll.ts`, `runs.ts`, `report.ts`, `frames.ts` | Polling cadence (5 s, then 15 s after two minutes), "waiting for a runner", persona rows, the report view model and step URL to frame mapping. |
| `src/lib/state.ts` | The panel state machine (a pure reducer). |
| `src/ui/*` | The panel. Figma's theme variables carry light and dark; Archetype blue is the one accent. |
| `harness/*` | A browser harness that plays Figma (see below). |

Prototype URLs put `node-id` first and `starting-point-node-id` second, as
Figma does. The viewer rewrites `node-id` on every screen change (sometimes the
URL ends right there, sometimes more parameters follow), so the goal is checked
with `frame_reached` rather than a URL glob, and every step URL the panel
posts names the frame it is on, and the overlays open over it. That is how
findings and drop offs land on frames.

## Development

```sh
npm ci
npm run typecheck      # TypeScript strict
npm test               # vitest: pure modules, the API client, the state machine, the main thread with a fake figma
npm run build          # esbuild
npm run check:manifest # manifest fields and dist paths
```

### The harness

`harness/` serves `dist/ui.html` inside a page that plays Figma's main thread
over `postMessage`: a fixture prototype on a tiny canvas (click a frame to
select it), storage, Show on canvas and pins. The panel runs in a sandboxed
iframe with a null origin, exactly like in Figma.

```sh
npm run build && npm run harness          # mock backend, http://localhost:4400
npm run shots                             # every screen, light and dark, into harness/shots/
```

The mock backend answers from `harness/fixtures/`: `doc.json` is the fixture
prototype (Dashboard to Bank connected, with a dead end, a broken hotspot and
generic names on purpose) and `study-report.json` is the backend's golden report
with its URLs swapped for prototype URLs (`node harness/fixtures/make-report.mjs
<golden.json>` regenerates it). URL parameters on the harness page pick a moment:
`token=none|mock|expired`, `study=study-running|study-queued|study-done|study-archetypes|study-fail`,
`queuedAgo=5`, `history=1`, `draft=1`, `selection=2:50`, `doc=empty`, `theme=dark`, `fresh=1`.

**Live mode** talks to a real backend:

```sh
npm run harness -- --backend http://localhost:5013 --token x
```

The panel calls the backend straight from its null origin iframe, so the
backend must allow the `null` origin. Add `--proxy` to route calls through the
harness instead. The fixture page only knows the fixture prototype, so to
launch against a real file give the harness its start and goal frames; it
builds a stand in page with those two frames and one hotspot between them:

```sh
npm run harness -- --backend http://localhost:5013 --token x \
  --start "1:3=Welcome" --goal "71:616=Goal reached" --file "HCI first prototype"
```

(or `--doc snapshot.json` for a full snapshot). Paste the real file's share
link in the panel; the ids must exist in that prototype. Leave out `--token`
to go through the real device flow; the verification page opens in a new tab.

## Backend contract notes

- The plugin sends `source`, `execution: "plugin"` and `figma` on study creation.
- For those studies the panel is the runner: it claims runs with `POST /api/plugin/runs/<id>/claim`, posts
  each turn to `POST /api/plugin/runs/<id>/turn`, polls `GET /api/plugin/runs/<id>/turn/<n>`, aborts with
  `POST /api/plugin/runs/<id>/abort`, and asks for the next wave with `POST /api/studies/<id>/runs/next`.
- "The screen a persona is on" reads `lastStep.url` on `GET /api/studies/<id>/runs` rows (null until the
  run's first step).
- The panel's iframe has a `null` origin: the API's CORS list must include it.

## Publishing to the Figma Community

Checklist:

- [ ] Replace `id` in `manifest.json` with the id Figma assigns when you publish (Plugins, Development, Publish).
- [ ] Icon, 128 x 128 px: the Å mark on Archetype blue.
- [ ] Cover art, 1920 x 960 px: the report panel next to a canvas with pinned frames.
- [ ] Name, tagline, description and tags (below).
- [ ] Support contact: a monitored address, for example support@syntheticarchetype.com.
- [ ] Privacy policy URL: https://www.syntheticarchetype.com/privacy (must describe the table above).
- [ ] Network access reasoning (already in the manifest, shown on the listing).
- [ ] Check `devAllowedDomains`: they only apply while developing, but reviewers see them.
- [ ] Run it once in light and dark, on a file with sections, overlays and a flow starting point.

Listing copy, ready to paste:

> **Name:** Archetype: test flows with synthetic users
>
> **Tagline:** See who gets lost in your prototype before you hand it off.
>
> **Description:** Pick where a flow starts and the screen that means done, describe your user in your own
> words, and launch. Archetype builds personas that each differ in one trait, like patience, trust or
> experience, and sends them through your clickable prototype. You get back who reached the goal, where the
> others gave up and why, in their own words, with findings pinned to the frames they happened on.
> A free preflight checks the flow first: unreachable goals, dead ends, broken hotspots and layer names like
> "Rectangle 12" that personas and screen reader users hear as links. Requires a free Archetype account.
> What you type, the file and page names and the screen names on the path leave the file, and during a test
> every step sends a screenshot, its visible text and what can be clicked to Archetype and its AI model
> provider. The share link is optional.
>
> **Tags:** usability testing, user research, prototype, synthetic users, personas, accessibility, UX
>
> **Network access reasoning:** The panel talks to the Archetype API to sign you in, create a persona study for the selected prototype flow, run it and read its results. It sends the file and page names, the names of the screens on the path, the goal and the user description you type, and the prototype share link if you paste one. During a test, every step sends a screenshot of the screen a persona sees, its visible text and what can be clicked to Archetype and its AI model provider, so the persona can see and act on what you built.

## License

MIT, see [LICENSE](LICENSE).
