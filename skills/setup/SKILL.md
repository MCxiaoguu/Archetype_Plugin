---
name: setup
description: Onboarding for the Archetype plugin. Use for /archetype:setup or whenever the user wants to connect, log in, re-authenticate, or get started with Archetype. Runs the device-flow login wizard via the archetype-setup MCP server, then shows the status dashboard and suggests first steps.
---

# Setup

You are responding to `/archetype:setup` — the onboarding command. It connects
this session to the user's Archetype account and orients them.

## Workflow

1. Call the `login` tool from the `archetype-setup` MCP server with an empty
   arguments object. It encapsulates the whole connection flow: cached-token
   check, device-code request, browser launch, elicitation modal, polling,
   and the on-disk token save.
   - The tools may be deferred; load both needed here in one ToolSearch query
     (`select:mcp__plugin_archetype_archetype-setup__login,mcp__plugin_archetype_archetype-setup__status`).
2. **On success** (newly connected or "already connected as X"): call the
   `status` tool and render the dashboard (account, backend, features,
   recent runs, portal link — no raw ids).
3. Close with first steps, one line each:
   - `/archetype:persona` — meet (or create) the personas that will test your
     product.
   - `/archetype:validation "<goal>" url=<...>` — run a validation.
   - `/archetype:status` — check this dashboard anytime.
4. **On cancellation, timeout, or error**: surface the tool's message
   verbatim and ask whether to retry.

## Boundaries

- Do not ask the user to paste codes or tokens in chat; the elicitation modal
  + browser approval is the only authorized path.
- Do not shortcut or simulate the device flow.
