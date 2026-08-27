---
name: validation
description: The core Archetype actor loop. Use for the /archetype:validation command. With no arguments, connects the session to Archetype (login wizard). With arguments, parses the natural language into one or MORE run objects (goal, url, pool, feature) — comparison phrasing like "as <pool A> and as <pool B>" fans out into multiple runs. Every run executes in a freshly launched feature-validator agent (zero dev context) and multi-run output is a cross-pool comparison report.
---

# Validation

You are responding to the `/archetype:validation` command. This skill is the
**actor** in the Archetype pipeline: the backend hands you a persona and a set
of test scenarios, and you drive a real browser through the product under test
*as that persona*, then report what happened. When a run targets a persona
pool, the backend spins off one fresh tester from the pool's distribution and
that member is the persona you become.

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

Invoke the `login` tool from the `core` MCP server (its full tool
name in your tools list ends with `__login`). The tool encapsulates the entire
connection flow — cached-token check, device-code request, browser launch,
elicitation modal, polling, and the on-disk token save — in a single call.

Steps for you (Claude):

1. Locate the `login` tool from `core` in your available tools. The
   `core` tools may be deferred; if so, load them first with
   ToolSearch (query `select:mcp__plugin_archetype_core__login`).
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

### 1. Intake: parse `$ARGUMENTS` into a RUN LIST with judgment, then confirm

`$ARGUMENTS` is natural language, not a token grammar — you are the parser,
so parse like one intelligent reader, not a regex. The output of intake is a
**list of run objects**, each:

```jsonc
{ "goal": "...", "url": "...", "pool": "<intent or null>", "feature": "<name or null>" }
```

| field | what to look for |
| :-- | :-- |
| `goal` | what to test — the free text minus everything captured below |
| `url` | a `url=<...>` token or any URL in the text |
| `pool` | ANY tester/persona intent: a `pool=<...>` token, a saved pool's name ("as <name>", "with <name>"), or a description ("as cautious non-technical first-timers", "from the perspective of ...") |
| `feature` | a named saved feature (prefer the `validate-feature` skill when feature-first) |

**One command can mean several runs.** Comparison or fan-out phrasing
produces one object per combination the user actually means:

- "as <name A> **and** as <name B>" / "compare <name A> vs <name B>" → 2 runs, same
  goal+url, different pools.
- "with each of my pools" / "with each of my personas" → resolve via
  `list_pools`, one run per pool (confirm the count before starting).
- "on staging and on prod" (two URLs) → one run per URL.
- Unmentioned fields are SHARED: one url + two pools → both objects carry
  that url. Don't multiply dimensions the user didn't ask to cross.

A single-intent command is simply a list of one — behavior unchanged.

**Pool resolution** (for every distinct tester intent in the list — name
OR description; call `list_pools` once and reuse it):

1. Call `list_pools` so you know what actually exists.
2. Match the intent against the real pools — case-insensitively on the
   pool's name, falling back to its archetype name (the `archetype:` line
   in the tool output, from `metadata.primary_archetype_name`), or best
   description fit.
3. Propose the match conversationally before using it: "I found
   **<name>** (<one-line description>) — largely fits your description.
   Test with a member of that pool, or create a new pool?" **Several pools
   matching the same name → list the candidates (name · description ·
   created) and ask the user to pick — never guess.**
4. **None plausible → create from blank, right here.** One confirmation:
   "No existing pool fits — create one from your description and run
   with it?" On yes, call `create_pool` directly with their description
   as the `vibe_prompt` (plus whatever controls their words imply, and a
   short `name`) — skip previews unless they ask to see options — then
   continue the run with the fresh pool's id. Never dead-end the user into
   a separate command; `/archetype:persona` is for when they want the full
   guided flow.
5. Only a pool the user confirmed becomes `pool_id`. NEVER silently drop
   tester intent into the goal text, and never guess between candidates.

**Feature resolution**: a named feature that doesn't exist gets the same
treatment — offer to create it on the spot (`create_feature` with a title
and a one-line description distilled from their words; ask only for what
you genuinely can't infer), then run with the new `feature_id`.

**Confirm before starting**: present the run list as a table (one row per
run: goal · url · pool · feature). Single run with every field explicit
and unambiguous → proceed straight away, stating the row as what you're
about to do. Anything missing (a URL is required — never guess one),
inferred, or fuzzy-matched → ask about exactly those fields first — one
compact question, not an interrogation. **Multiple runs → always confirm the
list once** (they each cost real minutes) before starting. When a run
targets a pool, warn at kickoff that spinning off a fresh tester adds up to
~a minute before the browser session starts.

### 2. Execute every run in a FRESH agent

The persona must be performed by a **newly launched agent with no dev
context**. An actor that has read this session's code, plans, or prior
findings cannot get lost the way a real user does — it "knows" where the
buttons are and unconsciously routes around known bugs. Never run the actor
loop in the main session (one exception below).

For the confirmed run list (one run or many):

1. Make sure the session is connected FIRST — subagents cannot render the
   login modal. Pool/feature resolution during intake already self-heals
   auth in the main session; if intake made NO authed call (e.g. a plain
   goal+url run), call `status` now, and if it reports a missing or expired
   token, run the `login` tool here in the main session before dispatching.
2. Dispatch the `feature-validator` agent once per run object. The dispatch
   prompt carries ONLY the run's resolved fields — goal, url, `feature_id`,
   `pool_id` plus the pool's display name (for the agent's sanity check
   against the brief). Deliberately include nothing else: no product
   background, no known issues, no prior run results — a clean actor is the
   point.
3. Multiple runs execute **sequentially** — the agents share one Chrome;
   parallel dispatch makes them fight over the browser.
4. If a run comes back with the "backend did not honor the pool" error,
   stop the remaining pool-selected runs (they will fail the same way)
   and surface it once.

The full actor loop (become the persona, drive Chrome, keep the step log,
`report_result` exactly once) is defined in the `feature-validator` agent —
that file is the single source of truth for run execution.

**Watch-live exception**: only if the user explicitly asks to watch the
persona act live, run the loop inline in the main session by following the
`feature-validator` operating procedure verbatim — and tell the user the
trade-off first: an in-session actor carries dev context and gives less
faithful feedback.

### 3. Render the report

Relay the agent's report; don't re-investigate it. Single run:

- A **scenario verdict table**: scenario id · title · status
  (pass/fail/blocked) · actualResult (what actually happened, in a few
  words).
- **Findings by severity** (critical first), each with category and a
  one-line description.
- The **persona quote** (`personaReaction`) as a pull-quote.
- The **run id**, and "Check status later with
  `/archetype:check-run-status <run_id>`."

Multiple runs get a **comparison report**, not N stacked reports:

- Header: one row per run — tester (and the pool they were spun from) ·
  verdict · run id.
- Scenario outcomes side by side where scenarios align.
- Findings split into "hit by all testers" vs "only <name> hit this" (the
  per-pool deltas are the interesting part).
- Each tester's reaction quote.
- Close with `/archetype:check-run-status <run_id>` per run.

---

## Boundaries (always)

- Never simulate the backend or invent run data. Runs come only from
  `start_run`; results go only through `report_result`.
- Exactly one SUCCESSFUL `report_result` call per run: retry on error, never
  re-send after a success confirmation.
- The persona actor is always a freshly launched `feature-validator` agent —
  inline execution only on the user's explicit ask to watch live.
- Everything you report must reflect what you actually did in the browser.
