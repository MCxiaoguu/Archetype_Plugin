---
name: list-features
description: List the user's saved Archetype features so they can pick one to validate. Use when the user wants to see which features are available for validation or asks to browse their Archetype features.
---

# List Features

Fetch and display the catalog of features saved in the user's Archetype account
so they can pick one to validate.

## Workflow

1. Call the `list_features` tool from the `archetype-setup` MCP server. If the
   user gave a search term, pass `$ARGUMENTS` as the `query` (an optional
   case-insensitive title filter); otherwise call it with no arguments.
   - The `archetype-setup` tools may be deferred; if so, load them first with
     ToolSearch (query `select:mcp__plugin_archetype_archetype-setup__list_features`).
2. Auth is self-healing: if the session isn't connected, the tool itself opens
   the login modal and then completes the request — do not pre-call `login`.
   A "Not connected" error only comes back if the user declined the login;
   surface it and stop.
3. Render the returned features as a concise table:

   | id | title | updated |
   | :-- | :-- | :-- |
   | `<_id>` | `<title>` | `<updatedAt>` |

   If the tool reports no features (or none matching the query), relay that
   plainly — and offer to create one on the spot (`create_feature`, one
   confirmation, title + one-line description).
4. Suggest the next step: `/archetype:validate-feature <title>` to run a
   validation for one of the listed features.

## Boundaries

- Only show features the `list_features` tool actually returned. Never invent
  feature ids or titles.
