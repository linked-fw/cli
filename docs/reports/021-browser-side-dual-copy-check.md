---
date: 2026-10-19
summary: >
  The dual-copy e2e now checks the browser: with `@_linked/shape-ui` installed (it ships `src/`),
  headless Chromium loads the template app's `/` and the spec fails when any `@_linked/*` script
  module is requested in two forms (plain and `?v=`, two paths, or Vite's optimizer and file by
  file), naming every URL. Fails on cli 1.51.0 with shape-ui 2.8.0 (`hostContext.tsx` plain and
  `?v=b6fce5a8`, report 018's case 20); passes on main. CI installs Chromium in the `Dual-copy
  e2e` job. Tests and docs only, no release. Replaces backlog 019.
---

# 021 — A browser-side dual-copy check

## Why

Report 017's `tests/e2e/dual-copy.spec.ts` read only the boot's output, which covers Node loading
a file the SSR runner bundles. The browser has its own ways to get two copies: Vite's optimizer
(cli#272) and the `?v` split of report 018 (case 20, two React contexts in shape-ui). Nothing in
the CLI's tests loaded a page in a browser, so case 20 was found by CN's e2e, not here.

## What changed

- `tests/e2e/helpers/moduleCopies.ts` (new): `linkedModuleCopies(urls)` keys every requested
  `@_linked/*` script module (`.[cm]?[jt]sx?`) by its innermost package and path
  (`…/node_modules/@_linked/<name>/<rest>`, or a localized `…/_linked-<name>/<rest>` under
  `/@fs/`) and returns those requested in more than one form, ignoring the HMR `t` param. A package
  served from `/.vite/deps/_linked_<name>…` and also file by file is reported too. CSS and
  non-linked modules are ignored.
- `tests/e2e/dual-copy.spec.ts`: a third test, after the two boots. It restores the files the
  RemoteDataset test rewrote, `npm install`s `@_linked/shape-ui` (`latest`, so a new `src/` layout
  is seen; `E2E_SHAPE_UI=<version>` pins one, which answers the backlog's open question), prepends
  `import '@_linked/shape-ui'` and `import '@_linked/shape-ui/components/InstanceView'` to
  `src/App.tsx`, boots the app and loads `/` with Playwright's `page` (`networkidle`), recording
  every request. It needs at least one request under shape-ui's `src/` (else the check has nothing
  to look at), no module in two forms, and the guard's `on` line with no `TWO COPIES`. The two
  existing tests run before shape-ui is installed, so they still see a standalone app (report
  018's observation: a package that ships `src/` makes `linked start` treat the app as workspace
  mode).
- `.github/workflows/dual-copy-e2e.yml`: `npx playwright install --with-deps chromium` before the
  spec.
- `tests/unit/linkedModuleCopies.test.ts` (8 tests): plain and `?v`, one form requested twice,
  the `t` param, two paths, a nested `node_modules` copy, optimizer plus files, optimizer only,
  ignored URLs.
- README ("Two copies of a framework package"), the Playwright config header and the workflow
  header describe the browser check.

## Measured

Node v22.23.3, npm 12.2.0, app-template `main` (`cd5cbdb`), `npm run build && npx playwright
test --config playwright.config.ts tests/e2e/dual-copy.spec.ts tests/e2e/build-app.spec.ts`.

**This build** (main, cli 1.52.0 code), shape-ui latest (2.8.0):

```
  ✓  1 tests/e2e/build-app.spec.ts:30:1 › a RemoteDataset app builds with nothing listening on its url (6.4s)
  ✓  2 tests/e2e/dual-copy.spec.ts:79:1 › the committed FusekiStore app boots and renders / with one copy of each package (7.2s)
  ✓  3 tests/e2e/dual-copy.spec.ts:97:1 › a RemoteDataset appData is the class the app imports, and so is its error (2.3s)
[e2e] 2220 requests, 55 from shape-ui's src/ (@_linked/shape-ui@latest)
  ✓  4 tests/e2e/dual-copy.spec.ts:158:1 › the browser loads one copy of each @_linked module, with a package that ships src/ (13.5s)
  4 passed (57.3s)
```

**cli 1.51.0** (before report 018's fix), `E2E_CLI=@_linked/cli@1.51.0 E2E_SHAPE_UI=2.8.0`, the
dual-copy spec:

```
[e2e] 2219 requests, 56 from shape-ui's src/ (@_linked/shape-ui@2.8.0)
  ✘  3 tests/e2e/dual-copy.spec.ts:158:1 › the browser loads one copy of each @_linked module, with a package that ships src/ (11.0s)
    Error: 1 @_linked module(s) loaded in more than one form:
    @_linked/shape-ui/src/hostContext.tsx
      /node_modules/@_linked/shape-ui/src/hostContext.tsx
      /node_modules/@_linked/shape-ui/src/hostContext.tsx?v=b6fce5a8
  1 failed
  2 passed (30.5s)
```

the two URLs report 018 measured by hand (its hash was `b4fad9c9`, the optimizer's browser hash
differs per install). The guard tests pass on 1.51.0, as in report 017.

`npx jest --config jest.config.cjs`: `Tests: 845 passed, 845 total`. CI: quoted in the PR's
Outcome.

## Follow-ups

- None. A built app (production bundle) is still not checked in a browser; no case there yet.

## PRs

- https://github.com/linked-fw/cli/pull/300
