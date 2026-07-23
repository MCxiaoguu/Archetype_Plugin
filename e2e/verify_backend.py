#!/usr/bin/env python3
"""Verify (or clean up) the Archetype backend state after a live E2E plugin run.

WHY THIS IS RUN THE WAY IT IS
-----------------------------
This script imports the backend's ``infrastructure.database`` house helpers to
talk to Mongo Atlas. Those imports + the .env (Mongo URI, TLS) only resolve
when the current working directory is the backend repo. So this script MUST be
invoked FROM the backend dir with the backend's ``uv`` environment:

    cd /Users/hanyanggu/Personal_Files/Coding/Archetype_all/Archetype_Core/Archetype_Backend \
      && uv run python \
         /Users/hanyanggu/Personal_Files/Coding/Archetype_all/Archetype_Plugins/e2e/verify_backend.py \
         --user-id <auth0-sub> --run-id <test_id>

The script does ``sys.path.insert(0, os.getcwd())`` so ``infrastructure`` and
``services`` import from that backend cwd. Never run it with system python
(Atlas TLS breaks) and never from the plugin dir.

MODES
-----
VERIFY (default; requires --run-id):
    Prints a PASS/FAIL checklist mapping to acceptance criteria B1/B2 and the
    A5 feedback round-trip. Exits 0 iff every REQUIRED check passes.
    Checks:
      [1] Replay.sessions        — >=3 live docs for the user, parserVersion==1
      [2] Persona.user_personas  — source=="replay" doc, non-empty generated_episodes
      [3] Archetype_Test.test    — run doc exists, owned by user, validation_type
                                    =="plugin", status=="completed"
      [4] Archetype_Test.session_log — doc for test_meta.plugin_session_id with
                                    >=1 step carrying BOTH narration and action_text
      [5] Archetype_Test.feedback    — >=1 doc type=="plugin_finding" for the run
      [INFO] Archetype_Test.session_extraction — presence only (analytics is
                                    best-effort, never a hard fail)

CLEANUP (--cleanup; --run-id optional):
    Deletes this user's docs across all pipeline collections and prints a
    per-collection delete count. Used between E2E attempts. Linkage:
      - Replay.sessions, Persona.user_personas: by user_id.
      - Archetype_Test.test, feedback: carry user_id directly.
      - Archetype_Test.session_log: NO user_id — deleted by the test_ids /
        plugin_session_ids discovered from the user's test docs.
      - Archetype_Test.session_extraction: NO user_id — deleted by the
        plugin_session_ids from the user's test docs.
"""
from __future__ import annotations

import argparse
import os
import sys

# Resolve backend packages from the invocation cwd (must be the backend repo).
sys.path.insert(0, os.getcwd())

try:
    from infrastructure.database import find_one, find_many, delete_many
except ImportError as exc:  # pragma: no cover - operator guidance
    sys.stderr.write(
        "ERROR: could not import infrastructure.database (%s).\n"
        "Run FROM the backend dir with uv, e.g.:\n"
        "  cd /Users/hanyanggu/Personal_Files/Coding/Archetype_all/"
        "Archetype_Core/Archetype_Backend && uv run python "
        "<this-script> --user-id ...\n" % exc
    )
    sys.exit(2)

REPLAY_DB = "Replay"
REPLAY_COLL = "sessions"
PERSONA_DB = "Persona"
PERSONA_COLL = "user_personas"
TEST_DB = "Archetype_Test"
TEST_COLL = "test"
SESSION_LOG_COLL = "session_log"
FEEDBACK_COLL = "feedback"
EXTRACTION_COLL = "session_extraction"


# --------------------------------------------------------------------------- #
# VERIFY
# --------------------------------------------------------------------------- #
def _fmt(ok: bool) -> str:
    return "PASS" if ok else "FAIL"


