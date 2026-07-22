# Plugin ↔ Backend Pipeline Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Archetype actor pipeline end to end: rrweb session-replay ingestion → LLM persona → persona-enriched instruction set served to the Claude Code plugin → Claude-in-Chrome test run → results ingested into MongoDB — proven by a real (non-smoke) E2E run.

**Architecture:** Backend gains a `/api/plugin` blueprint whose synchronous run-creation endpoint self-assembles the pipeline (auto-seed dummy rrweb fixtures → parse → cached LLM persona → instruction set) and whose results endpoint writes through the existing `log_result`/analytics/finalize machinery into `Archetype_Test.*`. The plugin's stdio MCP server grows from 1 tool (`login`) to 5, keeping all HTTP + Bearer-token handling in Python; skills orchestrate Claude driving Chrome as the persona. A static demo product ("Lumina Notes") with planted UX flaws is the test target.

**Tech Stack:** Flask 3 (Python 3.13, `uv`), MongoDB (Atlas), Gemini via existing `LLMClient`, stdlib-only MCP stdio server (Python 3.10+), Claude Code plugin (skills/agents/hooks), tmux E2E harness.

**Authoritative spec:** `docs/superpowers/specs/2026-07-22-plugin-backend-pipeline-design.md` (same repo). Section references (§) below point there. Subsystem maps with file:line references: `docs/notes/*.md`.

**Repos & conventions:**
- Backend work in `/Users/hanyanggu/Personal_Files/Coding/Archetype_all/Archetype_Core/Archetype_Backend` (`BE` below). Run tests from `BE` with `uv run python -m pytest _tests/<file> -v` (NEVER system python — Atlas TLS breaks). Tests hit real services (repo convention, no mocks): Mongo Atlas + Gemini keys already in `BE/.env` (auto-loaded via dotenv).
- Plugin work in `/Users/hanyanggu/Personal_Files/Coding/Archetype_all/Archetype_Plugins` (`PL` below). Stdlib-only Python for the MCP server.
- Both repos commit to `main`, small commits per task, message style: short imperative summary (see `git log`), trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Endpoint tests use the dev auth bypass: env `DEV_MODE=1`, `FLASK_ENV` unset, identity via `X-User-Id` header (`infrastructure/auth/jwt_validator.py:25-43`).
- Test user ids in Mongo-touching tests: prefix `plugintest-` + uuid, so cleanup is targeted; each test cleans up its own docs in teardown (delete by user_id).
- **Reuse-first principle (applies to every task):** before writing a new module or function, READ the existing module that owns the responsibility and extend it in place — new files only for genuinely new domains (replay parsing is one; persona persistence is not). When extending a shared function, add opt-in parameters with defaults that preserve existing-caller behavior exactly. If you find yourself re-implementing something the backend already does (doc creation, LLM call plumbing, Mongo helpers), stop and wire the existing one instead.

**Canonical DOM/URL vocabulary** (shared by fixtures ⇄ demo app ⇄ parser tests — single source of truth, do not improvise):
- Base URL `http://localhost:8321/`; SPA-ish pageview hrefs: `/`, `/#plans`, `/#signup`.
- Element ids: `nav-plans` (a, text "Plans & More"), `cta-trial` (button, text "Start free trial"), `signup-form` (form), `signup-name`, `signup-email`, `signup-password` (inputs), `signup-submit` (button, text "Create account").

---

## Chunk 1: Backend — rrweb parser + dummy fixtures

### Task 1.1: Fixture generator + three dummy rrweb sessions

**Files:**
- Create: `BE/data/dummy_replays/generate_fixtures.py`
- Create (generated, committed): `BE/data/dummy_replays/session_01_rageclick.json`, `session_02_pricing_hunt.json`, `session_03_signup_abandon.json`

The three sessions tell one coherent story (§3.5): a price-sensitive skimmer who (1) rage-clicks the sluggish `cta-trial`, (2) hunts pricing behind `nav-plans` and backtracks, (3) starts signup, hits the form wipe, hesitates ≥8 s, abandons. Fixture = JSON object `{"sessionId": "<name>", "events": [<rrweb eventWithTime>...]}` — uncompressed, no `cv` markers.

- [ ] **Step 1: Write the generator script**

`generate_fixtures.py` is deterministic (fixed base timestamp `1750000000000`, no randomness) and writes the three JSONs next to itself. Shared helpers build the event skeleton; each session function composes events. Core shapes (per `posthog_ref.md` §4, node ids fixed):

