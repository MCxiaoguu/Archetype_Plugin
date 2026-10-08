#!/usr/bin/env python3
"""Relay demo backend — single file, Python stdlib only.

Serves the static pages and a real mini-API on the same port. State lives in
data.json next to this file (gitignored); delete it — or POST /api/debug/reset —
to restore the pristine seeded state. Port: RELAY_PORT env var, default 8322.
"""

import json
import os
import re
import threading
import uuid
from datetime import datetime, timedelta, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_PATH = os.path.join(BASE_DIR, "data.json")
PORT = int(os.environ.get("RELAY_PORT", "8322"))

DEBUG_EMAIL = "founder@relay.dev"
DEBUG_PASSWORD = "relay-debug-2026"
# Fixed so the answer key (GROUND_TRUTH.md) can reference it. No page, response,
# or snippet ever displays an API token — that is defect D2, kept real: ingest
# genuinely 401s without one.
DEBUG_TOKEN = "rly_live_8f3a9c2e5b7d4f16"

# The only accepted threshold shape is the cryptic >N/Nm (defect D8).
THRESHOLD_RE = re.compile(r"^>(\d+)/(\d+)m$")
EMAIL_RE = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]{2,}$")
EXPIRY_RE = re.compile(r"^(0[1-9]|1[0-2])\s*/\s*\d{2}$")

# Never expose the answer key, server internals, or stored tokens as static files.
BLOCKED_PATHS = {
    "/GROUND_TRUTH.md",
    "/data.json",
    "/server.py",
    "/serve.sh",
    "/test_server.sh",
    "/.gitignore",
}

_lock = threading.Lock()
_state = {}


def _now():
    return datetime.now(timezone.utc)


def _iso_minutes_ago(minutes):
    return (_now() - timedelta(minutes=minutes)).isoformat()


def _seed_state():
    email = DEBUG_EMAIL
    return {
        "accounts": {
            email: {
                "name": "Dana Founder",
                "email": email,
                "password": DEBUG_PASSWORD,
                "plan": "Pro trial — 14 days left",
                "debug": True,
                "token": DEBUG_TOKEN,
                "createdAt": _now().isoformat(),
            }
        },
        "sessions": {},
        "events": {
            email: [
                {"at": _iso_minutes_ago(2), "name": "POST /v2/charge", "service": "checkout-api", "region": "us-east-1", "latencyMs": 1840, "status": 503},
                {"at": _iso_minutes_ago(4), "name": "POST /v2/charge", "service": "checkout-api", "region": "us-east-1", "latencyMs": 1512, "status": 502},
                {"at": _iso_minutes_ago(5), "name": "GET /v2/orders", "service": "checkout-api", "region": "eu-west-1", "latencyMs": 212, "status": 200},
                {"at": _iso_minutes_ago(7), "name": "POST /v2/charge", "service": "checkout-api", "region": "us-east-1", "latencyMs": 1930, "status": 502},
                {"at": _iso_minutes_ago(9), "name": "POST /v2/token", "service": "auth-api", "region": "us-east-1", "latencyMs": 86, "status": 200},
                {"at": _iso_minutes_ago(12), "name": "GET /v2/session", "service": "auth-api", "region": "eu-west-1", "latencyMs": 64, "status": 200},
                {"at": _iso_minutes_ago(15), "name": "POST /hooks/stripe", "service": "webhooks", "region": "us-east-1", "latencyMs": 145, "status": 201},
                {"at": _iso_minutes_ago(18), "name": "GET /v2/orders", "service": "checkout-api", "region": "us-east-1", "latencyMs": 189, "status": 200},
                {"at": _iso_minutes_ago(22), "name": "POST /v2/token", "service": "auth-api", "region": "us-east-1", "latencyMs": 91, "status": 401},
                {"at": _iso_minutes_ago(26), "name": "POST /hooks/github", "service": "webhooks", "region": "eu-west-1", "latencyMs": 132, "status": 200},
                {"at": _iso_minutes_ago(31), "name": "POST /hooks/stripe", "service": "webhooks", "region": "us-east-1", "latencyMs": 158, "status": 200},
                {"at": _iso_minutes_ago(38), "name": "GET /v2/session", "service": "auth-api", "region": "us-east-1", "latencyMs": 58, "status": 200},
            ]
        },
        "incidents": {
            email: [
                {
                    "title": "Elevated 5xx on checkout-api",
                    "service": "checkout-api",
                    "openedAt": _iso_minutes_ago(41),
                    "state": "open",
                    "timeline": [
                        {"at": _iso_minutes_ago(41), "text": "5xx rate on POST /v2/charge crossed 4.2% (baseline 0.3%)."},
                        {"at": _iso_minutes_ago(40), "text": "Alert fired → email to founder@relay.dev."},
                        {"at": _iso_minutes_ago(33), "text": "Deploy marker: checkout-api v2.14.1 shipped 6 minutes before the spike."},
                        {"at": _iso_minutes_ago(11), "text": "Rollback to v2.14.0 started; error rate trending down."},
                    ],
                }
            ]
        },
        "rules": {
            email: [
                {"endpoint": "checkout-api", "condition": ">1% 5xx / 10m", "channel": "Email", "lastFired": "40m ago"}
            ]
        },
        "notifications": {email: []},
    }


