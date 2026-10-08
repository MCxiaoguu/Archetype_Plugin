#!/bin/bash
# Curl smoke suite for the Relay demo server (see GROUND_TRUTH.md — Real function map).
# Usage: ./test_server.sh              (default port 8398, so the live demo on 8322 is untouched)
#        RELAY_PORT=9000 ./test_server.sh
# Boots its own server if nothing is listening on the port; resets state at the start.
set -u

DIR="$(cd "$(dirname "$0")" && pwd)"
PORT="${RELAY_PORT:-8398}"
BASE="http://localhost:$PORT"
DEBUG_TOKEN="rly_live_8f3a9c2e5b7d4f16"
TMP="$(mktemp -d)"
SERVER_PID=""
PASS=0
FAIL=0

cleanup() {
  if [ -n "$SERVER_PID" ]; then
    kill "$SERVER_PID" 2>/dev/null
    wait "$SERVER_PID" 2>/dev/null
  fi
  rm -rf "$TMP"
}
trap cleanup EXIT

check() { # label expected actual
  if [ "$2" = "$3" ]; then
    PASS=$((PASS + 1)); echo "PASS  $1"
  else
    FAIL=$((FAIL + 1)); echo "FAIL  $1 (expected: $2, got: $3)"
  fi
}

post() { # path [curl args...] -> prints http code; body lands in $TMP/body
  local path="$1"; shift
  curl -s -o "$TMP/body" -w '%{http_code}' -X POST "$BASE$path" "$@"
}

get() { # path [curl args...] -> prints http code; body lands in $TMP/body
  local path="$1"; shift
  curl -s -o "$TMP/body" -w '%{http_code}' "$BASE$path" "$@"
}

field() { python3 -c "import json,sys;print(json.load(sys.stdin).get('$1',''))" < "$TMP/body"; }
count() { python3 -c "import json,sys;print(len(json.load(sys.stdin).get('$1',[])))" < "$TMP/body"; }

if ! curl -s -o /dev/null "$BASE/index.html"; then
  RELAY_PORT="$PORT" python3 "$DIR/server.py" > "$TMP/server.log" 2>&1 &
  SERVER_PID=$!
  for _ in $(seq 1 40); do
    curl -s -o /dev/null "$BASE/index.html" && break
    sleep 0.25
  done
fi

echo "== Relay smoke test against $BASE =="

# Pristine state
check "POST /api/debug/reset" "200" "$(post /api/debug/reset)"

# Static pages
for page in "" index.html signup.html signin.html onboarding.html dashboard.html docs.html pricing.html security.html; do
  check "GET /$page -> 200" "200" "$(get "/$page")"
done

# Answer key and server state are not exposed as static files
check "GET /GROUND_TRUTH.md -> 404" "404" "$(get /GROUND_TRUTH.md)"
check "GET /data.json -> 404" "404" "$(get /data.json)"

# Signup: creates a real account (card mandatory — D1)
check "signup -> 201" "201" "$(post /api/signup -H 'Content-Type: application/json' \
  -d '{"name":"Test User","email":"tester@example.com","password":"password123","card":"4242 4242 4242 4242","expiry":"12/28","cvc":"123"}')"
COLD_SESSION="$(field session)"
check "signup returns a session token" "yes" "$([ -n "$COLD_SESSION" ] && echo yes || echo no)"
check "signup without card -> 422 (D1)" "422" "$(post /api/signup -H 'Content-Type: application/json' \
  -d '{"name":"No Card","email":"nocard@example.com","password":"password123"}')"
check "duplicate signup -> 409" "409" "$(post /api/signup -H 'Content-Type: application/json' \
  -d '{"name":"Test User","email":"tester@example.com","password":"password123","card":"4242424242424242","expiry":"12/28","cvc":"123"}')"

# Cold account: genuinely empty workspace (D4)
get /api/events -H "Authorization: Bearer $COLD_SESSION" > /dev/null
check "cold account has 0 events (D4)" "0" "$(count events)"

