---
name: validation
description: The core Archetype actor loop. Use for the /archetype:validation command. With no arguments, connects the session to Archetype (login wizard). With arguments (a natural-language goal and/or a url=<...> token), it starts a validation run, becomes the assigned persona, drives Chrome through each scenario as that persona, and reports structured results back to the backend.
---

# Validation

You are responding to the `/archetype:validation` command. This skill is the
**actor** in the Archetype pipeline: the backend hands you a persona and a set
of test scenarios, and you drive a real browser through the product under test
*as that persona*, then report what happened.

Branch on `$ARGUMENTS`:

- **Empty `$ARGUMENTS`** → run the **Login wizard** (below) and stop. (The
  canonical onboarding command is `/archetype:setup`; this branch is kept so
  a bare `/archetype:validation` still connects.)
- **Non-empty `$ARGUMENTS`** → run the **Validation run flow** (below).

Never simulate the backend, invent run/persona data, or fabricate steps and
results. Everything you report must come from what you actually observed in the
browser, and every run must be created by the `start_run` tool.

---

## Login wizard

Invoke the `login` tool from the `archetype-setup` MCP server (its full tool
name in your tools list ends with `__login`). The tool encapsulates the entire
connection flow — cached-token check, device-code request, browser launch,
elicitation modal, polling, and the on-disk token save — in a single call.

Steps for you (Claude):

1. Locate the `login` tool from `archetype-setup` in your available tools. The
   `archetype-setup` tools may be deferred; if so, load them first with
   ToolSearch (query `select:mcp__plugin_archetype_archetype-setup__login`).
2. Call it with an empty arguments object — no parameters.
3. **On success**: report the tool's response verbatim (it will say either
   "already connected as X" or "connected and token saved at <path>").
4. **On cancellation, timeout, or error**: surface the error verbatim and ask
   whether the user wants to retry.

Do not ask the user to paste anything in chat. Do not try to shortcut or
simulate the device flow. The MCP elicitation modal + browser approval is the
only authorized path.

---

## Validation run flow

Run this when `$ARGUMENTS` is non-empty. Follow the steps in order.

### 1. Intake: understand `$ARGUMENTS` with judgment, then confirm

`$ARGUMENTS` is natural language, not a token grammar. YOU parse and
categorize it. Fill this field table:

| field | what to look for |
| :-- | :-- |
| `goal` | what to test — the free text minus everything captured below |
| `url` | a `url=<...>` token or any URL in the text |
| `persona` | ANY persona intent: a `persona=<...>` token, a name ("as Veda", "with Marcus"), or a description ("as a cautious non-technical first-timer", "from the perspective of ...") |
| `feature` | a named saved feature (prefer the `validate-feature` skill when feature-first) |

**Persona resolution** (whenever the persona field is non-empty — name OR
description):

1. Call `list_personas` so you know what actually exists.
2. Match the intent against the real personas — exact/close name match, or
   best description fit (occupation, story, traits).
3. Propose the match conversationally before using it: "I found
   **<name>** (<one-line story>) — largely fits your description. Test with
   them, or create a new persona?" Multiple plausible → show candidates and
   ask. None plausible → say so and offer `/archetype:persona new`.
4. Only a persona the user confirmed becomes `persona_id`. NEVER silently
   drop persona intent into the goal text, and never guess between
   candidates.

**Confirm before starting**: present the filled table briefly. If every
field was explicit and unambiguous, proceed straight away, stating the table
as what you're about to do. If anything was missing (a URL is required —
never guess one), inferred, or fuzzy-matched, ask about exactly those fields
first — one compact question, not an interrogation.

### 2. Start the run

Call the `start_run` tool from the `archetype-setup` MCP server with:

- `goal`: the parsed goal (omit if you're running purely by `feature_id`).
- `url`: the target URL (required).
- `feature_id`: only if the user named a feature you have an id for.
- `persona_id`: the confirmed persona's id from intake, if any.

The tool itself guards persona selection: if the backend does not honor the
requested persona (e.g. an outdated deployment), `start_run` returns an
error instead of a briefing — relay it and stop; never proceed as a persona
the user didn't pick. As a final check, the brief's persona name should
match the confirmed persona; on any mismatch, stop and tell the user.

The tool's result text is **authoritative guidance**. It contains: the mission
brief, a first-person persona card, numbered scenarios (each with steps and an
expected result), conduct rules, the `runId` and `sessionId`, and the full
`report_result` contract. Read all of it.

**Error handling:** auth is self-healing — if the session isn't connected (or
the token expired), `start_run` itself opens the login modal and then starts
the run; do not pre-call `login`. A "Not connected" error only comes back if
the user declined the login; surface it and stop — do not fabricate a run.

Tip: this flow also needs `report_result` later — load both in one ToolSearch
query
(`select:mcp__plugin_archetype_archetype-setup__start_run,mcp__plugin_archetype_archetype-setup__report_result`).

Record the `runId` and `sessionId` — you need them for `report_result`.

### 3. Become the persona

The brief, persona card, and conduct rules from the `start_run` result are
authoritative. Adopt them fully. Summarize to the user in about three lines:
who you are (persona name + one-line character), and what you are about to test
(the goal and the target URL). Then begin.

From here on, act *as this persona*: their patience, skill level, reading
speed, and mood. Narrate your actions in the persona's first-person voice.

