# runtime

## summary
SUBSYSTEM: Archetype_Backend (Flask REST API) at /Users/hanyanggu/Personal_Files/Coding/Archetype_all/Archetype_Core/Archetype_Backend. Companion Claude Code plugin repo at /Users/hanyanggu/Personal_Files/Coding/Archetype_all/Archetype_Plugins (cwd).

FRAMEWORK + ROUTE REGISTRATION: Flask 3.1.2 app factory `create_app()` in app.py:17. Blueprints registered from hardcoded list app.py:38-53 via `__import__` inside try/except (app.py:69-77) — any blueprint whose import raises is SILENTLY SKIPPED (log warning only), so a broken module (e.g. Mongo unreachable at import time) just drops its routes. Mounts: api.routes_persona→/api/persona; routes_session/routes_agent/routes_feedback/routes_analytics/routes_user/routes_progress/routes_events/routes_validation_monitor→/api; routes_features→/api/features; routes_uat→/api/uat; routes_bootstrap→/api/bootstrap; routes_oauth→/api/oauth. App-level GET /health (app.py:79-81, no auth). CORS (app.py:22-34): origins = FRONT_END_URL env (default https://www.syntheticarchetype.com/), http://localhost:5173, http://localhost:3000; supports_credentials=True. NOTE app.py:15 does load_dotenv("/app/.env", override=True) — Docker path; no-ops locally, but infrastructure/database/mongo_init.py:18 and tasks/__init__.py:7-9 call load_dotenv() with default search so .env still loads.

START LOCALLY: `uv run python app.py` (or `source .venv/bin/activate && python app.py`). HOST=0.0.0.0, PORT=5001 (app.py:90-92; debug hardcoded False at app.py:92). Prod: `gunicorn -w 4 -b 0.0.0.0:5001 --timeout 120 "app:create_app()"` (README.md:209). Docker: `docker compose up --build` — backend :5001 + :6080 noVNC, celery worker (`celery -A tasks worker --concurrency=4`), celery beat (docker-compose.yml:16-85). .venv has Python 3.13.12 (pyproject requires >=3.13,<3.14; README's "python 3.11" is stale). uv at ~/.local/bin/uv; uv.lock present.

ENV VARS (.env exists, populated; .env.example documents most): MONGODB_URI (required — mongo_init.py:59-61 raises RuntimeError if unset), MONGODB_DB_NAME (present but code hardcodes DB names), REDIS_URL (optional for API — services/event_bus.py:29,46-48 disables event bus if unset; Celery broker/backend default redis://localhost:6379/0, tasks/__init__.py:13-14, tasks/notte_tasks.py:159), GEMINI_API_KEY, OPENROUTER_API_KEY/OPENAI_API_KEY/ANTHROPIC_API_KEY, AUTH0_DOMAIN, AUTH0_CLIENTID, AUTH0_AUDIENCE, AUTH0_DEVICE_AUTH_DOMAIN, AUTH0_DEVICE_AUTH_CLIENTID (device flow, routes_oauth.py:54-66), FRONT_END_URL, DEV_MODE, FLASK_ENV, EXPERIMENT_MODE, SIMULATION_STUB, NOTTE_API_KEY, BROWSER_USE_API_KEY, HOST, PORT, HEADFUL, BROWSER_DISPLAY, WORKERS, REDIS_TEST_STREAM_PREFIX (default archetype:test_updates:), REDIS_TEST_STREAM_MAXLEN(300)/MAXLEN_MONITOR(5000)/TTL(3600), TEST_UPDATE_STREAM_TIMEOUT(25), REDIS_CANCEL_KEY_PREFIX/TTL (event_bus.py:22-29), ANALYTICS_LLM_MODEL/TEMPERATURE, ENABLE_MEMORY_CENTERED, ENABLE_WEAVE/WEAVE_PROJECT/WANDB_ENTITY, AGENTMAIL_*, CLOUD_BROWSER_*, AUTH_MODE/TEST_USERNAME/TEST_PASSWORD (Notte E2E).

AUTH: infrastructure/auth/jwt_validator.py. `require_auth` (line 103): extracts `Bearer <token>` from Authorization header, validates RS256 JWT against JWKS https://{AUTH0_DOMAIN}/.well-known/jwks.json, audience=AUTH0_AUDIENCE, issuer=https://{AUTH0_DOMAIN}/, leeway=120s (lines 77-88); sets request.user_id = payload.sub. DEV BYPASS (lines 25-43, per-request): active if (DEV_MODE in {true,1,yes} AND FLASK_ENV != "production") OR if AUTH0_DOMAIN unset/placeholder "your-domain.auth0.com" (auto-bypass, lines 39-42). Bypass user resolution (lines 129-142): X-User-Id header → bearer token sub → JSON body auth0Id/userId → "dev-user-123". Device OAuth flow for CLIs exists at /api/oauth/* and is already consumed by the plugin repo (scripts/setup-server.py; BACKEND_BASE = ARCHETYPE_BACKEND_URL env, default https://api.syntheticarchetype.com; token cached at ${CLAUDE_PLUGIN_DATA}/auth.json).

MONGO/REDIS/CELERY WIRING + DEGRADED MODES: Mongo — process-wide singleton MongoClient via initClient()/get_client() (mongo_init.py:46-77); all CRUD through infrastructure/database/{insert,retrieval,update,delete,utils}.py helpers taking (db_name, collection_name, ...). App CAN start without Mongo: index-init calls in app.py:56-67 are try/except-wrapped and blueprint import failures swallowed (affected routes vanish). Redis — (1) services/event_bus.py Redis Streams for long-poll status; optional — disabled → /api/validation-tests/<id>/wait-status returns 503 (routes_events.py:52-53); (2) infrastructure/memory/redis_memory_cache.py session memory cache. Celery — tasks/__init__.py: celery_app broker+backend=REDIS_URL, include tasks.notte_tasks/tasks.uat_tasks/tasks.watchdog, beat sweep_stale_tests every 300s, task_time_limit 900s. API dispatches via .delay() (routes_uat.py:158) — without worker+Redis, POST run endpoints return 202 but nothing executes.

PYTEST: `uv run python -m pytest _tests/ -v` (CLAUDE.md:14-17 — uv run required; system python breaks Atlas TLS due to pymongo/cryptography version mismatch). Tier markers in _tests/conftest.py:23-27: tier0 compile, tier1 Gemini, tier2 Mongo+Redis, tier3 Notte E2E. Fixtures auto-skip when GEMINI_API_KEY/MONGODB_URI/Redis unavailable (conftest.py:36-74). Tests hit REAL services, no mocks.

ALREADY EXISTS FOR PLANNED WORK: (1) Plugin skills reference POST {ARCHETYPE_PORTAL_URL}/api/feature-validation/runs and GET .../runs/{run_id} (Archetype_Plugins/skills/validate-feature/SKILL.md:19, skills/check-run-status/SKILL.md:13) — THESE ROUTES DO NOT EXIST in the backend; only /api/features CRUD, /api/uat/tests*, /api/validation-tests* exist. (2) Device-code auth end-to-end exists (routes_oauth.py + plugin scripts/setup-server.py). (3) "Replay" in codebase = services/validation_monitor_replay.py — replays stored monitor events to frontend, NOT external session-replay ingestion; no rrweb/replay upload endpoint anywhere. (4) Persona generation rich (/api/persona/vibe free-text; /api/persona/generate demographic_input) but nothing derives personas from replay/behavioral logs. (5) Results ingestion is worker-side (Celery writes uat_tests/test/session_log/session_analytics); only externally-callable result writes: POST /api/test_engine/test/<id>/complete, PUT /api/uat/tests/<id>, POST /api/progress.

## howToRun
cd /Users/hanyanggu/Personal_Files/Coding/Archetype_all/Archetype_Core/Archetype_Backend. Deps: `uv sync` (uv at ~/.local/bin/uv; .venv exists with Python 3.13.12; pyproject requires >=3.13,<3.14 — README's 3.11 instructions are stale). Server: `uv run python app.py` → http://localhost:5001 (HOST/PORT env overrides, app.py:90-92; verify `curl http://localhost:5001/health` → {"status":"ok"}). .env already exists at repo root with MONGODB_URI, REDIS_URL, GEMINI_API_KEY, AUTH0_*, NOTTE_API_KEY etc. populated. Auth for local calls: set DEV_MODE=1 (and FLASK_ENV != production), then pass `X-User-Id: <any>` header to impersonate (jwt_validator.py:25-43,129-142); bypass also auto-activates if AUTH0_DOMAIN is unset. Background jobs need Redis + Celery worker: `uv run celery -A tasks worker --loglevel=info --concurrency=4` (+ optional `uv run celery -A tasks beat`); or full stack `docker compose up --build` (backend :5001, noVNC :6080, worker, beat). API works without Redis except long-poll wait-status endpoints (503) and .delay() dispatch (202 accepted but never executed without worker). Mongo effectively required for real routes; app boots without it but failing blueprints are silently dropped (app.py:69-77). Tests: `uv run python -m pytest _tests/ -v` (MUST use uv run — pinned pymongo/cryptography needed for Atlas TLS, CLAUDE.md:13-17). Tiers: `uv run python -m pytest _tests/test_compile.py -v` (tier0, no env), `-k tier1` (Gemini), tier2 (Mongo+Redis), tier3 (Notte E2E); fixtures auto-skip when env vars missing (_tests/conftest.py:36-74). Tests use real services, no mocks.

## endpoints
- GET /health | auth: none | req:  | resp: {status:'ok'} 200 (app.py:79)
- POST|GET /api/oauth/device/code | auth: none | req:  | resp: Auth0 device-flow payload: verification_uri_complete, user_code, device_code, interval (routes_oauth.py:66)
- GET /api/oauth/device-auth | auth: none | req: ?user_code=XYZ | resp: 302 redirect to https://{AUTH0_DOMAIN}/activate (routes_oauth.py:125)
- POST /api/oauth/device/token | auth: none | req: {device_code} | resp: Auth0 token passthrough; 403 authorization_pending while waiting; 200 {access_token,id_token,...} (routes_oauth.py:141)
- POST|GET /api/oauth/validate-token | auth: none (token in header/body/query) | req: Authorization: Bearer OR body {token} | resp: 200 {valid:true,user_id,audience,issuer,expires_at,issued_at,scope,payload} | 401 {valid:false,error,reason} (routes_oauth.py:189)
- GET /api/oauth/me | auth: require_auth | req:  | resp: {user_id,message} (routes_oauth.py:224)
- POST /api/features | auth: require_auth | req: JSON feature body | resp: 201 {ok:true,feature} (routes_features.py:19)
- GET /api/features | auth: require_auth | req:  | resp: {ok:true,features:[...]} (routes_features.py:32)
- GET /api/features/<feature_id> | auth: require_auth | req:  | resp: {ok:true,feature} | 404 (routes_features.py:41)
- PUT /api/features/<feature_id> | auth: require_auth | req:  | resp: {ok:true,feature} (routes_features.py:52)
- DELETE /api/features/<feature_id> | auth: require_auth | req:  | resp: soft delete via deletedAt (routes_features.py:65)
- POST /api/uat/tests | auth: require_auth | req: camelCase {prototypeUrl!, testCases![{title!,steps!,expectedResult!}], defects?, featureId?} via transform_from_frontend | resp: 201 {testId,status:'draft',createdAt} (routes_uat.py:23)
- GET /api/uat/tests | auth: require_auth | req:  | resp: list of user's UAT tests (routes_uat.py:60)
- GET /api/uat/tests/<test_id> | auth: require_auth | req:  | resp: transform_to_frontend(doc) (routes_uat.py:82)
- PUT /api/uat/tests/<test_id> | auth: require_auth | req:  | resp: updated doc (routes_uat.py:97)
- DELETE /api/uat/tests/<test_id> | auth: require_auth | req:  | resp: soft delete isDeleted (routes_uat.py:117)
- POST /api/uat/tests/<test_id>/run | auth: require_auth | req: {credentials?:{}} | resp: 202 {testId,status:'running',message,runEpoch}; dispatches Celery run_uat_test.delay (routes_uat.py:134-159); 409 if already running
- GET /api/uat/tests/<test_id>/status | auth: require_auth | req:  | resp: {testId,status,progress,currentStep,totalCases,completedCases} (routes_uat.py:162)
- GET /api/uat/tests/<test_id>/results | auth: require_auth | req:  | resp: 202 {status:'running'} | 404 draft | 200 transform_to_frontend(doc) (routes_uat.py:184)
- POST /api/validation-tests | auth: require_auth | req: camelCase {personaPoolId?, testMode:'reaction-only'|'hypothesis-test', productName, productDescription, productCategory, targetAudience, featureName, featureDescription, featureCategory, implementationEffort, goal?, hypothesis?, successMetrics?, url|prototypeLink, personaSelectionMode:'existing-pool'|'new-persona'|'custom-persona', customPersonaId?, segmentName?} (routes_session.py:213-260) | resp: {testId,status:'pending',createdAt,estimatedCompletionTime,testMode}
- GET /api/validation-tests | auth: require_auth | req:  | resp: list (routes_session.py:383)
- GET /api/validation-tests/<test_id> | auth: require_auth | req:  | resp: test doc (routes_session.py:440)
- DELETE /api/validation-tests/<test_id> | auth: require_auth | req:  | resp: revokes celery tasks via metadata.celery_task_ids (routes_session.py:458-505)
- GET /api/validation-tests/<test_id>/status | auth: require_auth | req:  | resp: status snapshot (routes_session.py:510)
- GET /api/validation-tests/<test_id>/results | auth: require_auth | req:  | resp: (routes_session.py:559)
- GET /api/validation-tests/<test_id>/reaction-results | auth: require_auth | req:  | resp: (routes_session.py:625)
- GET /api/validation-tests/<test_id>/wait-status | auth: require_auth | req: ?timeout=&cursor= (Redis stream cursor) | resp: 200 event | 204 {keepAlive,cursor} | 410 {staleCursor} | 503 event_stream_unavailable if no Redis; free-plan event filtering (routes_events.py:50-135)
- GET /api/uat/tests/<test_id>/wait-status | auth: require_auth | req:  | resp: long-poll UAT events (routes_events.py:138)
- GET /api/validation-tests/<test_id>/monitor-snapshot | auth: require_auth | req:  | resp: monitor event snapshot (routes_validation_monitor.py:18)
- POST /api/validation-tests/<test_id>/sessions/<session_id>/ask | auth: require_auth | req:  | resp: BTW ask (routes_validation_monitor.py:33)
- GET /api/validation-tests/<test_id>/feedback | auth: require_auth | req:  | resp: (routes_feedback.py:22)
- POST /api/validation-tests/<test_id>/feedback/generate | auth: require_auth | req:  | resp: (routes_feedback.py:61)
- POST /api/persona/generate_existing | auth: NO require_auth | req: {segment_name, persona_type, number, batch_size} | resp: (routes_persona.py:162)
- POST /api/persona/generate | auth: NO require_auth | req: {demographic_input, segment, product_description?} | resp: 200 result (routes_persona.py:212)
- POST /api/persona/vibe | auth: require_auth | req: {mode:'vibe'|'manual', vibePrompt?, radarConfig?, controls?, previewOnly?, previewCount?, productDescription?, poolId?} | resp: 200 {examples} preview | 201 created persona (routes_persona.py:252-323)
- POST /api/persona/custom | auth: require_auth | req:  | resp: (routes_persona.py:326)
- GET /api/persona/custom | auth: require_auth | req:  | resp: (routes_persona.py:347)
- GET /api/persona | auth: NO require_auth | req:  | resp: list personas (routes_persona.py:400)
- GET /api/persona/<persona_id> | auth: NO require_auth | req:  | resp: (routes_persona.py:480)
- POST /api/persona/pool/create | auth: require_auth | req: {user_id, pool_name, segment_name, num_personas} | resp: {pool_id,pool_name,persona_count,persona_ids,created_at} (routes_persona.py:540)
- GET /api/persona/pools | auth: require_auth | req:  | resp: (routes_persona.py:734)
- GET|PATCH|POST|DELETE /api/persona/pools/<pool_id> | auth: require_auth | req:  | resp: (routes_persona.py:770-846)
- GET /api/persona/health | auth: none | req:  | resp: (routes_persona.py:877)
- GET /api/persona/presets/preview | auth: none | req:  | resp: (routes_persona.py:886)
- GET /api/persona/traits/radar | auth: none | req:  | resp: (routes_persona.py:927)
- GET /api/test_engine/num_sessions | auth: NO require_auth | req:  | resp: (routes_agent.py:22)
- POST /api/test_engine/start_session | auth: NO require_auth | req: {persona_pool_id | user_id+pool_name+segment_name+num_personas, num_sessions, url, goal, options{batch,max_steps,step_delay_s,allow_quit,headless,record_video,video_format}} | resp: {test_id, session_ids, pool_id, created_pool} (routes_agent.py:45)
- GET /api/test_engine/closest_running | auth: require_auth | req:  | resp: (routes_agent.py:662)
- GET /api/test_engine/test/<test_id>/status | auth: require_auth | req:  | resp: (routes_agent.py:760)
- GET /api/test_engine/test/<test_id>/logs | auth: require_auth | req:  | resp: (routes_agent.py:831)
- GET /api/test_engine/test/<test_id>/reaction-results | auth: require_auth | req:  | resp: (routes_agent.py:964)
- GET /api/test_engine/test/<test_id>/feedback | auth: require_auth | req:  | resp: (routes_agent.py:984)
- GET /api/test_engine/test/<test_id>/results | auth: require_auth | req:  | resp: (routes_agent.py:1004)
- GET /api/test_engine/get_session | auth: NO require_auth | req: ?session_id= | resp: (routes_agent.py:1044)
- POST /api/test_engine/test/<test_id>/complete | auth: require_auth | req:  | resp: externally-callable result completion (routes_agent.py:1055)
- GET /api/analytics/tests/<test_id>/summary | auth: require_auth | req:  | resp: (routes_analytics.py:32)
- POST /api/analytics/tests/<test_id>/summary/refresh | auth: require_auth | req:  | resp: (routes_analytics.py:45)
- GET /api/analytics/tests/<test_id>/retrieve | auth: require_auth | req:  | resp: (routes_analytics.py:58)
- GET /api/analytics/tests/<test_id>/meta | auth: require_auth | req:  | resp: (routes_analytics.py:75)
- GET (unverified) /api/analytics/tests/<test_id>/sessions/<session_id>/extraction | auth: unverified | req:  | resp: (routes_analytics.py:97; methods arg not read)
- GET (unverified) /api/analytics/tests/<test_id>/sessions/<session_id>/screenshot/<int:step_seq> | auth: unverified | req:  | resp: (routes_analytics.py:120)
- POST /api/bootstrap/ | auth: require_auth | req:  | resp: (routes_bootstrap.py:71)
- GET|POST /api/progress | auth: require_auth | req:  | resp: (routes_progress.py:28,46); also GET /api/progress/<user_id> (routes_progress.py:38)
- POST /api/session/hypothesis_suggestion | auth: require_auth | req:  | resp: (routes_session.py:24)
- POST /api/session/calculate_num_sessions | auth: require_auth | req:  | resp: (routes_session.py:89)
- GET /api/session/live_url | auth: require_auth | req:  | resp: (routes_session.py:138)
- POST /api/auth/sync-user | auth: require_auth | req:  | resp: (routes_user.py:93)
- GET|PUT /api/users/me | auth: require_auth | req:  | resp: (routes_user.py:186-240); also GET /api/users/me/subscription (:240), POST /api/users/me/usage/test-created (:258)
- GET|POST /api/user/{create,profile,update,delete,preferences,test_checkpoint,subscription,tests,personas} | auth: require_auth | req:  | resp: (routes_user.py:318-409)

## dataModels
- Mongo db 'Archetype_Test', coll 'test' — main validation-test doc: test_id, user_id, status, progress, current_step, updated_at, error, test_meta{goal,...}, results{feedback_summary{feedback,updated_at}}, metadata{celery_task_ids[], celery_callback_id} (routes_events.py:41-47, routes_session.py:494-495, infrastructure/analytics/feedback.py:167,568)
- Mongo db 'Archetype_Test', coll 'session_log' — one doc per simulated session with embedded steps[]: session_id (unique idx), test_id, persona_id, url, goal, start_time, product_id, steps[{seq, event_type, ...}] (simulation_core/log_result.py:52-53,101-120; indexes log_result.py:589-596: session_id_unique, persona_start_time_idx, steps_seq_idx, steps_event_type_idx)
- Mongo db 'Archetype_Test', coll 'sessions' — structured live-preview session metadata (log_result.py:55,170)
- Mongo db 'Archetype_Test', coll 'session_analytics' — per-session analytics: test_id, persona_id, session_id (indexes infrastructure/analytics/feedback.py:572-584)
- Mongo db 'Archetype_Test', coll 'feedback' — synthetic feedback docs: type ('consensus_rank' etc.), goal, session_id, rank, updated_at (feedback.py:44-47; indexes feedback.py:378-392: goal_type_updated, session_type)
- Mongo db 'Archetype_Test', coll 'uat_tests' — UAT doc: test_id (uuid4 hex), user_id, status draft|running|completed|failed, created_at/updated_at/completed_at, isDeleted, prototype_url, feature_id, test_cases[{title, steps, expected_result, actual_result, status ('not-started'|...), defect_id, notes}], defects[], results, progress, current_step, total_cases, completed_cases, run_epoch (services/uat/uat_service.py:13-67)
- Mongo db 'Archetype_Test', coll 'btw_log' — BTW Q/A log
- Mongo db 'Persona', coll 'user_personas' — individual persona docs (persona_id, demographics, behavioral_traits, context per README.md:698-716)
- Mongo db 'Persona', coll 'user_persona_pools' — pool_id, user_id, pool_name, persona_ids[], active_persona_ids[], metadata{selected_custom_persona_ids[], primary_archetype_name} (routes_session.py:286-300)
- Mongo db 'Persona', colls 'customized_personas', 'preset' — custom/preset personas (routes_persona.py services)
- Mongo db 'User', coll 'features' — _id ObjectId, userId, deletedAt (null=active), feature fields (services/features.py:12-52)
- Mongo db 'User', colls 'user_profile', 'user_checkpoints', 'user_preference', 'subscription', 'user_product' (routes_user.py services)
- Mongo db 'Archetype', coll 'users' — user_id, plan ('free'|paid), used for event-stream gating (routes_events.py:71-72)
- Redis: stream key '{REDIS_TEST_STREAM_PREFIX=archetype:test_updates:}{test_id}', maxlen 300 (5000 monitor), TTL 3600s; cancel keys 'archetype:cancelled:{id}' (services/event_bus.py:22-29). Celery broker/backend = REDIS_URL (tasks/__init__.py:11-16)
- DB access layer: infrastructure/database/{insert,retrieval,update,delete,utils}.py — all helpers take (db_name, collection_name, ...); singleton client mongo_init.py:46-77. Helper reference: infrastructure/database/DATABASE_DOCUMENTATION.md

## gaps
- Plugin-driven test runs: plugin skills already reference POST {ARCHETYPE_PORTAL_URL}/api/feature-validation/runs and GET /api/feature-validation/runs/{run_id} (Archetype_Plugins/skills/validate-feature/SKILL.md:19, skills/check-run-status/SKILL.md:13) but NO /api/feature-validation/* routes exist in the backend — must be built (or skills repointed at /api/uat/tests or /api/validation-tests).
- Session-replay ingestion: no endpoint accepts externally-captured session replays (no rrweb/posthog-replay upload route). Only 'replay' code is services/validation_monitor_replay.py which streams already-stored monitor events back out. Closest reusable shape: Archetype_Test.session_log docs with embedded steps[] (simulation_core/log_result.py).
- Persona-from-replay: persona generation only takes demographic_input (/api/persona/generate), segment stats, or free-text vibePrompt (/api/persona/vibe, routes_persona.py:252). No pipeline consumes session_log/replay data to synthesize personas.
- Persona-enriched instruction sets for the plugin: no endpoint serves persona-conditioned instructions/prompts to a plugin; personas are only consumed internally by the simulation brain (simulation_core/brain.py).
- Plugin result ingestion into Mongo: only externally-callable write paths are POST /api/test_engine/test/<id>/complete (routes_agent.py:1055), PUT /api/uat/tests/<id>, POST /api/progress; other results are written by Celery workers. No generic run-results ingestion endpoint keyed to a plugin run.
- config.py is a planning stub with zero implementation (config.py:166) — all config is scattered os.getenv calls; no single env contract to extend.
- Silent blueprint skipping (app.py:69-77): a new route module with an import-time error disappears without failing startup — verify registration when adding routes.
- Auth0 dev bypass auto-activates when AUTH0_DOMAIN is unset (jwt_validator.py:39-42) — new ingestion endpoints are unauthenticated by default in local envs; production safety depends on FLASK_ENV=production.
- Inconsistent auth surface: /api/persona/generate, /generate_existing, GET /api/persona, GET /api/persona/<id>, /api/test_engine/start_session, /num_sessions, /get_session lack require_auth — decide convention before adding persona-serving/plugin endpoints.
- MONGODB_DB_NAME env var exists in .env/.env.example but code hardcodes DB names ('Archetype_Test', 'Persona', 'User', 'Archetype') per module — new collections must follow the hardcoded pattern or introduce real config.
- Two divergent result conventions: validation tests (Archetype_Test.test + session_log + session_analytics, snake_case) vs UAT (uat_tests with camelCase transform_to_frontend/from_frontend layer in services/uat/uat_service.py) — pick one for new plugin-run results.
- docker-compose worker/beat reference /app/.venv/bin/celery inside the container (docker-compose.yml:56,77) and app.py:15 hardcodes load_dotenv('/app/.env') — Docker-specific paths; local runs rely on mongo_init.py:18 / tasks/__init__.py:7-9 dotenv loading instead.
