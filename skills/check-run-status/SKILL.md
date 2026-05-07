---
description: Check the status of an in-flight or recent feature validation run on the Archetype web portal. Use when the user asks about run status, validation progress, or results for a specific run id.
---

# Check Run Status

Look up a specific feature validation run by id and report its current state.

## Workflow

1. Treat `$ARGUMENTS` as the run id. If empty, ask the user for one or fall
   back to the most recent run id observed in this session.
2. Call `GET {ARCHETYPE_PORTAL_URL}/api/feature-validation/runs/{run_id}`.
3. Report:
   - Status (`queued`, `running`, `passed`, `failed`, `error`)
   - Started / finished timestamps
   - Scenario pass/fail counts
   - Direct link to the run in the portal UI
4. If the run failed, surface the first failing scenario's assertion details
   so the user can act on them immediately.
