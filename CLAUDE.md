- Use Fable for orchestration
- Use Opus for complicated long-shots
- Use Sonnet for simple, straightforward tasks
- Always refer to ../Archetype_Core for more details. 
- When pick up with no memory, always first read, unless user explicits prohibits. 


The product central idea is to let the user [of this product] to build their products as if the customers are by their side - this way they can get immediate, faithful feedback on their work.
This repo contains the Archetype Plugins for CLAUDE Code for product testing and feature validation. Fundamentally, this is the actor part of the pipeline - it uses claude code's inherent ability of using chrome to test the web site/product that the user is developing. The idea is that from the archetype backend we get the desired persona, test goal, feature etc. setup, and then send straightly to this actor. Once the testing finishes, we send back to the archetype backend with the results for persistency, along with the local presentation inside the claude code which should be handled by the plugin. 
Central ref that you must read:
1. https://code.claude.com/docs/en/plugins-reference
2. https://code.claude.com/docs/en/plugins
3. All other claude code related plugin documentation.

## Status: actor contract implemented

The actor half of the pipeline is now wired to the real backend contract. The
`archetype-setup` MCP server (`scripts/setup-server.py`) exposes eight tools —
`login`, `start_run`, `report_result`, `get_run`, `list_features`, `status`,
`list_personas`, `create_persona` — talking to the backend's `/api/plugin`,
`/api/features`, and `/api/persona` endpoints. The six skills (`validation`,
`validate-feature`, `list-features`, `check-run-status`, `status`, `persona`)
and the `feature-validator` agent drive the actor loop over those tools: `start_run` → become the persona → drive Claude-in-Chrome through the
scenarios → keep a snake_case step log → `report_result` once → render a local
report. Auth is a single device-flow Bearer scheme and is self-healing: any
authed tool that finds a missing/expired token runs the login elicitation
inline and retries once (`status` is read-only and never triggers login).
`status` renders a dashboard (account from the id_token, token health, feature
count, recent runs from `${CLAUDE_PLUGIN_DATA}/runs.json`, portal link;
portal default `https://www.syntheticarchetype.com`, override via
`ARCHETYPE_PORTAL_URL`). `/archetype:persona` lists personas and creates new
ones questionnaire-style (vibe prompt + controls → preview → save); runs accept
`persona=<personaId>` which `start_run` forwards as `personaId` so the backend
uses that persona instead of the replay-derived one.

Authoritative references for this work:
- Design spec: `docs/superpowers/specs/2026-07-22-plugin-backend-pipeline-design.md` (§4.2 covers the skills).
- Implementation plan: `docs/superpowers/plans/2026-07-22-plugin-backend-pipeline.md`.