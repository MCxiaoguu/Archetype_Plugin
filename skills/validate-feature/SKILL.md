---
description: Run a feature validation test against the Archetype web portal. Use when the user asks to validate a feature, run feature validation, or test a feature through Synthetic Archetype.
---

# Validate Feature

Trigger a feature validation run via the Archetype web portal for the feature
named "$ARGUMENTS".

## Workflow

1. **Identify the feature.** If `$ARGUMENTS` is empty, ask the user which
   feature (by id, slug, or name) they want to validate. Otherwise treat the
   value as the feature identifier.
2. **Locate the portal connection.** Read the plugin's `.mcp.json` and the
   `ARCHETYPE_PORTAL_URL` / `ARCHETYPE_API_KEY` environment variables to find
   the configured Archetype web portal endpoint.
3. **Kick off the validation run.** Call the portal's validation endpoint
   (`POST {ARCHETYPE_PORTAL_URL}/api/feature-validation/runs`) with the
   feature identifier. Capture the returned run id.
4. **Stream / poll status.** Poll `GET .../runs/{run_id}` until the run
   reaches a terminal state (`passed`, `failed`, `error`). Surface progress
   to the user as it advances.
5. **Summarize results.** Report pass/fail, scenario counts, and a link to
   the full report in the portal. On failure, list the failing scenarios
   with their assertion messages.

## Notes

- Never invent feature ids — confirm them with the user or via the
  `list-features` skill before kicking off a run.
- If the portal is unreachable, surface the exact error rather than retrying
  silently.
