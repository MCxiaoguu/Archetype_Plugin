---
description: Validation using Archetype
---

# Validation

You are responding to the `/archetype:validation` command. Branch on `$ARGUMENTS`:

- **Empty `$ARGUMENTS`** → run the **Login wizard** below.
- **Non-empty `$ARGUMENTS`** → hand off to the `validate-feature` skill, passing `$ARGUMENTS` through as the feature identifier or natural-language target.

## Login wizard

Invoke the `login` tool exposed by the `archetype-setup` MCP server (its full tool name in your tools list contains `archetype-setup__login`). The tool encapsulates the entire connection flow:

1. **Cached-token check.** It reads `${CLAUDE_PLUGIN_DATA}/auth.json` and calls `POST /api/oauth/validate-token` on the backend.
   - Valid → tool returns "already connected as `<user_id>`".
   - Missing or expired → tool proceeds to the device flow.
2. **Device flow** (only when needed):
   - Calls `POST /api/oauth/device/code` to get a verification URL + code.
   - Pops an MCP **elicitation modal** showing the URL and code, with a single "I've approved" tick box.
   - After the user opens the URL, approves in their browser, and accepts the modal, the tool polls `POST /api/oauth/device/token` at the backend-given interval.
   - On success it saves the access token to `${CLAUDE_PLUGIN_DATA}/auth.json` with mode `0600` and returns success.

Steps for you (Claude):

1. Locate the `login` tool from `archetype-setup` in your available tools.
2. Call it with an empty arguments object — no parameters.
3. **On success**: report the tool's response verbatim (it will say either "already connected as X" or "connected and token saved at <path>").
4. **On cancellation, timeout, or error**: surface the error verbatim and ask whether the user wants to retry.

Do not ask the user to paste anything in chat. Do not try to shortcut or simulate the device flow. The modal + browser approval is the only authorized path.
