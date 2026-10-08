# Relay — Demo Ground Truth (Answer Key)

Relay is a dummy dev-tool startup (API monitoring & incident timelines) built for Archetype
validation demos. It is intentionally polished everywhere **except** for seven planted defects.
These are the findings personas SHOULD surface. Anything not listed here is expected to work.

Serve locally: `sh serve.sh` → http://localhost:8322 (runs `server.py`; `RELAY_PORT` env var overrides the port)

## Planted defects

| ID | Defect | Where |
|----|--------|-------|
| D1 | Landing promises "Free forever. No credit card required." but signup requires card number, expiry, and CVC even for the Free plan (all three are validated and mandatory). Trust contradiction. | `index.html` — hero, `.hero-claim` line directly under the CTA buttons. `signup.html` — "Payment details" divider + `#su-card`, `#su-expiry`, `#su-cvc` fields; required-ness enforced in `app.js` (`fieldRules`). |
| D2 | Docs quickstart initializes with `Relay.init({ token: process.env.RELAY_TOKEN })` but no step anywhere explains how to create or find `RELAY_TOKEN`. The only token guidance is "keep it secret." | `docs.html` — Step 2 "Initialize" (`#init` section, both code blocks + the lock callout). No other page fills the gap (onboarding repeats the same snippet, also without provenance). |
| D3 | Package-name inconsistency: docs install `@relay/sdk`; onboarding installs `relay-sdk` (while its own require line still reads `@relay/sdk`, so following onboarding verbatim would crash at require-time). | `docs.html` — Step 1 (`#install` code block: `npm install @relay/sdk`). `onboarding.html` — section "1 Install the SDK" (`npm install relay-sdk`). |
| D4 | Dashboard empty state is a dead end: a bare table and "No events yet." — no setup checklist, no docs link, no sample-data button, no guidance of any kind. | `dashboard.html` — `#section-events` (`.empty-cell` reads exactly "No events yet."). Incidents/Alerts tabs are equally bare. |
| D5 | Docs search is fake: typing anything (including terms that plainly exist on the page, e.g. "webhook", "token", "alert") always returns "No results found." | `docs.html` — sidebar `#docs-search-input`; behavior hardcoded in `app.js` ("Docs search" block always sets "No results found."). |
| D6 | Price inconsistency: pricing page says Pro is **$29/seat/mo**; onboarding upgrade banner says **$39/seat/mo** (and links straight to the pricing page that contradicts it). | `pricing.html` — Pro plan card (`.plan.featured`). `onboarding.html` — `.upgrade-banner` ("Upgrade to Pro — $39/seat/mo."). |
| D7 | Annual pricing is not self-serve: the annual row says "Talk to sales for annual discounts" and the **Book a demo** button opens a dead form — submitting only shows "Thanks — we'll be in touch." No price, no calendar, nothing else happens. | `pricing.html` — `.annual-row` + `#demo-modal`; dead-form behavior in `app.js` ("Book a demo modal" block). |

## Everything else works (do not report as defects)

- All nav and footer links resolve (Docs, Pricing, Sign in, Features/How-it-works anchors,
  Security, Terms `security.html#terms`, Privacy `security.html#privacy`). There are no 404s
  in this demo — a broken footer link is a *different* demo's defect, not this one's.
- Signup validation genuinely works (name, email format, password length, plausible card
  number 12–19 digits, MM/YY expiry, 3–4 digit CVC, ToS checkbox) and any plausible fake
  card is accepted; success stores `relay:user` in localStorage and redirects to onboarding.
- Onboarding → "Skip for now →" reaches the dashboard (the happy path is completable).
- Dashboard tabs (Events / Incidents / Alerts / Settings), the signed-in user chip, and
  Sign out all function. Visiting onboarding/dashboard signed-out redirects to signup.
