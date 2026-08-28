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
