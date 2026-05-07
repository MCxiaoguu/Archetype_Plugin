# archetype-feature-validation

Claude Code plugin that drives **feature validation runs** through the
Synthetic Archetype web portal from inside your editor or terminal.

## What it gives you

| Component | Path | Purpose |
| :--- | :--- | :--- |
| Skill | `skills/validate-feature/` | Kick off a validation run for a feature |
| Skill | `skills/list-features/` | Browse features available for validation |
| Skill | `skills/check-run-status/` | Look up the status / results of a run |
| Agent | `agents/feature-validator.md` | End-to-end orchestrator: select → run → monitor → triage |
| MCP   | `.mcp.json` | HTTP MCP connection to the Archetype portal |
| Hook  | `hooks/hooks.json` | Session-start sanity check for required env vars |

## Configuration

The plugin reads two environment variables:

- `ARCHETYPE_PORTAL_URL` — base URL of your Archetype web portal
  (e.g. `https://portal.archetype.example.com`)
- `ARCHETYPE_API_KEY` — bearer token for the portal API

Set them in your shell profile or a project-local `.env` before launching
Claude Code.

## Local development

From this repo's parent directory:

```bash
claude --plugin-dir ./Archetype_Plugins
```

Then try:

```text
/archetype-feature-validation:list-features
/archetype-feature-validation:validate-feature FEAT-184
/archetype-feature-validation:check-run-status <run-id>
```

After editing any plugin file, run `/reload-plugins` to pick up changes.

## Layout

```
Archetype_Plugins/
├── .claude-plugin/
│   └── plugin.json
├── .mcp.json
├── agents/
│   └── feature-validator.md
├── hooks/
│   └── hooks.json
├── skills/
│   ├── validate-feature/SKILL.md
│   ├── list-features/SKILL.md
│   └── check-run-status/SKILL.md
└── README.md
```
