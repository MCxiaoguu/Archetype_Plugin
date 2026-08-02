---
name: validate-feature
description: Feature-first entry into an Archetype validation run. Use when the user asks to validate, test, or run validation on a specific saved feature by name (e.g. "validate the signup feature"). Resolves the feature via list_features, then runs the same actor loop as the validation skill with the feature's id attached.
---

# Validate Feature

This is the **feature-first** doorway into a validation run. Instead of the
user handing you a goal, they name a saved feature; you look it up, match it,
and then run the standard actor loop with that feature's id set.

The run loop itself is identical to the `validation` skill — do not duplicate
it here. This skill only covers how to resolve the feature and the deltas.

## Workflow

### 1. Resolve the feature

Call the `list_features` tool from the `archetype-setup` MCP server. Pass
`$ARGUMENTS` as the `query` (an optional case-insensitive title filter). The
tool returns a list of features, each with an `_id`, `title`, and `updatedAt`.

- **Exact/clear single match** → use that feature's `_id` as `feature_id`.
- **Multiple plausible matches or ambiguous input** → show the candidates to
  the user and ask which one they mean. Never guess.
- **No match** → show what exists (or none), then offer to create it right
  here: one confirmation, then `create_feature` with a title and one-line
  description distilled from what they said (ask only for what you can't
  infer), and continue the run with the new feature's `_id`. Don't make the
  user go elsewhere first.
- Auth is self-healing: if the session isn't connected, the tool itself opens
  the login modal and then completes the request — do not pre-call `login`.
  A "Not connected" error only comes back if the user declined the login;
  surface it and stop.

### 2. Ask for the target URL

`list_features` returns features but not necessarily a URL to test. If the user
didn't supply a `url=<...>` token in `$ARGUMENTS`, ASK them for the product
URL. Never guess a URL.

### 3. Run the standard actor loop

Now follow the **Validation run flow** from the `validation` skill, with these
deltas:

- When you call `start_run`, pass `feature_id` set to the resolved feature's
  `_id`, and `url` set to the target URL. The **goal is optional** — the
  backend derives it from the feature's fields when `feature_id` is given. Only
  pass a `goal` if the user gave you extra free-text intent to layer on top.
- Persona intent in `$ARGUMENTS` (token, name, or description) works here
  too — run the `validation` skill's persona resolution (list_personas →
  propose match → confirm) and pass the confirmed id as `persona_id`.
- Everything else is the same: become the persona, load Claude-in-Chrome tools,
  drive each scenario as the persona, keep the snake_case step log, call
  `report_result` exactly once, and render the local report (scenario verdict
  table, findings by severity, persona quote, run id, and the
  `/archetype:check-run-status <run_id>` follow-up).

## Boundaries

- Never invent feature ids — every id must come from `list_features`.
- Never simulate the backend or fabricate steps/results. Runs come only from
  `start_run`; results go only through `report_result`, exactly once.