```python
#!/usr/bin/env python3
"""Deterministic dummy rrweb sessions for the plugin pipeline (spec §3.5)."""
import json
from pathlib import Path

T0 = 1750000000000
OUT = Path(__file__).parent

# Fixed node-id map for the demo-app DOM (shared vocabulary, plan header)
NODE = {"html": 2, "body": 4, "nav": 5, "nav-plans": 6, "hero": 8,
        "cta-trial": 9, "plans": 11, "signup-form": 13, "signup-name": 14,
        "signup-email": 15, "signup-password": 16, "signup-submit": 17}

def meta(t, href): return {"type": 4, "data": {"href": href, "width": 1440, "height": 900}, "timestamp": t}

def full_snapshot(t):
    def el(tag, nid, attrs=None, children=None, text=None):
        node = {"type": 2, "tagName": tag, "attributes": attrs or {}, "childNodes": children or [], "id": nid}
        if text is not None:
            node["childNodes"] = [{"type": 3, "textContent": text, "id": nid * 100}]
        return node
    body = el("body", NODE["body"], children=[
        el("nav", NODE["nav"], children=[el("a", NODE["nav-plans"], {"id": "nav-plans", "href": "#plans"}, text="Plans & More")]),
        el("section", NODE["hero"], children=[el("button", NODE["cta-trial"], {"id": "cta-trial"}, text="Start free trial")]),
        el("section", NODE["plans"], {"id": "plans"}),
        el("form", NODE["signup-form"], {"id": "signup-form"}, children=[
            el("input", NODE["signup-name"], {"id": "signup-name"}),
            el("input", NODE["signup-email"], {"id": "signup-email"}),
            el("input", NODE["signup-password"], {"id": "signup-password", "type": "password"}),
            el("button", NODE["signup-submit"], {"id": "signup-submit"}, text="Create account")])])
    doc = {"type": 0, "childNodes": [el("html", NODE["html"], children=[body])], "id": 1}
    return {"type": 2, "data": {"node": doc, "initialOffset": {"top": 0, "left": 0}}, "timestamp": t}

def click(t, nid): return {"type": 3, "data": {"source": 2, "type": 2, "id": nid, "x": 100, "y": 100}, "timestamp": t}
def moves(t, nid): return {"type": 3, "data": {"source": 1, "positions": [{"x": 90, "y": 90, "id": nid, "timeOffset": -50}]}, "timestamp": t}
def scroll(t, y): return {"type": 3, "data": {"source": 3, "id": 1, "x": 0, "y": y}, "timestamp": t}
def input_ev(t, nid): return {"type": 3, "data": {"source": 5, "id": nid, "text": "*"}, "timestamp": t}
def pageview(t, href): return {"type": 5, "data": {"tag": "$pageview", "payload": {"href": href}}, "timestamp": t}
def console_error(t, msg):
    return {"type": 6, "data": {"plugin": "rrweb/console@1", "payload": {"level": "error", "trace": [], "payload": [json.dumps(msg)]}}, "timestamp": t}

def filler(t_start, t_end, nid):
    """Deterministic mousemove filler every 1000 ms from t_start.

    Includes t_end only when (t_end - t_start) % 1000 == 0 — true for all
    session-end calls below (durationMs depends on it), not for mid-gaps.
    """
    return [moves(t, nid) for t in range(t_start, t_end + 1, 1000)]
```

Hrefs in fixtures are ABSOLUTE (`http://localhost:8321/`, `http://localhost:8321/#plans`,
`http://localhost:8321/#signup`) — real rrweb carries `location.href`. Every session ends
with its last filler mousemove exactly at the session-end timestamp (this pins
`durationMs` = last ts − first ts). Filler brings each session to ~20–45 events
(spec §3.5 fidelity); filler mousemoves are NON-interactions and must not affect
rage/hesitation detection.

Session compositions (exact, all timestamps pinned; parser tests assert these):
- `session_01_rageclick`: meta(`/`) t0 + full_snapshot t0+100 + 4× `click(cta-trial)` at t+3000/3300/3600/3900 (900 ms span) + scroll(600) t+4500 + `filler(t+5000, t+27000, NODE["hero"])`. Last event t+27000 → durationMs 27000.
- `session_02_pricing_hunt`: meta(`/`) t0 + snapshot t0+100 + click(`nav-plans`) t+4500 (below the 5 s hesitation threshold — only non-interactions precede it) + pageview(`/#plans`) t+4600 + scroll(400) t+8000 + pageview(`/`) t+14000 + pageview(`/#plans`) t+20000 (the backtrack the test asserts: return from `/` to the earlier `/#plans`) + `filler(t+5000, t+32000, NODE["plans"])`. Last event t+32000.
- `session_03_signup_abandon`: meta(`/`) t0 + snapshot t0+100 + pageview(`/#signup`) t+2000 + input_ev(name) t+4000 + input_ev(email) t+5500 + input_ev(password) t+7000 + click(`signup-submit`) t+9000 + console_error("Form validation failed: fields cleared") t+9100 + `filler(t+9200, t+17000, NODE["signup-form"])` + click(`signup-submit`) t+17500 (gap since last INTERACTION — the t+9000 click — is 8500 ms ≥ 5000 → hesitation) + `filler(t+18000, t+21000, NODE["signup-form"])`. Last event t+21000.

- [ ] **Step 2: Run the generator, inspect output**

Run: `cd BE && uv run python data/dummy_replays/generate_fixtures.py && python3 -c "import json;d=json.load(open('data/dummy_replays/session_01_rageclick.json'));print(d['sessionId'], len(d['events']))"`
Expected: `session_01_rageclick <N≥25>` (filler included). Determinism check that bites on first run: `shasum data/dummy_replays/session_*.json`, re-run the generator, `shasum` again — hashes identical.

- [ ] **Step 3: Commit** (`BE` repo)

```bash
git add data/dummy_replays/ && git commit -m "add deterministic dummy rrweb replay fixtures + generator"
```

### Task 1.2: rrweb parser (TDD)

**Files:**
- Create: `BE/services/replay/__init__.py` (empty), `BE/services/replay/parser.py`
- Test: `BE/_tests/test_replay_parser.py`

Parser is **pure** (events in, dict out, no I/O) — spec §3.2 defines the output schema (`behavior_summary`, camelCase keys, `parserVersion: 1`).

- [ ] **Step 1: Write failing tests against the fixtures**

