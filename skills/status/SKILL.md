---
name: status
description: Show the Archetype connection dashboard — which account is connected, token health, backend reachability, saved-feature count, recent runs from this machine, and a quick link to the Archetype portal. Use for /archetype:status or when the user asks who is logged in, whether the plugin is connected, or where the Archetype dashboard is.
---

# Status

Render the Archetype connection dashboard in one tool call.

## Workflow

1. Call the `status` tool from the `core` MCP server with no
   arguments.
   - The `core` tools may be deferred; if so, load this one first
     with ToolSearch (query
     `select:mcp__plugin_archetype_core__status`).
2. Relay the dashboard the tool returns, lightly formatted as markdown:
   - Keep the Account / Token / Backend / Features lines as-is.
   - Render the recent-runs block as a short list (run id · goal · outcome).
   - Render the portal URL as a clickable markdown link labeled
     **Open Archetype portal**.
3. If the dashboard says "Not connected", suggest `/archetype:setup` to
   run the login wizard. Do not call the `login` tool from this skill — status
   is read-only.

## Boundaries

- One `status` tool call, nothing else — no login, no feature listing, no run
  lookups from here.
- Only show what the tool returned. Never invent account, feature, or run
  data.
