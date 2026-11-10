# Changelog

All notable changes to the Archetype plugin. Versions follow
`.claude-plugin/plugin.json`.

## Unreleased: Figma prototypes

### Added

- Studies can target Figma prototypes. Every browser server loads
  `browser/figma-proto-init.js`, which turns on the prototype viewer's
  screen reader mode and lifts its hotspots above the canvas, so the actor
  reads each screen and taps hotspots like any page. The actor procedure
  has a "Prototype targets" section (dead hotspots and dead ends are
  findings, layer names are labels, the viewer's own controls are off
  limits).
- `study_runner.py --watch` serves studies created with `execution:
  "remote"`: it polls the backend, runs every queued run of each study, then
  polls again. `--once` makes a single pass. It never claims a Figma
  plugin-mode study's runs (`execution: "plugin"`), which only the Figma
  panel runs.
- The Figma plugin runs its studies inside the panel (`execution:
  "plugin"`). It reads the prototype (reactions, overlays, variants,
  variables, timers) and plays it the way the prototype viewer does. Each
  step, it draws the screen a persona sees on temporary copies and posts
  the screenshot, the visible text and what can be clicked as a turn. The
  backend's model then decides the persona's next action. All of a wave's
  personas run side by side in the panel, which asks for the next wave
  itself and resumes the runs it owns when it reopens. A file edited while a
  test runs flags the steps after the edit. `dispatch_study` refuses these
  studies: only the panel can run them.

### Fixed

- The swarm runner aborts a run only when its own worker claimed it (the
  `start_run` answer in the worker's stream). It used to abort any run
  still open when its worker exited, so two runners on one study (a
  `--watch` service and `dispatch_study`, or overlapping `--once` passes)
  killed each other's live runs. A run nobody claimed now stays queued.
- A signal no longer leaves a `stop` file in the study folder (which kept
  `--watch` from ever serving that study again), and Ctrl-C or SIGTERM
  stops the watcher and its workers. A runner exits 1 when a run went
  wrong, and `--watch` leaves a study to the runner already serving it.
- The runner sends the login token only to an https backend (http only on
  localhost), like the core server.
- A browser server that hangs on close is killed (SIGTERM, then SIGKILL on
  its process group) instead of being left running.
- The permission hook allows only this plugin's actor agents, not another
  plugin's agent with the same name.
- The Relay grader counts no page for a step without a URL, grades only
  runs that ran, and `relay_study.py` exits 1 when a report is missing.
- `docs/examples/study-ci.yml` creates a fresh study per job (a saved
  study cannot be repointed or rerun).

## 0.6.0 (2026-11-03): behavioral studies

### Added

- `/archetype:study`: a behavioral study from one command. The backend
  picks the 3 to 5 behavioral factors that could change whether your users
  finish the task, builds one archetype per factor at its risk pole plus a
  baseline and a stress case (design `ofat_stress` by default), and the
  plugin runs them, adds confirmation runs where an archetype disagrees
  with the baseline (repeats `confirm` by default), and renders the report:
  completion per archetype with 90 percent intervals, factor impact with
  confidence in words, the stress check, findings hit by all or only some
  archetypes, recommendations and an honesty line.
- Study tools in the `core` server: `create_study`, `generate_factors`,
  `update_factors`, `generate_archetypes`, `create_study_runs`,
  `next_study_wave`, `study_status`, `get_study_report`, `dispatch_study`,
  and `get_study`, which resumes a study by id (`/archetype:study
  study=<id>`) at whatever stage it reached.
- `unattended` studies for `claude -p` and CI: no questions and no
  confirmations, the swarm runner, and `study_status` `wait_seconds` to
  follow the study without a sleep tool.
- The plugin browsers use Google Chrome when it is installed, else
  Playwright's bundled Chromium; with neither, the first browser call says
  to run `npx playwright install chromium`. The recorded browser config
  names the engine that ran.
- The swarm runner reports a run whose worker exited, timed out or logged no
  step for 20 minutes after its claim as aborted with the reason, so the
  next wave is never held up, and `max_runs` caps a study's actor runs (a
  larger wave 2 runs its highest priority runs; the rest are recorded as
  not run).
- Quit reason `trust_refused` for a person who leaves out of distrust (a
  broken promise, an unexplained card request); `price_barrier` stays for
  the price itself. The report shows why each archetype left, the variance
  of repeated runs and whether the archetypes were written by a model.
- Protocol v2 for the actor: `log_step` after every browser action, with
  `client_ts` and `elapsed_s`, a 15 second budget, a local buffer and a
  local state when the backend is slow. The answer carries the step
  budget, the active rules, recall and, when the budget runs out, a note
  asking the persona to decide whether to go on.
- `start_run(run_id=...)` claims a run a study created; `report_result`
  accepts `abandoned` and `feedback.outcome`, and sends the raw browser
  actions, the browser config and the session video path.
- Briefings print HOW YOU BEHAVE (the archetype's rules, which override the
  scenario steps) and the success criterion and checks.
- Six isolated Playwright browsers declared by the plugin
  (`archetype-browser-1` to `-4` headless, `archetype-watch-1` and `-2`
  headed), pinned to `@playwright/mcp@0.0.84`, a desktop Chrome user agent
  and a 1280x900 viewport, recording a video per session. They start
  lazily: six idle servers cost about 51 MB instead of about 550 MB.
- Raw action capture: a `PostToolUse` hook files every browser call under
  the run that made it, with typed text redacted.
- A `PreToolUse` hook that lets the plugin's actor agents use their own
  browser and run tools without a prompt per call.
- Swarm runner (`scripts/study_runner.py`) for unattended and CI studies:
  one `claude -p` worker per run, each on its own browser, logs per run,
  next waves until done. `docs/examples/study-ci.yml` shows a GitHub
  Actions job.
- Tests: protocol v2 and study cases in the stdio harness (92 cases),
  `test_action_hook.py`, `test_browsers.py`; the agent sync test checks the
  protocol v2 wiring. CI runs them all plus `claude plugin validate
  --strict`.

### Changed

- Both actor agents follow a per-step protocol (observe, recall, decide,
  act, record), apply trust gates and give up rules, close the browser
  before reporting, and stop at `maxTurns: 120`.
- `feature-validator-headless` drives the plugin browser its dispatch
  prompt names; ad hoc headless runs use `archetype-browser-1` before a
  self-registered `playwright` server.
- Ad hoc Chrome runs say once that they use the real Chrome profile.
- The repository's own `CLAUDE.md` moved to `.claude/CLAUDE.md` (a plugin
  root `CLAUDE.md` is not loaded and fails `validate --strict`).

### Compatibility

- Backends without `protocol_version` keep the 0.5.1 behavior: no live
  steps, the persona's traits rendered as words, `abandoned` recorded as
  `failed`, no new fields in results.
- The browsers need Node 18 or newer and Google Chrome or Playwright's
  bundled Chromium (`npx playwright install chromium`).

## 0.5.1

- `start_run` preconditions; one browser tab per login code;
  `ARCHETYPE_NO_BROWSER`.

## 0.5.0 and earlier

- Pool first personas, the headless actor, run reports with evidence,
  wall clock deadlines and self healing login. See the git history.
