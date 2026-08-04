---
name: logout
description: Log out of Archetype. Use for /archetype:logout or when the user wants to disconnect, sign out, switch accounts, or clear the plugin's saved credentials. Deletes the locally cached token via the core MCP server; run history is preserved.
---

# Logout

You are responding to `/archetype:logout` — disconnect this machine from the
user's Archetype account.

## Workflow

1. Call the `logout` tool from the `core` MCP server with no arguments.
   - It may be deferred; load it first with ToolSearch
     (query `select:mcp__plugin_archetype_core__logout`).
2. Relay the tool's message: who was logged out (if known), that credentials
   were deleted locally while run history is kept, and that
   `/archetype:setup` reconnects.
3. If the user asked to **switch accounts**, offer to run `/archetype:setup`
   right away.

## Boundaries

- One `logout` tool call, nothing else. Never call `login` from this skill
  unless the user asked to switch accounts and confirmed.
- Do not delete any files yourself — the tool owns the credential path.
