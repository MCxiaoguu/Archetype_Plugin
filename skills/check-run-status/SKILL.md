---
name: check-run-status
description: Check the status, progress, and results of an Archetype validation run by its run id. Use when the user asks about run status, validation progress, or the outcome of a specific run.
---

# Check Run Status

Look up a specific validation run by its id and report where it stands.

## Workflow

1. Determine the run id:
   - Treat `$ARGUMENTS` as the run id if present.
   - If empty, fall back to the most recent run id you saw earlier in this
     session (from a `start_run` / `report_result` you ran).
   - If you have neither, ask the user for the run id.
2. Call the `get_run` tool from the `archetype-setup` MCP server with
   `run_id` set to that id.
   - The `archetype-setup` tools may be deferred; if so, load them first with
     ToolSearch (query `select:mcp__plugin_archetype_archetype-setup__get_run`).
   - **On a "Not connected" error** → run the `login` tool (see the
     `validation` skill's Login wizard), then retry `get_run` once.
3. Report what the tool returns:
   - **Status** and **progress** (e.g. `running · 60%`, `completed · 100%`).
   - **analyticsReady** (whether downstream analytics have finished).
   - If a **feedback verdict + summary** is present (the run has finished),
     relay the verdict (`pass`/`fail`/`mixed`) and the summary line.
4. If the run is still `running`, tell the user it hasn't finished and suggest
   checking again shortly with `/archetype:check-run-status <run_id>`.

## Boundaries

- Report only what `get_run` returns. Never fabricate a status, verdict, or
  summary.