def verify(user_id: str, run_id: str) -> int:
    """Print the checklist; return 0 iff all REQUIRED checks pass."""
    all_ok = True
    print(f"VERIFY  user_id={user_id}  run_id={run_id}")
    print("-" * 68)

    # [1] Replay.sessions -- >=3 live docs with behavior_summary.parserVersion==1
    replay_docs = find_many(
        REPLAY_DB,
        REPLAY_COLL,
        {"user_id": user_id, "isDeleted": {"$ne": True}},
    )
    parser_ok = [
        d for d in replay_docs
        if (d.get("behavior_summary") or {}).get("parserVersion") == 1
    ]
    c1 = len(parser_ok) >= 3
    all_ok &= c1
    print(f"[1] {_fmt(c1)}  Replay.sessions: {len(parser_ok)} live docs with "
          f"parserVersion==1 (need >=3; total live={len(replay_docs)})")

    # [2] Persona.user_personas -- source=="replay", non-empty generated_episodes
    persona = find_one(
        PERSONA_DB,
        PERSONA_COLL,
        {"user_id": user_id, "source": "replay", "isDeleted": {"$ne": True}},
    )
    episodes = (persona or {}).get("generated_episodes") or []
    c2 = bool(persona) and len(episodes) > 0
    all_ok &= c2
    if persona:
        print(f"[2] {_fmt(c2)}  Persona.user_personas: replay persona "
              f"{persona.get('user_persona_id')!r} with {len(episodes)} "
              f"generated_episodes (need >=1)")
    else:
        print(f"[2] {_fmt(c2)}  Persona.user_personas: no source=='replay' doc for user")

    # [3] Archetype_Test.test -- run doc exists, owned by user, plugin, completed
    test_doc = find_one(TEST_DB, TEST_COLL, {"test_id": run_id}) if run_id else None
    test_meta = (test_doc or {}).get("test_meta") or {}
    owned = bool(test_doc) and test_doc.get("user_id") == user_id
    vt = test_meta.get("validation_type")
    status = (test_doc or {}).get("status")
    c3 = owned and vt == "plugin" and status == "completed"
    all_ok &= c3
    if test_doc:
        print(f"[3] {_fmt(c3)}  Archetype_Test.test: owned={owned} "
              f"validation_type={vt!r} status={status!r} "
              f"(need owned, 'plugin', 'completed')")
    else:
        print(f"[3] {_fmt(c3)}  Archetype_Test.test: no doc for run_id={run_id!r}")

    plugin_session_id = test_meta.get("plugin_session_id")

    # [4] Archetype_Test.session_log -- >=1 step with narration AND action_text
    session_log = (
        find_one(TEST_DB, SESSION_LOG_COLL, {"session_id": plugin_session_id})
        if plugin_session_id else None
    )
    steps = (session_log or {}).get("steps") or []
    good_steps = [
        s for s in steps
        if s.get("narration") and s.get("action_text")
    ]
    c4 = bool(session_log) and len(good_steps) >= 1
    all_ok &= c4
    if session_log:
        print(f"[4] {_fmt(c4)}  Archetype_Test.session_log[{plugin_session_id}]: "
              f"{len(good_steps)}/{len(steps)} steps carry narration AND "
              f"action_text (need >=1)")
    else:
        print(f"[4] {_fmt(c4)}  Archetype_Test.session_log: no doc for "
              f"session_id={plugin_session_id!r}")

    # [5] Archetype_Test.feedback -- >=1 plugin_finding for the run
    findings = find_many(
        TEST_DB,
        FEEDBACK_COLL,
        {"test_id": run_id, "type": "plugin_finding"},
    ) if run_id else []
    c5 = len(findings) >= 1
    all_ok &= c5
    print(f"[5] {_fmt(c5)}  Archetype_Test.feedback: {len(findings)} "
          f"plugin_finding doc(s) for the run (need >=1)")

    # [INFO] session_extraction -- informational only
    extraction = (
        find_one(TEST_DB, EXTRACTION_COLL, {"session_id": plugin_session_id})
        if plugin_session_id else None
    )
    print(f"[INFO]      Archetype_Test.session_extraction: "
          f"{'present' if extraction else 'absent'} "
          f"(analytics is best-effort; never a hard fail)")

    print("-" * 68)
    print(f"VERIFY RESULT: {'ALL REQUIRED PASS' if all_ok else 'FAILURES ABOVE'}")
    return 0 if all_ok else 1


# --------------------------------------------------------------------------- #
# CLEANUP
# --------------------------------------------------------------------------- #
_DELETE_FAILURES: list = []


def _del(db: str, coll: str, query: dict, label: str) -> int:
    """delete_many wrapper that tolerates an empty query (skip, count 0).

    Records failed deletes in _DELETE_FAILURES so cleanup() can exit non-zero
    instead of silently claiming success.
    """
    if not query:
        print(f"  {coll:<20} 0  ({label}: nothing to key on, skipped)")
        return 0
    ok, count = delete_many(db, coll, query)
    flag = ""
    if not ok:
        _DELETE_FAILURES.append(f"{db}.{coll}")
        flag = "  [delete_many reported failure]"
    print(f"  {coll:<20} {count}  ({label}){flag}")
    return count


