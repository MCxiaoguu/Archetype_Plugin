---
name: persona
description: Persona dashboard and questionnaire-driven persona creation. Use for /archetype:persona — lists the user's personas (replay, vibe, custom) with ids usable in validation runs; if none exist (or the user says new), walks them through a short questionnaire, previews candidate personas, and saves the chosen one via the backend.
---

# Persona

You are responding to `/archetype:persona`. Two modes, branched on `$ARGUMENTS`:

- **Empty** → **Dashboard** (below). Offer creation only if the list is empty
  or the user asks.
- **`new`** (or any free text describing a persona) → **Creation flow**. If
  free text was given, treat it as raw material for the vibe prompt and skip
  the questions it already answers.

The `archetype-setup` tools may be deferred; load both persona tools in one
ToolSearch query
(`select:mcp__plugin_archetype_archetype-setup__list_personas,mcp__plugin_archetype_archetype-setup__create_persona`).
Auth is self-healing: the tools log the user in if needed — never pre-call
`login`.

## Dashboard

1. Call `list_personas` (no arguments).
2. Render the result as a table: **personaId · name · source · occupation ·
   story (one line)**. Keep ids verbatim — they are what `persona=<id>` takes.
3. Close with the run hint:
   `/archetype:validation "<goal>" url=<...> persona=<personaId>`.
4. If the tool says there are no personas, relay that plainly and ask ONE
   question: would they like to create one now? If yes → Creation flow.

## Creation flow (questionnaire → preview → save)

Ask these one at a time (skip any the user already answered; keep it
conversational, not a form):

1. **Who are they?** Role/occupation and a phrase of character — e.g.
   "a vibe-coding solo founder", "a skeptical enterprise IT admin".
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
   plain English — no key:value dumps), and call `create_persona` with
   `preview_only: true`, `preview_count: 2`, plus the mapped `age_range`,
   `skills_range`, `occupation`, and `product_description`.
7. Present both candidates side by side (name, vibe, story, need) and ask
   which direction fits — or neither (revise the prompt and re-preview).
   Be explicit that these are **directions**: the saved persona is regenerated
   along the chosen direction, not stored verbatim.
8. On choice, call `create_persona` WITHOUT `preview_only`, with the same
   controls and the vibe_prompt extended by the chosen candidate's summary
   (e.g. "... similar in spirit to: <vibeSummary>").
9. Relay the saved persona (name, id, story, need) and close with:
   `/archetype:validation "<goal>" url=<...> persona=<personaId>`.

## Boundaries

- Only show personas/ids the tools actually returned — never invent ids.
- One SAVE per flow: `create_persona` without `preview_only` exactly once,
  after the user chose a direction. Previews are free to repeat.
- Persona generation is LLM-backed and can take up to a couple of minutes per
  call — tell the user before the first preview call.
