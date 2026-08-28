# Relay — Demo Ground Truth (Answer Key)

Relay is a dummy dev-tool startup (API monitoring & incident timelines) built for Archetype
validation demos. It is intentionally polished everywhere **except** for seven planted defects.
These are the findings personas SHOULD surface. Anything not listed here is expected to work.

Serve locally: `sh serve.sh` → http://localhost:8322

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
- The onboarding "Waiting for your first event…" spinner never resolving is by design
  (no backend exists); on its own it is scaffolding for D4/D3, not a separate defect.

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
- **Debug credential**: `founder@relay.dev` / `relay-debug-2026`. Successful sign-in seeds
  localStorage (`relay:user`, `relay:events`, `relay:incidents`, `relay:alert-rules`) with:
  - Account **Dana Founder**, plan **"Pro trial — 14 days left"** — shown in the dashboard
    header tag, the sidebar user meta, and Settings → Plan.
  - **12 events** across 3 endpoints (`checkout-api`, `auth-api`, `webhooks`) with
    timestamps, latencies, and status codes — rendered in the Events table.
  - **One open incident** — "Elevated 5xx on checkout-api" — with a 4-entry timeline,
    rendered under Incidents (table row + timeline card).
  - **One alert rule** — `checkout-api  >1% 5xx / 10m  → Email` — listed under Alerts.
- **Alert Rules surface** (debug account only): the Alerts tab gains the rule list plus a
  "New alert rule" form — endpoint selector (populated from the seeded endpoints), threshold
  input, notification-channel dropdown, and a Save button. Saved rules append to the list
  and persist. Sign out clears the seeded data along with the session.
- For **non-debug accounts** (i.e. anyone from the cold signup funnel) none of this renders:
  the Events/Incidents/Alerts tabs stay exactly as bare as D4 describes.

### Additional planted defects (debug mode only)

| ID | Defect | Where |
|----|--------|-------|
| D8 | The alert-rule **threshold input only accepts the cryptic format `>N/Nm`** (e.g. `>500/5m`). There is no placeholder, no hint, and no error message — with any other format the Save button clicks and silently does nothing. | `dashboard.html` — `#rule-threshold` inside `#alert-rules-panel` (Alerts tab, debug account). Silent validation in `app.js` ("Alert rules" block: `/^>\d+\/\d+m$/` guard returns without feedback). |
| D9 | The **notification-channel dropdown offers ONLY "Email"**, while the landing page promises "Alerts route to Slack, PagerDuty, or plain webhooks" (How-it-works step 03) and pricing lists "Slack, PagerDuty & webhook alerts". | `dashboard.html` — `#rule-channel` inside `#alert-rules-panel` (single `<option>Email</option>`). Contradicts `index.html` step 03 and `pricing.html` Pro features. |