```python
import json
from pathlib import Path
import pytest
from services.replay.parser import parse_session

FIX = Path(__file__).parent.parent / "data" / "dummy_replays"

def load(name):
    return json.loads((FIX / f"{name}.json").read_text())["events"]

def test_rageclick_detected():
    s = parse_session(load("session_01_rageclick"))
    assert s["parserVersion"] == 1
    assert s["durationMs"] == 27000
    assert s["pages"][0]["href"].endswith("/")
    rc = s["friction"]["rageClicks"]
    assert len(rc) == 1 and rc[0]["targetId"] == "cta-trial" and rc[0]["count"] == 4
    assert any(c["id"] == "cta-trial" and c["text"] == "Start free trial" for c in s["clicks"])

def test_backtrack_detected():
    s = parse_session(load("session_02_pricing_hunt"))
    hrefs = [p["href"] for p in s["pages"]]
    assert "/#plans" in hrefs[1]  # journey recorded in order
    assert {"from": "/", "to": "/#plans"} in [
        {"from": b["from"].replace("http://localhost:8321", ""), "to": b["to"].replace("http://localhost:8321", "")}
        for b in s["friction"]["backtracks"]]

def test_signup_abandon_hesitation_and_error():
    s = parse_session(load("session_03_signup_abandon"))
    assert s["inputs"]["count"] == 3
    hes = s["friction"]["hesitations"]
    assert any(h["gapMs"] >= 5000 and h["beforeClickOn"] == "signup-submit" for h in hes)
    assert any("Form validation failed" in e for e in s["consoleErrors"])

def test_cv_compressed_event_inflates():
    import gzip
    raw = json.dumps({"source": 3, "id": 1, "x": 0, "y": 100})
    ev = {"type": 3, "cv": "2024-10", "data": gzip.compress(raw.encode()).decode("latin-1"), "timestamp": 1750000001000}
    meta = {"type": 4, "data": {"href": "http://x/", "width": 1, "height": 1}, "timestamp": 1750000000000}
    s = parse_session([meta, ev])
    assert s["scrolls"] == 1
```

- [ ] **Step 2: Run tests, verify failure**

Run: `cd BE && uv run python -m pytest _tests/test_replay_parser.py -v`
Expected: FAIL — `ModuleNotFoundError: services.replay`

- [ ] **Step 3: Implement `parser.py`**

Single entry `parse_session(events: list[dict]) -> dict`. Implementation outline (complete the obvious plumbing):

```python
"""rrweb → behavior_summary. Spec §3.2; format ref: archetype_frontend/docs/posthog_ref.md."""
import gzip, json

PARSER_VERSION = 1
RAGE_WINDOW_MS, RAGE_MIN = 1000, 3
HESITATION_MS = 5000

def _inflate(v):  # cv:"2024-10" fields are gzip latin-1 strings
    return json.loads(gzip.decompress(v.encode("latin-1")))

def _norm(events):
    out = []
    for e in sorted(events, key=lambda x: x.get("timestamp", 0)):
        if e.get("cv") == "2024-10":
            e = dict(e)
            if isinstance(e.get("data"), str):
                e["data"] = _inflate(e["data"])
            else:  # Mutation: per-key compressed
                e["data"] = {k: (_inflate(v) if isinstance(v, str) and k in ("texts", "attributes", "removes", "adds") else v)
                             for k, v in e["data"].items()}
        out.append(e)
    return out
```

Then: build mirror from FullSnapshot (walk `node` tree → `{id: {"tag", "attrs", "text", "parent"}}`, text from child type-3 nodes); apply Mutation adds/removes/attributes in order; fold IncrementalSnapshot sources: 1→mouse travel counter, 2(type 2)→clicks list `{t: ts-firstTs, tag, text, id: attrs.get("id"), page: current_href}`, 3→`scrolls += 1`, 5→inputs (count + field ids); Meta(4)+Custom `$pageview`(5) drive `pages` journey with `dwellMs` computed from next-nav or session end; Plugin(6) `rrweb/console@1` level error → `consoleErrors` (join payload strings). Friction: rage = clicks per node id within a `RAGE_WINDOW_MS` sliding window, ≥`RAGE_MIN`; **coalesce consecutive qualifying clicks on the same node into ONE rage event** reporting total `count` + total span as `windowMs` (a naive per-window emit yields duplicates and fails the `len(rc) == 1` assertion). Hesitation = gap between the last **interaction** event (MouseInteraction source 2 or Input source 5; session start if none) and a click, strictly `> HESITATION_MS` → `{"beforeClickOn": id, "gapMs": gap}` — mousemoves/scrolls inside the gap do NOT reset it (spec §3.2). Backtrack = pageview href seen earlier in journey → `{"from": prev_href, "to": href}` recorded on the *return* transition (test 2 asserts from `/` to `/#plans` for the t+20000 revisit). `mouseTravel`: "low" <20 positions, "medium" <100, else "high". `durationMs` = last ts − first ts. `viewport` from Meta.

- [ ] **Step 4: Run tests until green**

Run: `cd BE && uv run python -m pytest _tests/test_replay_parser.py -v`
Expected: 4 passed

- [ ] **Step 5: Commit**

```bash
git add services/replay/ _tests/test_replay_parser.py && git commit -m "add rrweb behavior parser for replay pipeline"
```

## Chunk 2: Backend — ingestion, persona, run service, routes

### Task 2.1: Replay ingestion service + auto-seed (TDD, Mongo)

**Files:**
- Create: `BE/services/replay/ingest.py`, `BE/services/replay/fixtures.py`
- Test: `BE/_tests/test_replay_ingest.py`

- [ ] **Step 1: Failing tests** — `ingest_sessions(user_id, sessions, source)` stores docs in DB `Replay`, coll `sessions` with parsed `behavior_summary` (§3.4 doc shape; `replay_session_id = f"rs-{uuid4().hex[:12]}"`), rejects a session whose `json.dumps(events)` exceeds 8 MB (`ValueError`); `pool_for_user(user_id)` returns live docs; `pool_hash(docs)` = sha256 over sorted `(replay_session_id, ingested_at)` pairs, stable across call order; `autoseed_if_empty(user_id)` ingests the three fixtures once (`source="dummy-autoseed"`) and is a no-op when the pool is non-empty. Use `infrastructure.database` helpers (`insert.py`/`retrieval.py`) like `services/features.py` does. Teardown deletes the test user's docs.

Run: `cd BE && uv run python -m pytest _tests/test_replay_ingest.py -v` → FAIL (module missing)

- [ ] **Step 2: Implement** `ingest.py` (store/query/hash) + `fixtures.py` (`FIXTURE_DIR = Path(__file__).parents[2] / "data" / "dummy_replays"`; loads the three JSONs, calls `ingest_sessions`). Parse at ingest via `parser.parse_session`; store `event_count`, `duration_ms` denormalized.

