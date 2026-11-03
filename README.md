# archetype

**Find out which of your users give up, where, and why, before they do.**

A Claude Code plugin that turns your session into the actor of the Synthetic
Archetype pipeline. It becomes a persona from your Archetype workspace,
drives a real browser through your product the way that person would, and
reports back. One persona for a quick check, or a whole behavioral study:
the impatient one, the one who will not hand over a card before seeing the
refund terms, the one who has never used anything like it, each in its own
isolated browser, all at once.

`claude-code-plugin` · `synthetic-users` · `behavioral-studies` ·
`ux-research` · `playwright` · `persona-testing` · `v0.6.0`

```
/plugin install archetype --marketplace MCxiaoguu/Archetype_Plugin
```

## What you can ask

```
/archetype:setup                                    # log in (once)
/archetype:validation "sign up and invite a teammate" url=http://localhost:8321
/archetype:study "connect a bank account" url=https://staging.example.com \
    icp="founders of 2 to 10 person SaaS teams who do their own books" \
    success="the bank shows as connected in billing settings"
```

A **validation** is one persona, one run, in Claude in Chrome when it is
connected (so you can watch), with a verdict, findings with evidence and the
persona's own words.

A **study** answers a sharper question: for this group of people and this
task, which behavioral factors change whether they finish? The backend picks
the factors that matter here (patience, trust, familiarity, reading, price
sensitivity, plus task specific ones), builds a baseline archetype, one
variant per factor at its risk pole and a stress archetype with every factor
at risk. The plugin runs them in parallel headless browsers, adds
confirmation runs wherever an archetype disagrees with the baseline, and
prints:

```
| Archetype         | Role     | Varied factor  | Completed | Completion (90% interval) | Abandoned at  |
| Baseline founder  | baseline | none           | 3 of 3    | 80% (47% to 98%)          | never         |
| Low-trust founder | variant  | trust low      | 0 of 3    | 20% (2% to 53%)           | step 7 (form) |

| trust_willingness_to_share | low | -100 points | supported: 97% likely lower completion |
Stress check: the stress archetype failed far more often than the single factors predict,
so the factors likely compound.
```

plus the findings every archetype hit, the ones only some hit, the top
recommendations with their evidence, and an honesty line. Synthetic
archetypes rank factors more reliably than they estimate absolute completion
rates, and the report says so.

## How a study runs

| Mode | Ask for it with | Browser | At once |
| :-- | :-- | :-- | :-- |
| Headless, in your session | (default) | `archetype-browser-1` to `-4`, isolated | 4 |
| Watch live | `watch=live` | `archetype-watch-1`, `-2`, headed, isolated | 2 |
| Unattended swarm, CI | `unattended` | one `claude -p` worker per run | 2 (up to 4) |
| Your real Chrome | `browser=chrome` | Claude in Chrome, your profile | 1 |

A study never mixes browsers: every run records its browser config and the
report only compares runs that match. Chrome is there for flows a script
cannot log into; it brings your cookies, logins and extensions, so the
tester is you, not a new visitor, and the report says "real browser
profile".

Every isolated run records a video (`.webm`) and keeps a raw log of every
browser call beside the persona's own step log, so a step the persona
narrated but never did is flagged.

## Figma plugin

Designers can launch the same persona studies from inside Figma. The plugin in
[`figma/`](figma/README.md) reads a prototype's connections, checks the flow
before launch (unreachable goals, dead ends, broken hotspots, unclear layer
names), creates a study against the prototype share link, and brings results
back as a report and as annotations on the frames. See
[figma/README.md](figma/README.md) to import it in the Figma desktop app.

## Architecture

```
 you ──► /archetype:study ──► core MCP server ──► Archetype backend
                                 (stdlib)          studies, factors, archetypes,
                                    ▲              runs in waves, report
                                    │ start_run(run_id) · log_step · report_result
          ┌─────────────────────────┼─────────────────────────┐
     actor subagent           actor subagent           actor subagent
   (feature-validator-     (one per run, fresh,       (or a claude -p worker
    headless, fresh)        no dev context)            from study_runner.py)
          │                         │                         │
  archetype-browser-1       archetype-browser-2        archetype-browser-k
  lazy proxy ─► @playwright/mcp@0.0.84, headless, isolated, pinned UA, video
          │
  hooks: PostToolUse ─► raw actions per run · PreToolUse ─► allow actor tools
```

- **`core`** (`scripts/core-server.py`, Python stdlib): every backend call,
  with wall clock deadlines and self healing login. Twenty tools: login,
  runs, `log_step`, features, pools, the nine study tools, status.
- **Actors** (`agents/`): `feature-validator` on Claude in Chrome and
  `feature-validator-headless` on Playwright, the same per-step protocol
  (observe, recall, decide, act, record), kept in sync by a test.
- **Browsers** (`.mcp.json`, `scripts/browser-server.py`): six plugin
  declared Playwright servers behind a lazy proxy. Six idle servers cost
  about 51 MB; the real server starts on the first tool call.