def cleanup(user_id: str) -> int:
    """Delete this user's docs across the pipeline collections; print counts.

    Returns 0 on full success, 1 if any delete_many reported failure.
    """
    del _DELETE_FAILURES[:]
    print(f"CLEANUP  user_id={user_id}")
    print("-" * 68)

    # Discover the user's test docs FIRST — session_log/session_extraction have
    # no user_id, so we key them off these ids.
    test_docs = find_many(TEST_DB, TEST_COLL, {"user_id": user_id})
    test_ids = [d["test_id"] for d in test_docs if d.get("test_id")]
    plugin_session_ids = [
        (d.get("test_meta") or {}).get("plugin_session_id")
        for d in test_docs
    ]
    plugin_session_ids = [s for s in plugin_session_ids if s]

    print(f"  discovered {len(test_docs)} test doc(s) for user: "
          f"{len(test_ids)} test_id(s), {len(plugin_session_ids)} session id(s)")

    total = 0
    # 1. Replay.sessions — by user_id.
    total += _del(REPLAY_DB, REPLAY_COLL, {"user_id": user_id}, "by user_id")
    # 2. Persona.user_personas — by user_id.
    total += _del(PERSONA_DB, PERSONA_COLL, {"user_id": user_id}, "by user_id")
    # 3. Archetype_Test.feedback — carries user_id directly (belt) plus any
    #    stragglers linked by the discovered test_ids (braces).
    total += _del(TEST_DB, FEEDBACK_COLL, {"user_id": user_id}, "by user_id")
    if test_ids:
        total += _del(
            TEST_DB, FEEDBACK_COLL, {"test_id": {"$in": test_ids}},
            "by test_id (stragglers without user_id)",
        )
    # 4. Archetype_Test.session_log — NO user_id; delete by test_id OR session_id.
    if test_ids or plugin_session_ids:
        query = {"$or": []}
        if test_ids:
            query["$or"].append({"test_id": {"$in": test_ids}})
        if plugin_session_ids:
            query["$or"].append({"session_id": {"$in": plugin_session_ids}})
        total += _del(TEST_DB, SESSION_LOG_COLL, query,
                      "by test_id / session_id from user's tests")
    else:
        _del(TEST_DB, SESSION_LOG_COLL, {}, "no test docs to link session_log")
    # 5. Archetype_Test.session_extraction — NO user_id; by session_id.
    if plugin_session_ids:
        total += _del(
            TEST_DB, EXTRACTION_COLL,
            {"session_id": {"$in": plugin_session_ids}},
            "by session_id from user's tests",
        )
    else:
        _del(TEST_DB, EXTRACTION_COLL, {}, "no session ids to link extraction")
    # 6. Archetype_Test.test — by user_id (last, after we've read its ids).
    total += _del(TEST_DB, TEST_COLL, {"user_id": user_id}, "by user_id")

    print("-" * 68)
    if _DELETE_FAILURES:
        print(f"CLEANUP RESULT: deleted {total} doc(s) for user {user_id}, but "
              f"delete_many FAILED for: {', '.join(_DELETE_FAILURES)}")
        return 1
    print(f"CLEANUP RESULT: deleted {total} doc(s) total for user {user_id}")
    return 0


# --------------------------------------------------------------------------- #
def main() -> int:
    p = argparse.ArgumentParser(
        description="Verify or clean up Archetype backend state after an E2E run. "
                    "MUST be run from the backend dir via uv (see module docstring).",
    )
    p.add_argument("--user-id", required=True,
                   help="Auth0 sub / user id that owns the run.")
    p.add_argument("--run-id", default=None,
                   help="test_id of the run (required for verify; optional for --cleanup).")
    p.add_argument("--cleanup", action="store_true",
                   help="Delete this user's pipeline docs instead of verifying.")
    args = p.parse_args()

    if args.cleanup:
        return cleanup(args.user_id)

    if not args.run_id:
        p.error("--run-id is required in verify mode (omit only with --cleanup)")
    return verify(args.user_id, args.run_id)


if __name__ == "__main__":
    sys.exit(main())
