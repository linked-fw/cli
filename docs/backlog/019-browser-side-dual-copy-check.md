---
summary: >
  The dual-copy e2e (report 017) checks only the SSR side, with no browser. Report 018's case (a
  `.tsx` module of an installed linked package that ships `src/` loaded twice in the browser, plain
  and with `?v`) would not have been caught. Add a browser check: install a package that ships
  `src/` into the template app, load `/` headless and fail when any module URL is requested twice
  modulo its `?v` query.
status: Open -- found by CN plan 068 step S5 (report 018); not scheduled
---

# 019 — A browser-side dual-copy check

## Why

Report 017's `tests/e2e/dual-copy.spec.ts` boots a template app and reads the guard's `TWO COPIES`
lines, which cover Node loading a file the SSR runner bundles. The browser has its own ways to get
two copies (Vite's optimizer, cli#272; the `?v` split in report 018), and nothing in the CLI's
tests loads the page in a browser.

## Sketch

1. In the dual-copy spec's FusekiStore boot, also `npm install @_linked/shape-ui` (the one
   `@_linked/*` today with `.tsx` in `src/` imported from `.ts` and `.tsx`) and import its entry
   and `components/InstanceView` from the template's `App.tsx`.
2. Load `/` with Playwright's Chromium (the CLI already depends on `@playwright/test`), collect
   every request URL, strip `?v=…`/`?t=…`, and fail on any path requested with two different
   queries, naming both.
3. CI: Chromium must be installed in the `Dual-copy e2e` job (`npx playwright install chromium`).

Report 018 measured the check by hand: cli 1.51.0 requests `hostContext.tsx` and
`hostContext.tsx?v=b4fad9c9`; the fix requests it once.

## Open questions

- Pin shape-ui in the spec, or take the latest so a new `src/` layout is seen?