- [ ] **Step 3: Green + commit** — `git add services/replay/ _tests/test_replay_ingest.py && git commit -m "replay ingestion service with auto-seed fixtures"`

### Task 2.2: Replay-derived persona functions (TDD, Mongo + real Gemini)

**Files:**
- Modify: `BE/services/persona_service.py` (the canonical persona service — extend in place, do NOT create a parallel service)
- Test: `BE/_tests/test_replay_persona.py`

- [ ] **Step 1: Failing tests** — (a) `build_digest(pool_docs) -> str`: pure; contains journey lines, rage-click and hesitation mentions, capped 8000 chars; (b) `ensure_replay_persona(user_id, target_url)`: uses `gemini_client` conftest fixture pattern (skips without `GEMINI_API_KEY`); first call generates + persists to `Persona.user_personas` with `source="replay"`, `replay_pool_hash`, `replay_session_ids`, and full generator fields (`generated_episodes` non-empty — asserts the §3.3 persistence-gap fix); second call returns the cached doc without regeneration (assert same `user_persona_id`; guard: monkeypatch-free — assert wall time of 2nd call < 5 s, far below a Gemini round-trip but tolerant of Atlas latency); after ingesting one more fixture session (pool hash changes), a third call regenerates (different `user_persona_id`). Teardown deletes persona + replay docs for the test user.

Run: `cd BE && uv run python -m pytest _tests/test_replay_persona.py -v` → FAIL

- [ ] **Step 2: Implement** (both in `services/persona_service.py`). `ensure_replay_persona`: pool = `autoseed_if_empty` + `pool_for_user` → hash → lookup `user_personas` where `{user_id, source: "replay", replay_pool_hash: hash, isDeleted: {"$ne": True}}` → on miss call `persona.generator.generate_persona(user_description=digest, need=_infer_need(digest), start_url=target_url)` (keyword-only, §3.3; `_infer_need` returns the fallback string `"evaluate whether this product fits my workflow"` — YAGNI: no extra LLM call) → persist via `_persist_persona_doc`, **extended in place** with a new opt-in parameter `include_generator_fields: bool = False` (default preserves every existing caller byte-for-byte) that, when True, also persists `generated_episodes`, `generated_chunks`, `self_description`, `browsing_habits`, `starting_mood`, `start_url` — this fixes the known field-dropping gap at its source instead of adding a parallel insert path. Pass the provenance fields (`source="replay"`, `replay_pool_hash`, `replay_session_ids`) through `_persist_persona_doc`'s existing extras mechanism (or add them to the doc dict it builds when the new flag is on).

- [ ] **Step 3: Green + regression guard + commit** — also run `uv run python -m pytest _tests/test_persona_service.py -v` (existing suite must stay green after the `_persist_persona_doc` extension). `git commit -m "replay-derived personas in persona_service (LLM, pool-hash cached)"`

### Task 2.3: Run assembly + result ingestion service (TDD, Mongo + Gemini)

**Files:**
- Create: `BE/services/plugin_run_service.py`
- Test: `BE/_tests/test_plugin_run_service.py`

- [ ] **Step 1: Failing tests**

```python
def test_create_run_full_pipeline(gemini_client):  # tier1+2: real Gemini + Atlas
    uid = f"plugintest-{uuid4().hex[:8]}"
    out = create_run(uid, goal="test the signup flow", feature_id=None, url="http://localhost:8321")
    assert out["runId"] and out["sessionId"].startswith("plugin-")
    assert "you" in out["brief"].lower() or len(out["brief"]) > 100   # NL briefing present
    assert out["persona"]["personaCard"] and out["persona"]["name"]
    assert 2 <= len(out["instructions"]["scenarios"]) <= 4
    for sc in out["instructions"]["scenarios"]:
        assert sc["id"] and sc["steps"] and sc["expectedResult"]
    from infrastructure.database import find_one   # same helpers services/features.py uses
    test_doc = find_one("Archetype_Test", "test", {"test_id": out["runId"]})
    assert test_doc["status"] == "running"
    assert test_doc["test_meta"]["validation_type"] == "plugin"

def test_scenario_fallback_without_llm(monkeypatch):
    monkeypatch.setattr("services.plugin_run_service._llm_scenarios", lambda *a, **k: (_ for _ in ()).throw(RuntimeError))
    scs = build_scenarios(goal="check pricing clarity", feature=None, persona_hint="impatient")
    assert len(scs) >= 2 and all(s["steps"] for s in scs)  # deterministic template

def test_ingest_results_writes_session_log_and_finalizes(...):
    # create_run (cached persona from prior test user? No — same uid as test 1 via module fixture),
    # then ingest_results(uid, run_id, payload_from_spec_§2_2) with 2 steps + feedback
    # asserts: session_log doc exists w/ steps len 2 + narration fields; test doc status=="completed",
    # progress==100, results.plugin_feedback.verdict=="mixed"; feedback docs inserted;
    # second ingest → PluginRunConflict raised (409 case); status="aborted" maps to test "failed".
```

Run: `cd BE && uv run python -m pytest _tests/test_plugin_run_service.py -v` → FAIL

- [ ] **Step 2: Implement `plugin_run_service.py`**

Public API + exceptions:

```python
class PluginRunError(Exception): ...              # → 400
class PluginRunNotFound(PluginRunError): ...      # → 404 (unknown run_id or not owned by user)
class PluginRunConflict(PluginRunError): ...      # → 409
class PersonaGenerationFailed(PluginRunError): ...  # → 502

def create_run(user_id, goal, feature_id, url) -> dict            # spec §2.1 response
def ingest_results(user_id, run_id, payload) -> dict              # spec §2.2 response
def get_run(user_id, run_id) -> dict                              # spec §2.3 response; analyticsReady = Archetype_Test.session_extraction doc exists for the session
```

