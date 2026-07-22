# Archetype Plugin × Backend — Goal & Acceptance Criteria

Written 2026-07-22. This is the working contract for the current build. Source:
user goal statement (session `/goal`).

## Mission

Let a product builder test their product **as if their customers were sitting
next to them** — immediate, faithful feedback while they build. The Archetype
website/backend is the center server for the pipeline; the Claude Code plugin
is the **actor** that drives Chrome (via Claude-in-Chrome) on the target
webpage according to pipeline output.

## The two deliverables

### 1. Plugin (`Archetype_Plugins/`, this repo)

- Connects to the Archetype backend (center server) using the existing Auth0
  device-flow login wizard (MCP elicitation modal — already built).
- Fetches a **persona-enriched instruction set** produced by the backend
  pipeline.
- Uses Claude Code's Claude-in-Chrome ability to act on the user's
  website/product as that persona, per the instruction set.
- When the test finishes: presents results locally inside Claude Code **and**
  sends results back to the backend.

### 2. Backend (`../Archetype_Core/Archetype_Backend/`)

Owns the proprietary pipeline components:

1. **Session-replay ingestion** — read session replay data the customer
   provides (PostHog/rrweb format, see
   `../Archetype_Core/archetype_frontend/docs/posthog_ref.md`). Status: TO BE
   IMPLEMENTED; the real upload path needs frontend collaboration (onboarding
   wizard). For now: accept **dummy replay data** as pipeline input.
2. **Persona generation** — convert the session-replay pool into personas.
   **LLM-based only** for now (no trained model exists).
3. **Instruction-set enrichment** — merge persona + test goal/feature into a
   persona-enriched instruction set handed to the plugin.
4. **Results handling** — receive the plugin's feedback when testing
   finishes and persist to MongoDB (plus whatever telemetry belongs with it).

## Pipeline (end to end)

```
dummy session replay (rrweb/PostHog shape)
      │  ingestion endpoint (new)
      ▼
replay parsing (dummy/minimal for now)
      ▼
persona generation (LLM-based)
      ▼
persona-enriched instruction set
      │  fetched by plugin (auth: device-flow bearer token)
      ▼
plugin actor: Claude-in-Chrome drives the target webpage
      ▼
results/feedback POSTed back to backend
      ▼
MongoDB persistence + local presentation in Claude Code
```

## Acceptance criteria — real E2E, explicitly NO smoke tests

The goal is met only when **all** of the following are demonstrated together,
on this machine, with evidence:

### A. Plugin proves itself in a real Claude Code session

- **A1.** A real inner Claude Code session is launched in tmux with
  `claude --plugin-dir .../Archetype_Plugins` (plus a local
  `ARCHETYPE_BACKEND_URL`).
- **A2.** The plugin is actually used in that session (`/archetype:validation`
  flow), not simulated.
- **A3.** The **wizard renders correctly** — vision-verified (screenshot of the
  elicitation modal / wizard UI).
- **A4.** Claude-in-Chrome **really drives Chrome** — a vision agent verifies
  genuine browser activity on the target page (screenshots of Chrome doing the
  test), not just tool-call logs.
- **A5.** The plugin **sends back correct feedback** to the backend — payload
  verified against what the run actually did.

### B. Backend proves the whole pipeline

- **B1.** With dummy session-replay data as input, the pipeline runs end to
  end: ingestion → parsing → LLM persona generation → instruction set →
  dispatch to plugin → results ingestion.
- **B2.** Every stage is monitored while it runs (backend logs + DB state),
  and the resulting MongoDB documents are inspected and correct (personas,
  runs, results collections).

### C. Verification method

- The outer orchestrator session monitors: the tmux pane of the inner Claude
  Code, the backend process logs, and MongoDB contents.
- A **vision agent** verifies from screenshots: (1) the plugin wizard rendered
  correctly, (2) Chrome was really being driven on the page, (3) the feedback
  shown/sent is the correct one.

## Environment facts (verified so far)

- Plugin auth: Auth0 device flow via `scripts/setup-server.py` MCP server;
  token at `${CLAUDE_PLUGIN_DATA}/auth.json`; backend URL overridable with
  `ARCHETYPE_BACKEND_URL` (default `https://api.syntheticarchetype.com`).
- Backend: Flask app (`Archetype_Backend/app.py`) with existing routes for
  oauth/features/uat/persona/feedback/events; MongoDB + Redis + Celery in the
  stack; notte-based simulation core is the existing (non-plugin) actor.
- Session-replay wire format to imitate for dummy data: rrweb
  `eventWithTime[]` per `posthog_ref.md` (FullSnapshot / IncrementalSnapshot /
  Meta / Custom events, `cv: "2024-10"` inline compression optional — dummy
  data can stay uncompressed).

## Open design questions (to settle in brainstorming before implementation)

1. Dispatch model: does the plugin poll for pending runs, or does the user
   pick a feature and the backend assembles the instruction set on demand?
2. Reuse the existing UAT run lifecycle/collections or introduce a new
   plugin-run type?
3. Instruction-set schema (persona fields included, test steps, success
   criteria, target URL).
4. Results/feedback schema the plugin must POST back.
5. Dummy replay ingestion endpoint shape (upload JSON? seed script?).
6. Which LLM provider/key the backend uses for persona generation, and the
   dummy fallback when no key is present.
7. Target webpage for the E2E run (the Archetype frontend itself? a static
   demo page?).
