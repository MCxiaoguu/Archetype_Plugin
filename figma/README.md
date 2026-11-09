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
| New test | Start and goal screens (from your selection or a list), the goal, who your user is, an optional product line, the share link, and Quick or Thorough. A preflight runs on every change. |
| Running | Three stages (understanding your users, building personas, running), then one row per persona with its status, the screen it is on and its step count. If nobody picks the tests up within three minutes it says, plainly, "Waiting for a runner". |
| Report | How many tries reached the goal, the headline, each persona with the report's own confidence words ("99% likely lower completion"), the top findings with severity and the frames they happened on, where people gave up by screen, and what to change first. |
| Past tests | Every test launched from this file, newest first. Reopening the plugin returns to the last one. |

**Preflight, instant and free.** Before anything leaves the file the plugin walks
the prototype's connections from your start screen:

- whether the goal is reachable at all, and the shortest path (the only thing that blocks launch);
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

## The one sharing requirement

Personas open your prototype the way a stranger would. In the file, choose
**Share**, set access to **Anyone with the link can view**, and **Copy link**.
Paste that link in the panel. Links from `figma.com/design/...`,
`figma.com/file/...` and `figma.com/proto/...` all work; the plugin builds the
prototype URL from the key and your start screen. Public plugins cannot read the
open file's key, so the plugin cannot check a pasted link against the file
unless it runs as a private organization plugin (then it rejects links to other
files).

## How runs execute

The plugin never drives a browser. It creates a study with `execution: "remote"`
and `source: "figma"`, asks the backend to identify factors and build personas,
queues the first wave, and then only watches. A runner claims queued runs and
drives the prototype with the Archetype actor (Playwright, with the viewer's
screen reader mode on so hotspots read as named links). Success is a required
`frame_reached` check on the goal frame's node id: met when a step URL's
`node-id` names that frame, whatever else the URL carries.

Until the hosted runner ships, someone runs the runner from this repository:

```sh
python3 scripts/study_runner.py --watch --backend http://localhost:5013
```

(`--watch` is the polling mode the runner is gaining for remote studies; today
`--study <id>` runs one study.) While nobody is running it, the panel says
"Waiting for a runner" rather than showing an error, and you can close Figma: the
tests are queued on the backend.

## Privacy: what leaves the file

| Sent to Archetype | Never sent |
| :-- | :-- |
| The prototype share link you paste | File contents, layers, images or exports |
| The names of up to 20 screens on the paths from start to goal | Comments, other pages, other files |
| The ids of the start and goal frames, and the file key in the link | Anything from your clipboard |
| The goal, the user description and the product line you type | |

Everything else (the flow graph, the preflight, mapping results back to frames)
happens inside Figma. The plugin stores its settings, your Archetype token and a
short history of tests in Figma's `clientStorage` on your machine, and one
random id in the file's plugin data so the history follows the file.

## Architecture

```
            Figma desktop
┌──────────────────────────────────────────────────────────────┐
│  main thread  (src/code.ts, src/main/*)                      │
│   reads the page: frames, sections, flow starts, reactions   │
│   selects and zooms, writes annotations, clientStorage       │
│                     ▲            │                           │
│          postMessage│            │ DocSnapshot, selection    │
│                     │            ▼                           │
│  panel iframe, null origin  (src/ui/*, Preact)               │
│   state machine, preflight, report view  (src/lib/*, pure)   │
└──────────────────────────────┬───────────────────────────────┘
                               │ fetch, Bearer token
                               ▼
     Archetype API: /api/oauth/device/*, /api/studies/*, /api/plugin/runs/*/report
                               ▲
                               │ claims queued runs
                     runner (study_runner.py) ──▶ figma.com/proto/<key>/...
```

| Path | Role |
| :-- | :-- |
| `manifest.json` | `editorType: ["figma"]`, `documentAccess: "dynamic-page"`, network access limited to the Archetype API. |
| `src/code.ts` | Entry: shows the panel with theme colors, wires selection and page change events. |
| `src/main/document.ts` | Turns the current page into a plain `DocSnapshot`: top level frames (sections included), every layer with reactions mapped to its frame, destinations resolved, conditional actions flattened. |
| `src/main/canvas.ts` | Show on canvas, pin and clear annotations. |
| `src/main/storage.ts` | Settings, token, per file history and draft. |
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
with `frame_reached` rather than a URL glob, and every step URL the runner
records names the frame it was on. That is how findings and drop offs land on
frames.

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

- The plugin sends `source`, `execution` and `figma` on study creation (new fields on `feat/figma-channel`).
- "The screen a persona is on" reads `lastUrl` on `GET /api/studies/<id>/runs` rows when the backend sends it,
  and otherwise peeks at `GET /api/plugin/runs/<runId>/report` for running runs, at most every 15 s each.
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
> Only the share link, the screen names on the path and the text you type leave the file.
>
> **Tags:** usability testing, user research, prototype, synthetic users, personas, accessibility, UX
>
> **Network access reasoning:** The panel talks to the Archetype API to sign you in, create a persona study for
> the selected prototype flow, and read its results. It sends the prototype share link, the names of the
> screens on the path, the goal and the user description you type. It never sends file contents or images.

## License

MIT, see [LICENSE](LICENSE).