# Ingest: 401 without a token (D2), 202 with the never-displayed debug token
check "ingest without token -> 401 (D2)" "401" "$(post /api/events -H 'Content-Type: application/json' -d '{"name":"x"}')"
check "ingest with bogus token -> 401" "401" "$(post /api/events -H 'Authorization: Bearer rly_live_nope' -H 'Content-Type: application/json' -d '{"name":"x"}')"
check "ingest with debug token -> 202" "202" "$(post /api/events -H "Authorization: Bearer $DEBUG_TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"smoke.test","service":"smoke-api","status":200,"latencyMs":42}')"

# Debug sign-in: seeded workspace + the fresh event
check "debug sign-in -> 200" "200" "$(post /api/session -H 'Content-Type: application/json' \
  -d '{"email":"founder@relay.dev","password":"relay-debug-2026"}')"
DEBUG_SESSION="$(field session)"
check "wrong password -> 401" "401" "$(post /api/session -H 'Content-Type: application/json' \
  -d '{"email":"founder@relay.dev","password":"wrong"}')"
check "reads without session -> 401" "401" "$(get /api/events)"
get /api/events -H "Authorization: Bearer $DEBUG_SESSION" > /dev/null
check "debug events = 12 seeds + 1 ingested" "13" "$(count events)"
check "ingested event visible in GET /api/events" "yes" "$(grep -q 'smoke\.test' "$TMP/body" && echo yes || echo no)"
get /api/incidents -H "Authorization: Bearer $DEBUG_SESSION" > /dev/null
check "seeded incident present" "yes" "$(grep -q 'Elevated 5xx on checkout-api' "$TMP/body" && echo yes || echo no)"

# Rules: the cryptic valid format saves; anything else is rejected and NOT saved (D8)
check "valid rule >1/5m -> 201" "201" "$(post /api/rules -H "Authorization: Bearer $DEBUG_SESSION" -H 'Content-Type: application/json' \
  -d '{"endpoint":"smoke-api","threshold":">1/5m","channel":"Email"}')"
get /api/rules -H "Authorization: Bearer $DEBUG_SESSION" > /dev/null
check "rule saved (1 seed + 1 new)" "2" "$(count rules)"
check "invalid rule format -> 422 (D8)" "422" "$(post /api/rules -H "Authorization: Bearer $DEBUG_SESSION" -H 'Content-Type: application/json' \
  -d '{"endpoint":"smoke-api","threshold":"alert at 500 errors","channel":"Email"}')"
get /api/rules -H "Authorization: Bearer $DEBUG_SESSION" > /dev/null
check "invalid rule NOT saved" "2" "$(count rules)"

# Rule evaluation: two 5xx events on smoke-api trip >1/5m -> Email notification (D9)
post /api/events -H "Authorization: Bearer $DEBUG_TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"POST /v1/smoke","service":"smoke-api","status":500,"latencyMs":900}' > /dev/null
check "second 5xx -> 202" "202" "$(post /api/events -H "Authorization: Bearer $DEBUG_TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"POST /v1/smoke","service":"smoke-api","status":503,"latencyMs":1200}')"
get /api/notifications -H "Authorization: Bearer $DEBUG_SESSION" > /dev/null
check "notification fired" "yes" "$([ "$(count notifications)" -ge 1 ] && echo yes || echo no)"
check "notification is Email-only (D9)" "yes" "$(grep -q 'Email queued to founder@relay.dev' "$TMP/body" && echo yes || echo no)"

# Reset restores pristine seeds and drops signup accounts + sessions
check "reset -> 200" "200" "$(post /api/debug/reset)"
check "old session invalidated" "401" "$(get /api/events -H "Authorization: Bearer $DEBUG_SESSION")"
post /api/session -H 'Content-Type: application/json' -d '{"email":"founder@relay.dev","password":"relay-debug-2026"}' > /dev/null
DEBUG_SESSION="$(field session)"
get /api/events -H "Authorization: Bearer $DEBUG_SESSION" > /dev/null
check "post-reset debug events = 12 seeds" "12" "$(count events)"
check "signup account gone after reset" "401" "$(post /api/session -H 'Content-Type: application/json' \
  -d '{"email":"tester@example.com","password":"password123"}')"

echo "== $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ]
