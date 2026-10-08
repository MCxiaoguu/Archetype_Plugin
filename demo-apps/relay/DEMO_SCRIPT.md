# Relay Demo Script — "Same funnel, two verdicts"

Three acts, ~2 minutes total. All names, verdicts, quotes, and screenshots are
REAL — produced by the 2026-08-27 comparison run (runs `e28b20a8…` and
`a4e56b3a…`, verified end-to-end against MongoDB). Artifacts live in
`e2e/artifacts/` (⚠ prune personal windows from some captures before public
use — see checklist at bottom).

---

## Cold open (5 s)

> "This is Relay — an API monitoring startup. It looks ready to ship. Every
> link works, every test passes. It's about to fail with both of its target
> customers — in two completely different ways — and I can prove it."

**Screen:** Relay landing (localhost:8322), slow scroll over hero + uptime bars.
*(Artifact: `relay_chrome_1787888928.png` — landing with the debug banner.)*

## Act 1 — The setup (25 s)

> "Six pages: landing, docs, pricing, signup, onboarding, dashboard. I planted
> seven real-world defects — the kind that never throw errors: a pricing
> contradiction, a quickstart that skips a step, a dead-end dashboard.
> Analytics shows you *that* people drop off. Never *why*."

> "Relay has two buyers who will never see the same product: the staff
> engineer who tries it at 11pm after an outage, and the engineering manager
> comparing vendors line by line. In Claude Code, I described each in one
> sentence. Archetype built two **pools** — distributions of those segments,
> zero members each. Testers are spun off fresh from the distribution at run
> time."

**Screen:** `/archetype:persona` dashboard — `Night-Shift Engineers · 0
members`, `Pragmatic Managers · 0 members`.

## Act 2 — Same goal, opposite verdicts (45 s)

> "One command, one identical goal for both pools: *decide whether you'd
> adopt Relay — sign up and get your first event flowing.* Two testers are
> spun off: **Bartholomew Zwick**, night-shift engineer. **Elias Faulkner**,
> pragmatic manager. Neither existed ninety seconds ago. Both drive a real
> Chrome."

> "Zwick hit the signup page, saw card fields under a homepage that promised
> 'no credit card required' — and *refused to enter one*. In character. He
> measured the locked front door: 13 steps, verdict **MIXED**.
> Faulkner paid with a dummy card and audited the factory floor: the docs
> want a `RELAY_TOKEN` that no page ever provisions, the install command and
> the code snippet name two different packages, the dashboard is a dead end.
> 19 steps, 9 findings, verdict **FAIL**."

> "The engineer never saw the pricing bug. The manager never respected the
> front door. Segments fail differently — that's the insight a funnel chart
> can't give you."

**Screen:** the coverage matrix (the money slide):

| Planted defect | Zwick (engineer, MIXED) | Faulkner (manager, FAIL) |
|---|---|---|
| D1 card required vs "no credit card" | **FOUND** — "reads as bait-and-switch" | **FOUND** |
| D2 `RELAY_TOKEN` never provisioned | not reached (refused the card) | **FOUND** — "no token is displayed anywhere — not during onboarding, not in Settings" |
| D3 `relay-sdk` vs `@relay/sdk` | not reached | **FOUND** — "would produce a require error" |
| D4 dead-end empty dashboard | not reached | **FOUND** — "no calls to action, no links back to setup" |
| D5 docs search always empty | **FOUND** | **FOUND** — "even though an 'Uptime checks' guide exists in the sidebar of the same page" |
| D6 $29 vs $39 per seat | not reached | **FOUND** |
| D7 annual behind Book-a-demo | missed | missed — *neither buyer bothered to book a demo, which is itself a finding* |

**Credibility beat:** "6 of 7 planted defects found, mapped against a written
answer key (`GROUND_TRUTH.md`) — plus five *true* findings I hadn't planted
(the Sign-in link literally pointed at signup; the docs referenced a Settings
tab that doesn't exist). One probable automation artifact, flagged as such.
This was a controlled experiment, not a vibe check."

*(Artifacts: `relay_chrome_1787889408.png` — signup card fields; verify
checklists `[1]–[6]` ALL PASS ×2; `relay_comparison_report.md`.)*

## Act 3 — Real product, real preconditions (35 s)

> "Two upgrades make this fully authentic. First: Relay isn't a stage set —
> it's a working product. Real accounts, a real ingest API with token auth,
> rules that really evaluate and fire. Second: I don't script the tester.
> I give a goal and a **precondition** — context the tester *bears*:
> *'you run your own suite of production endpoints for your team's
> project.'* Nobody tells them what those endpoints are. They know,
> because they're a person with a job."

> "**Leonard Underwood**, spun from the managers pool, signed up with an
> email he invented at a company he invented — `l.underwood@ferrodyne-mfg.com`
> — and it created a *real* account on the server. Then reality bit, for
> real: no page ever shows the API token, so his events list stayed
> genuinely empty. He tried to save an alert rule; the button silently
> dropped it — the server holds no rule for him. His verdict: **FAIL** —
> *'the product is a shell… it cannot ingest, cannot alert, and cannot
> report.'*"

> "(A night-shift engineer, Ulric, got the same precondition and showed up
> talking about monitoring 'my **auroria** production endpoints' and his
> 'last k3s node OOM' — none of which exists anywhere in the site copy or
> his persona file. Preconditions turn testers into people with lives.)"

**Screen:** the server's `data.json` showing Leonard's real account with
empty events/rules, next to his narration; the docs' curl example that
would have worked — with the token he could never find.
*(Run `2fae80b97aaf4b74874937c9c4bc41a9`, 18 steps, 9 findings, verify
[1]–[6] ALL PASS. Preconditions run: `1feaa8ffc23c443b8a383f6d4d3dd4c0`,
Ulric Darnell.)*

## Kicker (10 s)

> "Every run grows the pools — Night-Shift Engineers has 3 members now,
> Pragmatic Managers 2, each a distinct person from the same distribution.
> Fix the token page, re-run, watch the verdict flip. No recruiting, no
> scheduling, no gift cards — in the terminal you already live in."

---

## Real-run reference data

- Sub: `auth0|690fba08a182d00e0c60fd31`
- Night-Shift Engineers `86ef5416f2f34776a9e107381738c3e1` → run
  `e28b20a88aa14301adb82fc23550e392`, member Bartholomew Zwick, 13 steps,
  5 findings, MIXED
- Pragmatic Managers `0d76d062d013492d809f0d43af8eff99` → run
  `a4e56b3a8e78477597dcff83b473e672`, member Elias Faulkner, 19 steps,
  9 findings, FAIL
- Debug credential (Act 3): `founder@relay.dev` / `relay-debug-2026`
- Answer key: `GROUND_TRUTH.md` (D1–D7 cold funnel; D8–D9 authenticated)

## Pre-publish checklist

- [ ] Prune/blur captures containing personal windows (WeChat, CalCentral —
      e.g. `relay_chrome_…9001/…9539/…9594.png`)
- [ ] Fill Act-3 placeholders from the authenticated run
- [ ] Re-record any beat where the raw capture is occluded