- Docs sidebar anchors, scroll highlighting, and code-block Copy buttons work.
- The onboarding "Waiting for your first event…" spinner genuinely polls `GET /api/events`
  every 3 seconds and resolves to a success state ("First event received — view it in your
  dashboard.") once an event exists. For cold-funnel users it effectively never resolves,
  because sending an event requires the API token that D2 makes undiscoverable — that
  dead-wait is scaffolding for D2/D3/D4, not a separate defect.

## Expected persona findings, ranked by severity

1. **D1** — trust-breaking contradiction at the exact moment of conversion.
2. **D2 + D3** — quickstart cannot actually be completed: no token source, wrong package name.
3. **D4** — after skipping onboarding, a new user has zero path forward from the empty dashboard.
4. **D5** — search fails on terms visibly present in the docs; users assume the docs are empty.
5. **D6** — a $10/seat discrepancy between onboarding and pricing erodes pricing trust.
6. **D7** — annual buyers are forced into a sales funnel that visibly goes nowhere.

## Debug mode (founder-style authenticated testing)

A sign-in path for exercising the authenticated surfaces with realistic data. **D1–D7 and all
cold-funnel behavior are unchanged** — a cold signup still lands on the exact D4 empty
dashboard, and no page copy, pricing, docs, or signup behavior was touched.

- **Sign-in page**: `signin.html`. The top-nav "Sign in" link on `index.html`, `docs.html`,
  `pricing.html`, and `security.html` now points here (it previously pointed at
  `signup.html`). Any credential other than the debug one shows an inline
  "Invalid email or password." — that is standard behavior, **not** a planted defect.
- **Debug credential**: `founder@relay.dev` / `relay-debug-2026`. The account is pre-seeded
  **server-side**; sign-in creates a real session (`POST /api/session`, token kept in
  localStorage `relay:user`) and the dashboard loads the account's data from the API:
  - Account **Dana Founder**, plan **"Pro trial — 14 days left"** — shown in the dashboard
    header tag, the sidebar user meta, and Settings → Plan.
  - **12 events** across 3 endpoints (`checkout-api`, `auth-api`, `webhooks`) with
    timestamps, latencies, and status codes — rendered in the Events table.
  - **One open incident** — "Elevated 5xx on checkout-api" — with a 4-entry timeline,
    rendered under Incidents (table row + timeline card).
  - **One alert rule** — `checkout-api  >1% 5xx / 10m  → Email` — listed under Alerts.
- **Alert Rules surface** (any signed-in account): the Alerts tab shows the rule list plus a
  "New alert rule" form — endpoint selector (populated from the account's events), threshold
  input, notification-channel dropdown, and a Save button. Saved rules genuinely persist
  server-side (`POST /api/rules`). Sign out clears the local session; server-side data
  survives until `POST /api/debug/reset`.
- For **non-debug accounts** (i.e. anyone from the cold signup funnel) the workspace is
  genuinely empty server-side: the Events/Incidents tables stay exactly as bare as D4
  describes (same dead-end copy). The Alert Rules form renders for them too — its endpoint
  dropdown is simply empty until events arrive.

### Additional planted defects (debug mode only)

| ID | Defect | Where |
|----|--------|-------|
| D8 | The alert-rule **threshold input only accepts the cryptic format `>N/Nm`** (e.g. `>500/5m`). There is no placeholder, no hint, and no error message — with any other format the Save button clicks and silently does nothing. | `dashboard.html` — `#rule-threshold` inside `#alert-rules-panel` (Alerts tab, debug account). Silent validation in `app.js` ("Alert rules" block: `/^>\d+\/\d+m$/` guard returns without feedback). |
| D9 | The **notification-channel dropdown offers ONLY "Email"**, while the landing page promises "Alerts route to Slack, PagerDuty, or plain webhooks" (How-it-works step 03) and pricing lists "Slack, PagerDuty & webhook alerts". | `dashboard.html` — `#rule-channel` inside `#alert-rules-panel` (single `<option>Email</option>`). Contradicts `index.html` step 03 and `pricing.html` Pro features. |

## Real function map (server-backed)

The dummy now runs a **real zero-dependency backend**: `server.py` (Python stdlib only —
`http.server`/`json`/`uuid`/`re`) serves the static pages AND a working API on the same port.
State lives in `data.json` next to the server (gitignored; created with pristine seeds on
first boot). The planted defects are unchanged in definition but are now **real experiences**,
not staged ones.

Run: `sh serve.sh` (→ `exec python3 server.py`). Port: `RELAY_PORT` env var, default 8322.

| Endpoint | Auth | Behavior |
|---|---|---|
| `POST /api/signup` | — | Real account creation (name/email/password + card/expiry/cvc; card block mandatory and validated server-side — D1). Mints a real API token `rly_live_<hex>` stored **server-side only** — it appears in no page and no response (D2). Returns `201` + a session token; `409` duplicate email; `422` invalid fields. |
| `POST /api/session` | — | Real sign-in for the debug account or any signed-up account. `200` + session token; wrong credentials → `401` (client shows the existing inline error). |
| `POST /api/events` | `Bearer <API token>` | Real ingest. Valid token → `202`, event stored (name/service/region/latencyMs/status, sensible defaults) and the account's rules are evaluated. Missing/invalid token → terse `401` JSON. |
| `GET /api/events` · `/api/incidents` · `/api/rules` · `/api/notifications` | `Bearer <session>` | Session-scoped reads; the dashboard renders exclusively from these. Cold accounts genuinely have empty lists (the D4 empty-state copy is untouched). |
| `POST /api/rules` | `Bearer <session>` | Real rule storage. Only the cryptic `>N/Nm` threshold format is accepted (`422` otherwise); the client's silent-no-op regex guard is unchanged, so invalid input never even reaches the server (D8). Channel is forced to Email (D9). |
| `POST /api/debug/reset` | — | Restores pristine seeded state (accounts, events, incidents, rules, notifications, sessions). For test harnesses; documented only here, linked nowhere in the UI. |

- **Debug account API token (real, working)**: `rly_live_8f3a9c2e5b7d4f16`. Ingesting with it
  genuinely returns `202` and the event appears in the founder dashboard/`GET /api/events`.
  It is rendered by **no page, response, or snippet** — that IS D2, now authentic.
- **Rule evaluation is real**: on every 5xx ingest, the account's `>N/Nm` rules for that
  service are evaluated over the window; when the 5xx count exceeds N, the rule's "Last fired"
  updates and an entry is appended to the notification log: `Email queued to <account email>`
  — Email only, ever (D9). (The seeded display-format rule `>1% 5xx / 10m` doesn't parse and
  is intentionally skipped.)
- **Onboarding wait is real**: "Waiting for your first event…" polls `GET /api/events` every
  3 s and resolves to a success state when an event exists. Cold users cannot produce one
  without the undiscoverable token, so for them it still never resolves (D2 doing its job).
- **How each defect now manifests for real**:
  - **D1** — the server rejects signup without a valid card/expiry/CVC (`422`), matching the client validation.
  - **D2** — ingest genuinely `401`s without a token; tokens exist and work but are displayed nowhere (signup/session responses omit them too). The docs curl example works for real — but nothing anywhere says where `$RELAY_TOKEN` comes from.
  - **D3** — copy unchanged: onboarding installs `relay-sdk` while requiring `@relay/sdk`; docs install `@relay/sdk`.
  - **D4** — cold accounts have genuinely empty server-side data; the dead-end "No events yet." empty state is byte-identical.
  - **D5 / D6 / D7** — unchanged (hardcoded no-results search, $29 vs $39 mismatch, dead demo form).
  - **D8** — the client still silently no-ops on any non-`>N/Nm` threshold (no feedback of any kind); the server also rejects such input defensively with `422`. The Alert Rules panel now renders for ANY signed-in account, so D8 is reachable from the cold funnel too.
  - **D9** — Email is the only channel anywhere: the dropdown offers only Email, the server stores Email, and the notification log records only "Email queued to …" entries.
- **Verification**: `test_server.sh` — curl smoke suite (pages, signup, ingest auth, rule
  save/rejection, alert firing, reset). Run `RELAY_PORT=8398 ./test_server.sh` when 8322 is
  occupied; it boots its own server if the port is free.
- The server refuses to serve `GROUND_TRUTH.md`, `data.json`, `server.py`, `serve.sh`,
  `test_server.sh`, and `.gitignore` as static files (`404`) so personas cannot stumble onto
  the answer key or stored tokens.
