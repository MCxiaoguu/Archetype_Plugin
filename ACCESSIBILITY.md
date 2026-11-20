# Accessibility

Conformance target: **WCAG 2.2 Level AA**.

## What this covers

- The Figma plugin panel UI (`figma/src/ui`), exercised through the local harness
  (`npm run harness` in `figma/`) across sign-in, new test, progress, report, history,
  settings, and notice toasts in light and dark themes.
- The static demo apps under `demo-apps/relay` and `demo-apps/lumina-notes`, which the
  plugin uses as study targets.

## How it was tested

- axe-core (WCAG 2.0/2.1/2.2 A+AA tags) in headless Chrome at 1440×900, 390×844, and
  320×800 on every reachable harness scenario and demo page state.
- Manual keyboard walks, accessibility-tree name/role checks, focus visibility, dialog
  Escape/focus restore on the Relay demo modal, and reflow at 320 px.

## Known limitations

- The plugin UI runs inside Figma’s iframe; host chrome outside that iframe is not under
  this repo’s control.
- Device-code sign-in opens the Archetype portal in the system browser; that portal is a
  separate product surface.

## Reporting a barrier

Open an issue on this repository describing the page or panel state, the assistive
technology you use, and what you expected to happen.
