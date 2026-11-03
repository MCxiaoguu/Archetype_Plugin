# Changelog

All notable changes to the Archetype plugin. Versions follow
`.claude-plugin/plugin.json`.

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
  `next_study_wave`, `study_status`, `get_study_report`, `dispatch_study`.
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
- Tests: protocol v2 and study cases in the stdio harness (91 cases),
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
- The browsers need Node 18 or newer and Google Chrome (or
  `npx -y @playwright/mcp@0.0.84 install-browser chrome`).

## 0.5.1

- `start_run` preconditions; one browser tab per login code;
  `ARCHETYPE_NO_BROWSER`.

## 0.5.0 and earlier

- Pool first personas, the headless actor, run reports with evidence,
  wall clock deadlines and self healing login. See the git history.
