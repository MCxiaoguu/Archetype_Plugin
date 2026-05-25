# archetype

Claude Code plugin that drives **feature validation runs** through the
Synthetic Archetype web portal from inside your editor or terminal.

## What it gives you

| Component | Path | Purpose |
| :--- | :--- | :--- |
| Skill | `skills/validation/` | Main entrypoint — opens the login wizard or runs a validation |
| Skill | `skills/validate-feature/` | Kick off a validation run for a specific feature |
| Skill | `skills/list-features/` | Browse features available for validation |
| Skill | `skills/check-run-status/` | Look up the status / results of a run |
| Agent | `agents/feature-validator.md` | End-to-end orchestrator: select → run → monitor → triage |
| MCP   | `archetype-setup` (stdio) — `scripts/setup-server.py` | Interactive Auth0 device-flow login wizard, declared inline in `plugin.json` |
| Hook  | `hooks/hooks.json` | Session-start sanity check for the auth state |

## Quick start

In Claude Code, type:

```
/archetype:validation
```

With no argument, it runs the **login wizard** (Auth0 device flow — your
browser pops open to the Archetype approval page; you approve; the
plugin polls the backend and saves the access token locally). With an
argument, it routes to a validation:

```
/archetype:validation FEAT-184
/archetype:validation validate the checkout flow
```

## Dev quickstart — for handoff

Five steps from `git clone` to a working interactive wizard.

### 1. Prereqs

