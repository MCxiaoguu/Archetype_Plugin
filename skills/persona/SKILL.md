---
name: persona
description: Persona-pool dashboard and questionnaire-driven pool creation. Use for /archetype:persona — lists the user's persona pools (name, description, members, created) usable in validation runs; if none exist (or the user says new), walks them through a short questionnaire, previews candidate directions, and saves the chosen one as a pool via the backend.
---

# Persona

You are responding to `/archetype:persona`. A **pool** is a distribution spec
for a kind of tester — individual testers are spun off from it at validation
time, one fresh member per run. Two modes, branched on `$ARGUMENTS`:

- **Empty** → **Dashboard** (below). Offer creation only if the list is empty
  or the user asks.
- **`new`** (or any free text describing the testers) → **Creation flow**. If
  free text was given, treat it as raw material for the vibe prompt and skip
  the questions it already answers.

The `core` tools may be deferred; load both pool tools in one
ToolSearch query
(`select:mcp__plugin_archetype_core__list_pools,mcp__plugin_archetype_core__create_pool`).
Auth is self-healing: the tools log the user in if needed — never pre-call
`login`.

## Dashboard

1. Call `list_pools` (no arguments).
2. Render the result as a table: **name · description · members · created**.
   Do NOT show poolIds or member-level ids — they're tool-plane noise. Only
   include an id column if the user explicitly asks (e.g. "show ids").
3. Close with the run hint:
   `/archetype:validation "<goal>" url=<...> pool="<name>"`.
4. If the tool says there are no pools, relay that plainly and ask ONE
   question: would they like to create one now? If yes → Creation flow.

## Creation flow (questionnaire → preview → save)

Ask these one at a time (skip any the user already answered; keep it
conversational, not a form):

1. **Who are they?** The kind of tester the pool describes — role/occupation
   and a phrase of character, e.g. "vibe-coding solo founders", "skeptical
   enterprise IT admins".
2. **Age range?** Offer a few brackets (18–25, 26–35, 36–50, 50+) or take a
   custom one.
3. **Tech-savviness?** novice / comfortable / power-user / builds-their-own
   → map to `skills_range` roughly: [10,35] / [35,65] / [65,85] / [80,100].
4. **What do they care about / what annoys them?** Free text — patience,
   trust, pricing sensitivity, aesthetics, speed.
5. **Product context**: one line on what product they'll be evaluating. If
   this session already knows (recent validation target, CLAUDE.md), propose
   it and just ask for confirmation.

Then:

6. Compose a natural-language `vibe_prompt` from the answers (2–3 sentences in
   plain English — no key:value dumps), and call `create_pool` with
   `preview_only: true`, `preview_count: 2`, plus the mapped `age_range`,
   `skills_range`, `occupation`, and `product_description`.
7. Present both candidates side by side (name, vibe, story, need) and ask
   which direction fits — or neither (revise the prompt and re-preview).
   Be explicit that these are **directions** for the pool's distribution:
   the candidates themselves are not saved — the pool stores the spec and
   generates fresh testers along the chosen direction at validation time.
8. On choice, call `create_pool` WITHOUT `preview_only`, with the same
   controls, the vibe_prompt extended by the chosen candidate's summary
   (e.g. "... similar in spirit to: <vibeSummary>"), and `name` set to a
   short display name for the pool (propose the chosen candidate's name or
   the user's own phrase; confirm it in the same breath as the direction).
9. Relay the saved pool (name, description — no raw id) and say plainly that
   it starts EMPTY: members are spun off from the pool's distribution at
   validation time, one fresh tester per run. Close with:
   `/archetype:validation "<goal>" url=<...> pool="<name>"`.
   If the tool reports the pool was saved but the rename failed (it carries
   an auto-generated `Pool_<hex>` name), relay that verbatim — the pool is
   fully usable.

## Low-resistance shortcut

If the user already gave a rich description (or says "just make it"), offer
to skip the remaining questions AND the preview round: one confirmation,
then save directly from their description. The full questionnaire + preview
flow is for when they want guidance, never a gate.

## Boundaries

- Only show pools/ids the tools actually returned — never invent ids.
- One SAVE per flow: `create_pool` without `preview_only` at most once,
  after the user confirmed (a direction or a direct save). Previews are free
  to repeat.
- Pool creation is LLM-backed and can take up to a couple of minutes per
  call — tell the user before the first preview call.