`create_run`: validate (`goal or feature_id`, `url` required); resolve feature via `services.features.get_feature` when given (goal fallback = feature fields); `ensure_replay_persona`; insert test doc mirroring `routes_session.py:328-365` shape with `test_meta={"validation_type": "plugin", "actor": "claude-plugin", "url": url, "goal": goal, "feature_info": …, "persona_pool": [persona_id], "plugin_session_id": f"plugin-{uuid4().hex[:12]}"}`, `total_sessions=1`, `status="running"`; scenarios via `_llm_scenarios` (one `LLMClient(provider="google")` JSON call patterned on `services/bootstrap/uat_bootstrap.py`, prompt includes persona need/traits + goal + planted-flaw-agnostic instructions) wrapped in try/except → `_template_scenarios` fallback (generic: explore landing, complete primary goal, report friction); persona card via `contract_from_persona` → `render_seed_card`; `brief` from an f-string template weaving persona name/need + goal + reporting expectations (server-authored NL, §2.1).

`ingest_results`: ownership check (`user_id` on test doc → `PluginRunNotFound` on miss) → `sessionId` match (400) → status guard (completed → `PluginRunConflict`; failed → allowed retry: **delete the previous `session_log` doc for this `session_id` first** — `start_session_log` upserts with `$set` and would otherwise merge old steps) → screenshot budget enforcement (≤6, each ≤1 MB after b64-decode len estimate; drop extras, note in response `message`).

Exact `simulation_core/log_result.py` signatures (keyword-only after `session_id`; verified against source — do NOT improvise):

```python
start_session_log(session_id, persona_id=persona_id, url=url, goal=goal,
                  headless=False, record_video=False, video_format="none",
                  extra={"test_id": test_id})          # test_id travels via extra
log_step(session_id, seq=step["seq"], event_type="action",
         action_text=step["actionText"], narration=step["narration"],
         observation_page_type=step["observationPageType"], url=step.get("url"),
         error=step.get("error"), screenshot=step.get("screenshotB64"),
         extra={"success": step["success"], "scenario_id": step.get("scenarioId")})
finalize_session_log(session_id, status="success" if completed else "failed",
                     final_observation=feedback["summary"],
                     extra={"verdict": feedback["verdict"]})   # no `outcome` kwarg exists
```

Then: write `results.plugin_feedback` + `completed_at` + `status` (`completed` | `failed`; `aborted` → `failed` with `error: "aborted by actor"`) + `progress:100` on the test doc → insert one `Archetype_Test.feedback` doc per finding (`type: "plugin_finding"`) → best-effort `try: run_post_session_analytics(session_id)` except log → response with NL `message`.

- [ ] **Step 3: Green + commit** — `git commit -m "plugin run assembly + result ingestion services"`

### Task 2.4: HTTP blueprint + endpoint tests

**Files:**
- Create: `BE/api/routes_plugin.py`
- Modify: `BE/app.py` (add the **3-tuple** `("api.routes_plugin", "plugin_bp", "/api/plugin")` to the blueprint list at `app.py:38-53` — the loop unpacks `(module_path, bp_var, prefix)`; name the Blueprint variable `plugin_bp` in `routes_plugin.py` to match)
- Test: `BE/_tests/test_plugin_endpoints.py`