def _save():
    tmp = DATA_PATH + ".tmp"
    with open(tmp, "w") as f:
        json.dump(_state, f, indent=2)
    os.replace(tmp, DATA_PATH)


def _load():
    global _state
    if os.path.exists(DATA_PATH):
        try:
            with open(DATA_PATH) as f:
                _state = json.load(f)
            return
        except (ValueError, OSError):
            pass
    _state = _seed_state()
    _save()


def _reset_state():
    global _state
    _state = _seed_state()
    _save()


def _account_by_token(token):
    for account in _state["accounts"].values():
        if token and account["token"] == token:
            return account
    return None


def _session_account(token):
    email = _state["sessions"].get(token)
    return _state["accounts"].get(email) if email else None


def _new_session(email):
    token = uuid.uuid4().hex
    _state["sessions"][token] = email
    return token


def _validate_signup(body):
    # Mirrors the client-side fieldRules; the card block staying mandatory even
    # for the Free plan is defect D1.
    if len(str(body.get("name", "")).strip()) < 2:
        return "invalid name"
    if not EMAIL_RE.match(str(body.get("email", "")).strip()):
        return "invalid email"
    if len(str(body.get("password", ""))) < 8:
        return "invalid password"
    card = re.sub(r"[\s-]", "", str(body.get("card", "")))
    if not re.match(r"^\d{12,19}$", card):
        return "card required"
    if not EXPIRY_RE.match(str(body.get("expiry", "")).strip()):
        return "invalid expiry"
    if not re.match(r"^\d{3,4}$", str(body.get("cvc", "")).strip()):
        return "invalid cvc"
    return None


def _evaluate_rules(email, event):
    # Only 5xx ingests can trip a rule; the >N/Nm window counts 5xx events for
    # the same service. The seeded display-format rule (">1% 5xx / 10m") does
    # not parse and is skipped on purpose.
    if int(event["status"]) < 500:
        return
    for rule in _state["rules"].get(email, []):
        if rule["endpoint"] != event["service"]:
            continue
        match = THRESHOLD_RE.match(rule["condition"])
        if not match:
            continue
        limit, window = int(match.group(1)), int(match.group(2))
        cutoff = _now() - timedelta(minutes=window)
        count = 0
        for e in _state["events"].get(email, []):
            if e["service"] != event["service"] or int(e["status"]) < 500:
                continue
            if datetime.fromisoformat(e["at"]) >= cutoff:
                count += 1
        if count > limit:
            rule["lastFired"] = "just now"
            _state["notifications"].setdefault(email, []).insert(0, {
                "at": _now().isoformat(),
                "endpoint": rule["endpoint"],
                "condition": rule["condition"],
                # Email is the only notification channel that exists (defect D9).
                "channel": "Email",
                "message": "Email queued to " + email,
            })


class RelayHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=BASE_DIR, **kwargs)

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path in BLOCKED_PATHS:
            self.send_error(404)
            return
        if path.startswith("/api/"):
            with _lock:
                self._api_get(path)
            return
        super().do_GET()

    def do_HEAD(self):
        path = self.path.split("?", 1)[0]
        if path in BLOCKED_PATHS or path.startswith("/api/"):
            self.send_error(404)
            return
        super().do_HEAD()

    def do_POST(self):
        path = self.path.split("?", 1)[0]
        if path.startswith("/api/"):
            with _lock:
                self._api_post(path)
            return
        self._json(404, {"error": "not found"})

    def _json(self, status, payload):
        raw = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _body(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        if not raw:
            return {}
        try:
            parsed = json.loads(raw)
        except ValueError:
            return None
        return parsed if isinstance(parsed, dict) else None

    def _bearer(self):
        header = self.headers.get("Authorization", "")
        if header.startswith("Bearer "):
            return header[7:].strip()
        return ""

    def _api_get(self, path):
        collections = {
            "/api/events": "events",
            "/api/incidents": "incidents",
            "/api/rules": "rules",
            "/api/notifications": "notifications",
        }
        key = collections.get(path)
        if key is None:
            self._json(404, {"error": "not found"})
            return
        account = _session_account(self._bearer())
        if account is None:
            self._json(401, {"error": "unauthorized"})
            return
        self._json(200, {key: _state[key].get(account["email"], [])})

    def _api_post(self, path):
        if path == "/api/debug/reset":
            _reset_state()
            self._json(200, {"ok": True})
            return

        body = self._body()
        if body is None:
            self._json(400, {"error": "invalid json"})
            return

        if path == "/api/signup":
            error = _validate_signup(body)
            if error:
                self._json(422, {"error": error})
                return
            email = str(body["email"]).strip()
            if email in _state["accounts"]:
                self._json(409, {"error": "email already registered"})
                return
            account = {
                "name": str(body["name"]).strip(),
                "email": email,
                "password": str(body["password"]),
                "plan": "free",
                "debug": False,
                "token": "rly_live_" + uuid.uuid4().hex[:16],
                "createdAt": _now().isoformat(),
            }
            _state["accounts"][email] = account
            for key in ("events", "incidents", "rules", "notifications"):
                _state[key][email] = []
            session = _new_session(email)
            _save()
            # The API token is deliberately absent from the response: no page or
            # payload the client ever sees contains it (defect D2).
            self._json(201, {"session": session, "account": {"name": account["name"], "email": email, "plan": "free", "debug": False}})
            return

        if path == "/api/session":
            email = str(body.get("email", "")).strip()
            password = str(body.get("password", ""))
            account = _state["accounts"].get(email)
            if account is None or account["password"] != password:
                self._json(401, {"error": "invalid credentials"})
                return
            session = _new_session(email)
            _save()
            self._json(200, {"session": session, "account": {"name": account["name"], "email": email, "plan": account["plan"], "debug": account["debug"]}})
            return

        if path == "/api/events":
            account = _account_by_token(self._bearer())
            if account is None:
                self._json(401, {"error": "unauthorized"})
                return
            try:
                status = int(body.get("status", 200))
                latency = int(body.get("latencyMs", 120))
            except (TypeError, ValueError):
                self._json(422, {"error": "invalid event"})
                return
            event = {
                "at": _now().isoformat(),
                "name": str(body.get("name") or "custom.event"),
                "service": str(body.get("service") or "default"),
                "region": str(body.get("region") or "us-east-1"),
                "latencyMs": latency,
                "status": status,
            }
            email = account["email"]
            _state["events"].setdefault(email, []).insert(0, event)
            _evaluate_rules(email, event)
            _save()
            self._json(202, {"accepted": True})
            return

        if path == "/api/rules":
            account = _session_account(self._bearer())
            if account is None:
                self._json(401, {"error": "unauthorized"})
                return
            threshold = str(body.get("threshold", "")).strip()
            # Defensive mirror of the client's silent regex guard (defect D8):
            # the client never sends an invalid format, but reject it anyway.
            if not THRESHOLD_RE.match(threshold):
                self._json(422, {"error": "invalid threshold"})
                return
            rule = {
                "endpoint": str(body.get("endpoint", "")).strip(),
                "condition": threshold,
                # Forced to Email — the only channel offered anywhere (defect D9).
                "channel": "Email",
                "lastFired": "—",
            }
            _state["rules"].setdefault(account["email"], []).append(rule)
            _save()
            self._json(201, {"rule": rule})
            return

        self._json(404, {"error": "not found"})


def main():
    _load()
    server = ThreadingHTTPServer(("", PORT), RelayHandler)
    print("Relay demo serving on http://localhost:%d" % PORT)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