- **Hooks** (`hooks/hooks.json`): a session start login check, raw action
  capture, and a permission hook that lets the plugin's actors use their
  own browser and run tools without dozens of prompts (plugins cannot ship
  permission rules in `settings.json`).
- **Swarm runner** (`scripts/study_runner.py`): unattended studies, one
  worker per run, logs per run, next waves until done. See
  `docs/examples/study-ci.yml` for a GitHub Actions job.

The full wiring (every tool, endpoint, file and variable) is in
[docs/REFERENCE.md](docs/REFERENCE.md); what changed is in
[CHANGELOG.md](CHANGELOG.md).

## Requirements

- Claude Code 2.1.275 or later, Python 3.10 or later.
- For the isolated browsers: Node 18 or later and Google Chrome, or
  Playwright's bundled Chromium (`npx playwright install chromium`), used
  when Chrome is missing. The first
  browser call of a session downloads the pinned server through `npx`.
- For Chrome runs: Chrome with the Claude extension, `claude --chrome`, an
  unlocked screen.
- An Archetype account (`/archetype:setup`).

## Commands

| Command | What it does |
| :-- | :-- |
| `/archetype:setup` | Log in (device flow) and show the dashboard |
| `/archetype:validation "<goal>" url=<...> [pool=<name>]` | One persona run; "as A and as B" fans out into a comparison |
| `/archetype:validation --run <run_id> [browser=<name>]` | Claim and execute a run a study created |
| `/archetype:validate-feature <name>` | A run for a saved feature |
| `/archetype:study "<goal>" url=<...> icp="<who>" success="<done when>"` | A behavioral study |
| `/archetype:persona` | Persona pools: list, or create one from a short questionnaire |
| `/archetype:list-features`, `/archetype:check-run-status <run_id>`, `/archetype:status`, `/archetype:logout` | The rest |

Study options: `archetypes=4..8`, `repeats=confirm|explore|decide`,
`mode=ofat_stress|ofat|factorial|half_fraction|composites`, `parallel=N`,
`watch=live`, `browser=chrome`, `unattended`, `questions="...;..."`.

The actor sees the target URL, query string included: keep run labels
opaque (`?twin_label=r7f3`, not `?twin_label=chaos-slow-backend`), or the
persona learns what the test expects.

## Dev quickstart

```bash
git clone https://github.com/MCxiaoguu/Archetype_Plugin.git ~/dev/Archetype_Plugin
cd ~                                      # launch from OUTSIDE the plugin folder
claude --plugin-dir ~/dev/Archetype_Plugin --debug
```

Launching from inside the plugin folder makes Claude Code read the plugin
files as project config, and `${CLAUDE_PLUGIN_ROOT}` and
`${CLAUDE_PLUGIN_DATA}` do not resolve. In the session, `/plugin` lists
`archetype`, `/mcp` shows `core` and the six `archetype-*` browsers, and
`/archetype:setup` logs in. `/reload-plugins` picks up edits.

| Task | How |
| :-- | :-- |
| Local backend | `export ARCHETYPE_BACKEND_URL=http://localhost:5001` before `claude` |
| Fresh login | delete `~/.claude/plugins/data/archetype-*/auth.json` |
| Deadlines | `ARCHETYPE_HTTP_TIMEOUT`, `_RUN_TIMEOUT`, `_RESULT_TIMEOUT`, `_PERSONA_TIMEOUT`, `_STEP_TIMEOUT`, `_STUDY_TIMEOUT` |
| See what a browser proxy receives | `ARCHETYPE_BROWSER_TRACE=/tmp/trace.log` |
| Unattended run by hand | `python3 scripts/study_runner.py --study <id> --runs <a,b> --parallel 2` |

Print mode cannot show the login modal: log in once interactively first.
Never pass `--strict-mcp-config` with `--plugin-dir`: it drops the plugin's
own servers.

### Tests

```bash
python3 scripts/test_core_server.py     # stdio harness, stub backend, 92 cases
python3 scripts/test_action_hook.py     # raw action capture
python3 scripts/test_browsers.py        # lazy proxy, permission hook, swarm runner
python3 scripts/test_agents_in_sync.py  # the two actors share one procedure
python3 scripts/test_session_hook.py
claude plugin validate --strict .
```

CI (`.github/workflows/ci.yml`) runs all of them on Python 3.10, 3.12 and
3.14. The live end to end runbook is `e2e/RUNBOOK.md`.

## Layout

```
.claude-plugin/        plugin.json (core server), marketplace.json
.mcp.json              the six browser servers
agents/                feature-validator.md, feature-validator-headless.md
browser/               pinned.json, playwright.config.json, tools.json
hooks/hooks.json       SessionStart, PreToolUse, PostToolUse, PostToolUseFailure
scripts/               core-server.py, browser-server.py, study_runner.py,
                       action-hook.py, permission-hook.py, session-hook.py, tests
skills/                setup, validation, validate-feature, study, persona,
                       list-features, check-run-status, status, logout
docs/                  REFERENCE.md, examples/study-ci.yml, design notes
demo-apps/             Relay and Lumina Notes, with planted defects
e2e/                   the live runbook and helpers
```
