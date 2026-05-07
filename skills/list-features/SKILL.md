---
description: List features available for validation in the Archetype web portal. Use when the user wants to see which features can be validated or asks to browse Archetype features.
---

# List Features

Fetch and display the catalog of features registered in the Archetype web
portal so the user can pick one to validate.

## Workflow

1. Resolve the portal URL and API key from `.mcp.json` / environment.
2. Call `GET {ARCHETYPE_PORTAL_URL}/api/features` (optionally filter with
   `$ARGUMENTS` as a search query).
3. Render a concise table: id, name, owner, last validation status, last run
   timestamp.
4. Suggest the `validate-feature` skill as the next step.