- macOS or Linux
- Python 3.10+ (`python3 --version`) — runs the wizard MCP server, stdlib only
- [Claude Code](https://claude.com/claude-code) CLI installed
- Git

### 2. Clone

```bash
git clone <repo-url> ~/dev/Archetype_Plugins
```

### 3. Launch Claude Code with the plugin loaded

**Launch from a directory OUTSIDE the plugin folder.** Otherwise Claude
Code reads the plugin files as a project-level config and the
plugin-only variables (`${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}`)
won't resolve — `/doctor` will show "Missing environment variables".

```bash
cd ~
claude --plugin-dir ~/dev/Archetype_Plugins --debug
```

`--debug` streams plugin load + MCP-server startup logs to stderr.
Keep it on for the first few runs.

### 4. Verify it loaded

Inside the session:

```text
/plugin    # `archetype` should be listed as enabled
/mcp       # `archetype-setup` should be `running`
/help      # skills appear under the `archetype:` namespace
```

### 5. Run the wizard

```text
/archetype:validation
```

Expected:
1. Your default browser auto-opens to the Auth0 approval page.
2. An in-terminal **elicitation modal** also renders, showing the same
   URL, a verification code, and a single "I've approved" checkbox.
3. Approve in the browser → tick the box → click **Accept**.
4. The wizard polls the backend, then reports
   `Connected to Archetype. Access token saved to <path>`.

The token lives at `~/.claude/plugins/data/archetype-<scope>/auth.json`
(mode `0600`).

### Iterating

| Task | How |
| :--- | :--- |
| Edit a skill / Python server / hook | Save the file. |
| Pick up your changes in-session | `/reload-plugins` (no relaunch needed) |
| Force the wizard to re-run from scratch | `rm ~/.claude/plugins/data/archetype-*/auth.json`, then `/archetype:validation` |
| Watch MCP server logs | Already on stderr if you launched with `--debug` — lines prefixed `[archetype-setup]` |
| Point at a local backend | `export ARCHETYPE_BACKEND_URL=http://localhost:5001` before launching |
| Override the HTTP User-Agent | `export ARCHETYPE_PLUGIN_USER_AGENT="custom/1.0"` (default: `archetype-claude-plugin/<version>`) |

## Configuration

The wizard speaks to the Archetype backend at
`https://api.syntheticarchetype.com` (override with the
`ARCHETYPE_BACKEND_URL` env var).

What the wizard does:

1. **Cached-token check.** If `${CLAUDE_PLUGIN_DATA}/auth.json` exists,
   the wizard validates the saved access token via
   `POST /api/oauth/validate-token`. If still valid, it reports
   "already connected as `<user_id>`" and exits.
2. **Auth0 device-authorization flow** (only when needed):
   - `POST /api/oauth/device/code` mints a one-time verification URL +
     `user_code`.
   - `webbrowser.open()` launches the user's default browser to that
     URL automatically.
   - An **MCP elicitation modal** also renders in the terminal with the
     same URL + code and a single "I've approved" tick box.
   - User approves in browser, ticks the box, hits Accept.
   - The wizard polls `POST /api/oauth/device/token` at the
     backend-given interval until approval completes, then writes the
     access token to `${CLAUDE_PLUGIN_DATA}/auth.json` (mode `0600`).

The token is sent as `Authorization: Bearer <token>` to every protected
backend endpoint (`/api/features`, `/api/uat/...`, etc.).

### How it works under the hood

The `archetype-setup` stdio MCP server (Python 3, stdlib only,
`scripts/setup-server.py`) exposes a single `login` tool, declared
inline in `plugin.json` under `mcpServers`. The validation skill calls
the tool; the server sequences the cached-token check, the device-code
request, the browser launch, the elicitation, the polling, and the
on-disk save — all in one tool call.

## Local development reference

The Dev Quickstart above covers the happy path. Below are long-form
notes for less-common cases.

### --plugin-dir variants

Parent directory:

```bash
claude --plugin-dir ./Archetype_Plugins
```

Absolute path (works from anywhere):

```bash
claude --plugin-dir /absolute/path/to/Archetype_Plugins
```

Stack multiple `--plugin-dir` flags:

```bash
claude --plugin-dir ./Archetype_Plugins --plugin-dir ../OtherPlugin
```

If a plugin with the same `name` is installed from a marketplace, the
local `--plugin-dir` copy takes precedence for that session.

### Debugging tips

- **Skill not appearing?** Check the YAML frontmatter parses (no tabs,
  no stray colons) and that the file is named exactly `SKILL.md`.
- **Hook not firing?** Run `claude --debug` and watch for `SessionStart`
  hook output.
- **MCP server failing?** `/mcp` shows the connection state and the
  last error. `archetype-setup` should be `running`; if it shows
  `failed`, check that `python3` resolves on your PATH and re-run with
  `claude --debug` to see the launcher error.
- **Wizard didn't open a modal?** Verify Claude Code lists the `login`
  tool from `archetype-setup` in `/mcp`. If the server failed to start,
  the skill can't elicit.
- **Cloudflare 1010 on the backend?** The default
  `archetype-claude-plugin/<version>` User-Agent passes; if you've
  overridden `ARCHETYPE_PLUGIN_USER_AGENT` and hit a 1010, switch back
  to the default.
- **Browser didn't pop?** `webbrowser.open()` is best-effort. On
  headless boxes it silently no-ops; the modal still shows the URL so
  the user can copy/paste manually.
- **Wrong directory layout?** Plugin MCP/hook/skill configs all live
  at the **plugin root** — never inside `.claude-plugin/`. Only
  `plugin.json` belongs there.

### Packaging for distribution

When the plugin is ready to share, two options:

1. **Marketplace (recommended for teams):** publish a marketplace repo
   that lists this plugin. See
   <https://code.claude.com/docs/en/plugin-marketplaces>.
2. **Zip + URL:** zip the plugin directory and host it; users load it
   with `claude --plugin-url https://example.com/archetype.zip`.

Bump `version` in `.claude-plugin/plugin.json` for every released
change so update prompts fire cleanly on installed copies.

## Layout

```
Archetype_Plugins/
├── .claude-plugin/
│   └── plugin.json            # manifest (declares the MCP server inline)
├── agents/
│   └── feature-validator.md
├── hooks/
│   └── hooks.json
├── scripts/
│   └── setup-server.py        # stdio MCP server for the elicitation wizard
├── skills/
│   ├── validation/SKILL.md
│   ├── validate-feature/SKILL.md
│   ├── list-features/SKILL.md
│   └── check-run-status/SKILL.md
└── README.md
```