- [ ] **Step 1: Failing endpoint tests** — Flask test client from `create_app()` with `monkeypatch.setenv("DEV_MODE", "1")` + `monkeypatch.delenv("FLASK_ENV", raising=False)`; identity via `X-User-Id`. Cases: `POST /api/plugin/runs` 201 happy path (slow — reuses the same test-scoped uid so the persona generated in Task 2.3's collection run is NOT reused: use a fresh uid; accept the ~60–90 s first-run cost, mark `@pytest.mark.tier2`); 400 without url; `POST /api/plugin/runs/<id>/results` 200 then 409; `GET /api/plugin/runs/<id>` 200 with `analyticsReady` bool; `POST /api/plugin/replay/sessions` 200 `{ingested: 1, poolSize: ...}` with one fixture session, 400 on >8 MB session; `GET /api/plugin/runs/<unknown-id>` and results-POST to another user's run → 404; all four routes 401 when `DEV_MODE` unset and no token (set `DEV_MODE=0`, `AUTH0_DOMAIN` to the real value from env so bypass is off).

Run: `cd BE && uv run python -m pytest _tests/test_plugin_endpoints.py -v` → FAIL

- [ ] **Step 2: Implement `routes_plugin.py`** — thin: parse/validate JSON, call service, map exceptions (`PluginRunError`→400, `PluginRunNotFound`→404, `PluginRunConflict`→409, `PersonaGenerationFailed`→502 `{error: "persona_generation_failed", message: "<NL: what failed, safe to retry>"}`, unexpected→500). Every error body carries NL `message` (§2.2 LLM-consumer principle). `@require_auth` on all routes; `user_id = request.user_id`.

- [ ] **Step 3: Green + commit; also run the pre-existing suite guard** — `uv run python -m pytest _tests/test_compile.py -v` (import sanity: new blueprint imports cleanly in `create_app`). Commit: `git commit -m "add /api/plugin blueprint: runs, results, replay ingestion"`

## Chunk 3: Plugin — MCP tools, skills, demo app

### Task 3.1: MCP server — 4 new tools (TDD via scripted stdio)

**Files:**
- Modify: `PL/scripts/setup-server.py`
- Test: `PL/scripts/test_setup_server.py` (plain-python test runner, stdlib only — plugin repo has no pytest; run with `python3 scripts/test_setup_server.py`)

- [ ] **Step 1: Write the failing stdio test harness** — spawns the server as a subprocess with env `CLAUDE_PLUGIN_DATA=<tmpdir>` and `ARCHETYPE_BACKEND_URL=http://127.0.0.1:<port>` pointing at a stdlib `http.server` stub that **records method, path, headers, and parsed JSON body of every request** and replays canned §2.1/§2.2 JSON; drives JSON-RPC: `initialize` → `tools/list` (asserts 5 tools: `login`, `start_run`, `report_result`, `get_run`, `list_features`) → `tools/call start_run {goal, url}` with a pre-written `auth.json` in tmpdir (asserts: request carried `Authorization: Bearer`; **recorded body is camelCase per §2.1: `{"goal", "url"}` and `featureId` when given — no snake_case keys**; tool text contains the persona card AND the `brief` NL text AND scenario steps) → `tools/call start_run` with no auth.json (asserts `isError` + "log in" guidance) → `tools/call report_result` happy (asserts **recorded body has `sessionId`, `durationSeconds`, and step keys `actionText`/`observationPageType` — the snake→camel mapping is the drift point this harness pins**) + 409 replay (asserts NL message surfaced) + a canned 401 reply (asserts tool text appends "Run `/archetype:validation` to log in.") → `get_run`, `list_features` (GET with Bearer; canned features stub reply: `{"ok": true, "features": [{"_id": "665f...", "title": "Signup", "updatedAt": "2026-07-01T00:00:00Z"}]}` — the `_id` string is what `validate-feature` passes as `feature_id`).

Run: `python3 scripts/test_setup_server.py` → FAIL (tools missing)

- [ ] **Step 2: Implement.** Additions to `setup-server.py`: `backend_get(path, auth_token)` sibling of `backend_post`; `load_token()` (read `${CLAUDE_PLUGIN_DATA}/auth.json`, None-safe); `require_token()` → error text "Not connected. Run /archetype:validation to log in." Tool schemas:

```python
START_RUN_SCHEMA = {"type": "object", "properties": {
    "goal": {"type": "string", "description": "What to test, in plain language"},
    "feature_id": {"type": "string"},
    "url": {"type": "string", "description": "URL of the product under test"}},
    "required": ["url"]}
REPORT_RESULT_SCHEMA = {"type": "object", "properties": {
    "run_id": {"type": "string"}, "session_id": {"type": "string"},
    "status": {"type": "string", "enum": ["completed", "failed", "aborted"]},
    "duration_seconds": {"type": "number"},
    "steps": {"type": "array", "items": {"type": "object"}},
    "feedback": {"type": "object"}},
    "required": ["run_id", "session_id", "status", "steps", "feedback"]}
GET_RUN_SCHEMA = {"type": "object", "properties": {"run_id": {"type": "string"}}, "required": ["run_id"]}
LIST_FEATURES_SCHEMA = {"type": "object", "properties": {"query": {"type": "string"}}, "required": []}
```

Handlers: refactor `handle()`'s single-tool dispatch into a name → `(schema, handler)` registry consumed by both `tools/list` and `tools/call`. Add a `timeout=` parameter to `backend_post` (default `HTTP_TIMEOUT`); `start_run` POSTs `/api/plugin/runs` (camelCase body: `{"goal", "featureId", "url"}`, `timeout=180`), renders tool text: `brief` → persona card → scenarios (numbered, with steps + expectedResult) → conduct rules → run/session ids + "when finished call report_result with …" **including the §2.2 enums verbatim (finding `category: bug|ux|content|performance|other`, `severity: critical|high|medium|low`, scenario `status: pass|fail|blocked`) so the actor cannot drift the taxonomy**. `report_result` maps snake→camel (`durationSeconds`, steps keys per §2.2), POSTs, renders `message` + summary. `get_run`/`list_features` render compact NL + JSON. Non-2xx: render backend `message`/`error` verbatim with `isError: True`; **special-case 401: append "Run `/archetype:validation` to log in."** (spec §4.1). Bump `SERVER_VERSION = "0.3.0"`, plugin.json `version: "0.1.0"`.

- [ ] **Step 3: Green + commit** (`PL` repo) — `python3 scripts/test_setup_server.py` → `ALL PASS`. `git add scripts/ .claude-plugin/plugin.json && git commit -m "MCP server: start_run/report_result/get_run/list_features tools"`

### Task 3.2: Skills + agent rewrite

**Files:**
- Modify: `PL/skills/validation/SKILL.md`, `PL/skills/validate-feature/SKILL.md`, `PL/skills/list-features/SKILL.md`, `PL/skills/check-run-status/SKILL.md`, `PL/agents/feature-validator.md`, `PL/README.md`, `PL/CLAUDE.md`

- [ ] **Step 1: Rewrite `skills/validation/SKILL.md`** (the core actor loop; complete text, frontmatter `name: validation`, `description` mentioning run + login triggers):

Routing: no `$ARGUMENTS` → call `archetype-setup__login` (unchanged). With `$ARGUMENTS` → run flow:

```markdown
## Run flow
1. Parse $ARGUMENTS: free text = goal; `url=<...>` token overrides target URL.
   If no URL given, ask the user for the product URL — never guess.
2. Call the `start_run` tool (goal, url, feature_id if the user named one).
   On "Not connected" → run login first, then retry once.
3. BECOME THE PERSONA. The tool result contains your mission brief, a
   first-person persona card, scenarios, and conduct rules. Treat them as
   authoritative. Summarize to the user in 3 lines who you are and what you
   will test, then start.
4. Load browser tools (ToolSearch "claude-in-chrome"), get tab context,
   create a NEW tab. Navigate to the target URL.
5. Execute each scenario in order, acting at the persona's patience, skill
   and reading level. Keep a step log as you go — for every meaningful
   action record: seq, scenarioId, actionText (what you did), narration
   (persona-voice inner monologue), url, observationPageType, success.
   Time-box each scenario to ~3 minutes; if blocked, mark the scenario
   blocked and move on. Stay on the target site. Never fabricate steps.
6. When done, call `report_result` with run_id, session_id,
   status ("completed" unless you aborted), duration_seconds, the full
   steps array (camelCase keys: actionText, narration, url,
   observationPageType, success, error), and feedback:
   {verdict, summary, scenarioResults[], findings[] (category/severity/
   description/evidenceStepSeq), personaReaction (first-person quote)}.
7. Render the local report: scenario verdict table, findings by severity,
   the persona quote, run id, and "check later with /archetype:check-run-status <run_id>".
Never simulate the backend or invent run data (same rule as login).
```

- [ ] **Step 2: Rewrite the three thin skills + agent** — ALL FOUR skills get frontmatter with both `name:` and `description:` (the current thin skills are description-only; Step 4's check asserts both). `validate-feature`: resolve feature via `list_features` tool (match `$ARGUMENTS` against titles; ambiguous → ask; pass the feature's `_id` string as `feature_id`), then jump to the validation run flow. `list-features`: call tool, render table (id = `_id`, title, updatedAt), suggest next command. `check-run-status`: `get_run` tool, render status/feedback; drop all `ARCHETYPE_PORTAL_URL`/`ARCHETYPE_API_KEY`/`.mcp.json` references (§4.3). `agents/feature-validator.md`: same contract; tools frontmatter gains the archetype MCP tools (`mcp__plugin_archetype_archetype-setup__start_run` etc. — the fully-qualified names observed in `docs/E2E_HARNESS_NOTES.md`) and notes browser tools are loaded via ToolSearch; keep boundaries (never fabricate, one run per invocation).

- [ ] **Step 3: Update `README.md`** (new tools table, run-flow quickstart, local-backend env) and `CLAUDE.md` (actor contract now implemented — point to spec + plan). Delete the stale empty `PL/skills/setup/` directory if present (§4.3 cleanup).

- [ ] **Step 4: Manual load check + commit** — from `$HOME`: `claude --plugin-dir <PL> -p '/plugin' --max-turns 1` is NOT sufficient to validate skills; instead verify frontmatter parses: `python3 - <<'EOF'` reading each SKILL.md asserting `---` fences + `name:`/`description:` lines `EOF`. Commit: `git commit -m "rewrite skills/agent to real /api/plugin contract"`

### Task 3.3: Demo product "Lumina Notes"

**Files:**
- Create: `PL/demo-app/index.html`, `PL/demo-app/app.js`, `PL/demo-app/style.css`, `PL/demo-app/serve.sh`

- [ ] **Step 1: Build the page.** Structure per the canonical vocabulary (plan header) — nav (`✦ Lumina Notes`, links Features / **Plans & More** (`#nav-plans`, href `#plans`) / Sign in), hero (h1 "Your second brain, beautifully organized", `#cta-trial` button), features ×3, section `id="plans"` (pricing Free/$12 Pro/$29 Team with small-print "billed annually" under each price), section `id="signup"` **wrapping** the `#signup-form` (so `location.hash = '#signup'` scrolls to it; the form's own id stays `signup-form`) with inputs `#signup-name/email/password` + `#signup-submit`. Define `showBanner(text)`: a fixed-position banner div at top, text set from the param, auto-hides after 4 s. Indigo `#4f46e5` header band, product name 28px+ (vision-verification anchor). Planted flaws in `app.js` (deterministic):

```js
// Flaw 1: sluggish CTA — 900ms dead delay, no visual feedback
document.getElementById('cta-trial').addEventListener('click', () => {
  setTimeout(() => { location.hash = '#signup'; pushPageview('/#signup'); }, 900);
});
// Flaw 2 is structural: pricing lives only behind the ambiguous "Plans & More" label.
// Flaw 3: validation wipes the form
document.getElementById('signup-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const email = document.getElementById('signup-email').value;
  if (!email.includes('@') || document.getElementById('signup-password').value.length < 8) {
    console.error('Form validation failed: fields cleared');
    e.target.reset();                       // ← the flaw
    showBanner('Something went wrong. Please try again.');   // unhelpful copy
  } else { showBanner('Account created! (demo)'); }
});
function pushPageview(p){ history.pushState({}, '', p); }
```

`serve.sh`: `#!/bin/sh\ncd "$(dirname "$0")" && exec python3 -m http.server 8321`.

- [ ] **Step 2: Verify by hand** — `sh demo-app/serve.sh &`, then three separate checks (line-count grep is fragile): `curl -s http://localhost:8321/ | grep -q 'id="cta-trial"' && curl -s http://localhost:8321/ | grep -q 'id="nav-plans"' && curl -s http://localhost:8321/ | grep -q 'id="signup-form"' && echo OK` → `OK`; kill server.

- [ ] **Step 3: Commit** — `git add demo-app/ && git commit -m "Lumina Notes demo product with planted UX flaws"`

## Chunk 4: E2E harness + runbook

### Task 4.1: Harness scripts

**Files:**
- Create: `PL/e2e/tmux.sh` (helpers), `PL/e2e/preflight.sh`, `PL/e2e/verify_backend.py`, `PL/e2e/RUNBOOK.md`

- [ ] **Step 1: `tmux.sh`** — thin wrappers from the verified playbook (`docs/E2E_HARNESS_NOTES.md`): `e2e_start` (`tmux new-session -d -s archetype-e2e -x 220 -y 50`), `e2e_send "<literal>"` (`send-keys -l`, **`sleep 1`** for autocomplete settle, then `Enter` — verified necessary for slash commands), `e2e_keys <keys...>` (raw key names for modal driving: `Space`, `Down`, `Enter`, `Escape`), `e2e_pane` (`capture-pane -p -S -200`), `e2e_idle` (grep heuristic: prompt line `❯` with no spinner), `e2e_dialog` (greps the pane for `requests your input|trust this folder|Do you want` so the operator can branch on unexpected dialogs instead of hanging), `e2e_stop`.

- [ ] **Step 2: `preflight.sh`** — checks and prints PASS/FAIL lines: tmux present; `claude --version`; backend `.env` exists; `curl -s localhost:5001/health` (started separately); `curl -s localhost:8321` demo app; Redis PONG (informational); **delete stale plugin auth** (`rm -f ~/.claude/plugins/data/archetype-*/auth.json`, echo what was removed — forces the wizard deterministically, criterion A3); Screen Recording spot-check: open a distinctive app window (e.g. `open -a Calculator`), `screencapture -x /tmp/e2e_sr_check.png`, print the path with the instruction **"orchestrator MUST Read this PNG and visually confirm the window is present — file size is NOT authoritative (wallpaper-only captures are full-size)"**.

- [ ] **Step 3: `verify_backend.py`** — run from `BE` (`cd BE && uv run python <PL>/e2e/verify_backend.py --user-id <sub> [--run-id <id> | --cleanup]` — `--run-id` optional when `--cleanup` is passed): connects via `infrastructure.database`, prints a PASS/FAIL checklist: `Replay.sessions` count ≥3 w/ `behavior_summary.parserVersion==1`; `Persona.user_personas` has `source=="replay"` doc with non-empty `generated_episodes`; test doc status `completed`, `validation_type=="plugin"`; `session_log` doc for the session with ≥1 step carrying `narration` + `action_text`; ≥1 `feedback` doc `type=="plugin_finding"`; `session_extraction` presence reported as informational (analytics is best-effort). Exit 0 iff all required PASS. **`--cleanup` mode: instead of verifying, delete this user's docs across `Replay.sessions`, `Persona.user_personas`, `Archetype_Test.test`, `Archetype_Test.session_log`, `Archetype_Test.session_extraction`, `Archetype_Test.feedback` (filter by `user_id`/`persona_id`), print per-collection delete counts** — used between E2E attempts.

- [ ] **Step 4: `RUNBOOK.md`** — the exact operator sequence (§7 of the spec):
  1. Backend with a tailable log: `cd BE && nohup uv run python app.py > /tmp/e2e_backend.log 2>&1 &`; demo app: `sh PL/demo-app/serve.sh &`. Monitor during the run with `tail -f /tmp/e2e_backend.log` (grep for `/api/plugin` requests — this is the B2 "logs monitored" evidence; capture excerpts into `e2e/artifacts/backend_log_excerpt.txt` at the end).
  2. `preflight.sh` (must end all-PASS; Read the screen-recording PNG).
  3. `e2e_start`, then **attach the session in a visible Terminal window** (`tmux attach -t archetype-e2e` in a Terminal tab the orchestrator opens via `osascript` or asks the user to open once) — a detached tmux session has NO on-screen pixels, so every `screencapture` of the wizard/TUI depends on this.
  4. `e2e_send "mkdir -p /tmp/e2e_inner && cd /tmp/e2e_inner && ARCHETYPE_BACKEND_URL=http://localhost:5001 claude --plugin-dir <PL> --debug-file /tmp/e2e_inner_debug.log"` (fresh cwd keeps project settings out and makes the trust dialog deterministic; `--debug-file` keeps the TUI clean for `e2e_idle` and gives a greppable MCP log).
  5. `e2e_pane` → if trust dialog present (`e2e_dialog`), `e2e_keys Enter`.
  6. `e2e_send "/archetype:validation"` → wait for the elicitation modal (`e2e_dialog`) → **screenshot** `screencapture -x e2e/artifacts/wizard.png` → extract the Auth0 verification URL from `e2e_pane` text → outer-session Chrome navigates it and approves (fallback: human, one time) → `e2e_keys Space Down Enter` → confirm pane shows "Connected to Archetype" and `ls -l ~/.claude/plugins/data/archetype-*/auth.json` exists mode `0600`.
  7. `e2e_send "/archetype:validation \"test the signup flow\" url=http://localhost:8321"` → periodic `screencapture -x e2e/artifacts/chrome_NN.png` every ~20 s while the pane shows activity (bring Chrome frontmost first with `open -a "Google Chrome"` — the attached tmux Terminal from item 3 may otherwise cover it; A4 evidence) → `e2e_idle` → save final report pane text to `e2e/artifacts/final_report.txt`.
  8. `verify_backend.py --user-id <sub> --run-id <id>` → exit 0 (B1/B2).
  9. Vision-verdict phase: dispatch a vision subagent with `wizard.png`, `chrome_*.png`, `final_report.txt`, and criteria A3/A4/A5 from `docs/GOAL_AND_TEST_CRITERIA.md`; it returns structured PASS/FAIL per criterion with evidence quotes.
  10. Teardown: `e2e_stop`, kill backend + demo-app processes. Artifacts retained in `e2e/artifacts/` (gitignored).

- [ ] **Step 5: Add `e2e/artifacts/` to `PL/.gitignore`; commit** — `git add e2e/ .gitignore && git commit -m "E2E harness: tmux helpers, preflight, backend verifier, runbook"`

### Task 4.2: Execute the E2E (acceptance gate)

- [ ] **Step 1: Execute `RUNBOOK.md` live; iterate until done.** Definition of done = `docs/GOAL_AND_TEST_CRITERIA.md` A1–A5 + B1–B2 + C all PASS with evidence retained in `e2e/artifacts/` + `verify_backend.py` exit 0. Expected debug loop: skill wording → `/reload-plugins` in the inner session → rerun; backend fixes → restart `app.py` → rerun; between attempts `verify_backend.py --cleanup --user-id <sub>`.

**Plan-level risks (watch during execution):**
- First `start_run` takes 60–90 s (persona LLM) — the inner Claude may time out the MCP call if Claude Code's tool timeout < 180 s; if observed, fall back to pre-warming the persona (run `ensure_replay_persona` once via a `BE` script before the inner run) and note it in the runbook.
- Elicitation modal keys are timing-sensitive — always `e2e_pane` before sending keys.
- Only the INNER session drives Chrome during the test; the outer session touches Chrome solely for the pre-run Auth0 approval.
