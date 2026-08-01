# /archetype:persona — dashboard + questionnaire creation — design

Date: 2026-08-01
Status: approved (build all; tmux-test all parts; finish with plugin-tests-itself run)

## Problem

Personas are central to Archetype, but the plugin has no persona surface: you
cannot see which personas exist, cannot create one, and validation runs are
hardwired to the replay-derived persona (`ensure_replay_persona`), ignoring
vibe/custom personas entirely.

## Design

### 1. Plugin MCP tools (`scripts/setup-server.py`, both via `authed_call`)

- **`list_personas`** → `GET /api/persona`. Render each persona: name ·
  source (replay/vibe/custom) · occupation/age (from demographics) · one-line
  story · `personaId`. Empty list renders "no personas yet" + creation hint.
- **`create_persona`** → `POST /api/persona/vibe` (mode `vibe`). Args
  (snake_case): `vibe_prompt` (required), `age_range` [lo,hi],
  `skills_range` [lo,hi], `occupation`, `education`, `product_description`,
  `preview_only` (bool), `preview_count` (≤5, default 2). Preview renders the
  candidate personas; final create renders the saved persona + `personaId` +
  "use it: /archetype:validation ... persona=<id>".

### 2. Persona skill (`skills/persona/SKILL.md`) → `/archetype:persona`

- No args → `list_personas`. Personas → dashboard table + run hint. None →
  offer to create.
- `new` (or user accepts) → questionnaire, one structured question at a time:
  who (role/occupation) · age range · tech-savviness (→ `skills_range`) ·
  what they care about / attitude · product context (prefill from session).
  Compose an NL `vibe_prompt` from the answers (fields stay natural language).
- Preview flow: `create_persona(preview_only=true, preview_count=2)` → show
  both → user picks a direction → final `create_persona` with the chosen
  preview's summary folded into the prompt. Surface honestly that the final
  persona is regenerated in that direction, not the preview verbatim.

### 3. Backend: optional `personaId` on run creation (Archetype_Backend dev)

- `POST /api/plugin/runs` body gains optional `personaId`.
- `create_run(..., persona_id)`: when given, load the persona scoped to the
  authenticated user (`user_personas` by `user_persona_id` + `user_id`,
  not-deleted). Found → use it (skip `ensure_replay_persona`); missing →
  `PluginRunNotFound` with an NL message listing the remedy
  (/archetype:persona to see ids). Downstream (scenarios, seed card, brief,
  persona_pool) consumes the loaded doc unchanged.
- Plugin `start_run` gains optional `persona_id` → maps to `personaId`.
  `validation` / `validate-feature` skills parse a `persona=<id>` token.
  Run log records `persona_id`.

### 4. Testing

- Plugin stdio harness: stub `GET /api/persona`, `POST /api/persona/vibe`
  (preview + create shapes); cases: dashboard render, empty list, preview,
  create, `persona_id` → `personaId` mapping in start_run, self-heal reuse.
- Backend pytest: `create_run` with persona_id (found / not found /
  other-user), route passthrough.
- Live tmux: dashboard, interactive questionnaire (operator answers as a
  vibe-coder founder), persona-driven validation run against the demo app —
  the plugin testing itself end to end.

### 5. Ship

Plugin v0.3.0 → push. Backend → push dev, EC2 deploy workflow, PR #14 rides
along.

## Out of scope

- Persona editing/deletion from the plugin.
- Manual radar-config creation mode (vibe mode only).
- Pool management.