### 4. Open the browser

The Claude-in-Chrome browser tools are deferred and must be loaded before use.

1. Load them with ToolSearch (query `claude-in-chrome`). At minimum you need
   `tabs_context_mcp`, `tabs_create_mcp`, `navigate`, `computer`,
   `get_page_text`/`read_page`, and `find`.
2. Call `tabs_context_mcp` FIRST to see the current browser/tab state.
3. Create a **NEW** tab (`tabs_create_mcp`) for the target URL — do not hijack
   an existing tab.
4. Navigate that tab to the target URL.

**Whole-run browser failure:** if the target site never loads, Chrome isn't
connected, or the browser tools are unusable, do NOT abandon the run silently.
Mark all scenarios `blocked`, call `report_result` with status `"failed"` and a
finding describing exactly what you observed, then tell the user.

### 5. Execute the scenarios

Work through each scenario **in order**, acting at the persona's
patience/skill/reading level.

Keep a running **step log** as you go. For every meaningful action, record an
object with these keys (snake_case — this is the shape `report_result` wants):

- `seq`: a 1-based integer, strictly increasing across the whole run.
- `scenario_id`: the id of the scenario you're on (e.g. `"SC-1"`).
- `action_text`: what you actually did, plain and factual (e.g. "clicked Start
  free trial").
- `narration`: a short persona-voice inner monologue (e.g. "Ugh, nothing
  happened when I clicked — is it broken?").
- `url`: the page URL at that moment.
- `observation_page_type`: one or two words describing the page
  (`"landing"`, `"pricing"`, `"signup-form"`, etc.).
- `success`: `true` if the action did what you intended, `false` otherwise.
- `error`: optional string if something went wrong.
- `screenshot_b64`: OPTIONAL. The browser/computer tools return screenshots;
  only attach one for a few key moments and only if it's readily available.
  Never exceed 6 screenshots total across the whole run, and keep each under
  1 MB. When in doubt, omit it.

Conduct rules while acting:

- Time-box each scenario to about 3 minutes. If a scenario is blocked (a flaw,
  a dead end, something you genuinely can't complete as this persona), mark
  that scenario `blocked` and move on to the next one.
- Stay on the target site. Do not wander to unrelated URLs.
- Never fabricate steps, observations, or results. If you didn't see it, don't
  report it.

### 6. Report results

When you have worked through all scenarios (or exhausted them), call the
`report_result` tool from the `archetype-setup` MCP server with the full
payload. Make exactly one SUCCESSFUL call: if the call itself errors, you may
retry with the same payload (auth is self-healing — an expired token re-opens
the login modal inside the tool call); but once you receive a success
confirmation, never re-send. Top-level keys are snake_case; the tool maps them
to the backend. The `feedback` object's nested keys are already camelCase.

The shape below mirrors the contract rendered by `start_run`; if they ever
differ, the `start_run` text wins.

```jsonc
{
  "run_id": "<runId from start_run>",
  "session_id": "<sessionId from start_run>",
  "status": "completed",            // one of: completed | failed | aborted
  "duration_seconds": 312,          // approximate wall-clock of the run
  "steps": [
    {
      "seq": 1,
      "scenario_id": "SC-1",
      "action_text": "clicked Start free trial",
      "narration": "Nothing happened for a second — did it register?",
      "url": "http://localhost:8321/",
      "observation_page_type": "landing",
      "success": true
      // "error": "<only when something went wrong>"
      // "screenshot_b64": "<optional, ≤1MB, ≤6 total>"
    }
    // ... one object per meaningful action, seq strictly increasing
  ],
  "feedback": {
    "verdict": "mixed",             // one of: pass | fail | mixed
    "summary": "<a few sentences: what worked, what broke, overall impression>",
    "scenarioResults": [
      {"scenarioId": "SC-1", "status": "pass", "actualResult": "<what actually happened>"}
      // status is one of: pass | fail | blocked
    ],
    "findings": [
      {
        "scenarioId": "SC-1",
        "category": "ux",           // bug | ux | content | performance | other
        "severity": "high",         // critical | high | medium | low
        "description": "<the problem, concretely>",
        "evidenceStepSeq": 4        // the step.seq that demonstrates it
      }
    ],
    "personaReaction": "<a first-person quote capturing how the persona felt>"
  }
}
```

Choose `status`: `completed` if you ran the scenarios through, `failed` if the
run broke down, `aborted` if you deliberately stopped early. Choose `verdict`
from the *product's* performance: `pass` (everything worked), `fail`
(core goal couldn't be achieved), or `mixed`.

### 7. Render the local report

After `report_result` succeeds, present a concise report to the user:

- A **scenario verdict table**: scenario id · title · status (pass/fail/blocked)
  · actualResult (what actually happened, in a few words).
- **Findings by severity** (critical first), each with category and a one-line
  description.
- The **persona quote** (`personaReaction`) as a pull-quote.
- The **run id**.
- A closing line: "Check status later with
  `/archetype:check-run-status <run_id>`."

---

## Boundaries (always)

- Never simulate the backend or invent run data. Runs come only from
  `start_run`; results go only through `report_result`.
- Exactly one SUCCESSFUL `report_result` call per run: retry on error, never
  re-send after a success confirmation.
- Everything you report must reflect what you actually did in the browser.
