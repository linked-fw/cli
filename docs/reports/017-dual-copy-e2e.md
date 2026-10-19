---
date: 2026-10-18
summary: >
  A CLI e2e now proves that a template app run by the CLI build under test loads one copy of each
  framework package under `linked start`: `tests/e2e/dual-copy.spec.ts` packs this build, installs
  it into an app made from the template, boots it on its committed FusekiStore and with a
  `RemoteDataset` datasets file, and fails on a missing `[linked] dual-copy guard: on` line, any
  `[linked] TWO COPIES` line, or `instanceof RemoteDataset` / `RemoteDatasetUnreachableError`
  being false. No Docker, so CI runs it (`Dual-copy e2e`, on PRs that touch the Vite config,
  `linked start`, the guard or the lockfile, and nightly on main). `create-app.spec.ts` runs this
  build too and makes the same guard check after its Person round-trip. Passes on this build;
  fails with cli 1.50.0 (13 / 8 `TWO COPIES` lines) and 1.48.2 (`instanceof` false). Tests and docs
  only, no release. Replaces backlog 014 and 015.
---

# 017 — The dual-copy e2e

## Why

Under `linked start` a framework module could be evaluated twice, by Vite's SSR module runner and
by Node, so classes failed `instanceof` across the two and module state existed twice. Backlog 015
counted 19 cases of this bug class since June 2026, each fixed on its own path; backlog 014 was the
newest (`instanceof RemoteDataset*` false in a template app, app-template#26). CN plan 068 phase 4
removed the known copies in three releases: the store loader (report 014, cli 1.49.0, core
2.34.0), the guard that prints a line for every file Node loads from a bundled package (report
015, cli 1.50.0), and standalone apps bundling every `@_linked/*` but core and the CLI (report 016,
cli 1.51.0). This step is backlog 015's option B: a test that fails when a CLI change brings a
copy back.

The existing e2e could not have caught any of it: `create-app` clones the template, `npm install`
takes `@_linked/cli` from npm and `npm start` runs that installed CLI, so the e2e tested the
published CLI, not the build under test. It also needs Docker, so CI never ran it.

## What changed

- `tests/e2e/helpers/app.ts` (new): scaffold with this build (`create-app --skip-install`), `npm
  install`, then `npm pack` of this checkout installed on top (`E2E_CLI=<npm spec>` installs that
  instead, e.g. a published version); `npm start` in its own process group with stdout and stderr
  collected together (the status line is `console.log`, `TWO COPIES` is `console.warn`; ANSI
  colours stripped, since Playwright sets `FORCE_COLOR`); the guard's lines parsed out.
- `tests/e2e/dual-copy.spec.ts` (new), no Docker, no Fuseki, no browser. Every boot sets
  `FUSEKI_BASE_URL=http://127.0.0.1:9` (nothing answers, no dataset is created anywhere).
  1. *The committed FusekiStore app boots and renders `/`*: waits for `GET /` and
     `GET /src/index.tsx` to answer, needs `[storage] appData: FusekiStore`, exactly one guard
     status line, `on`, and no `TWO COPIES` line.
  2. *A RemoteDataset `appData` is the class the app imports, and so is its error*: the datasets
     file names `@_linked/server/shapes/quadstores/RemoteDataset` at `http://127.0.0.1:9`; a probe
     put before the template's own `init()` prints `appData instanceof RemoteDataset` and, after
     a failed `appData.init()`, `err instanceof RemoteDatasetUnreachableError`. Both must be
     `true`, the boot must exit non-zero with the template's message ("Could not reach the data
     server at http://127.0.0.1:9") and no raw stack, with the guard `on` and no `TWO COPIES`.
- `tests/e2e/create-app.spec.ts`: uses the helper, so the Person round-trip runs this build; after
  it, the same guard assertions (Docker, local only, as before).
- `.github/workflows/dual-copy-e2e.yml` (new), job `Dual-copy e2e`: on every PR to main, nightly
  (`23 3 * * *`) and on demand. On a PR it boots the app only when the diff touches
  `src/vite-config.ts`, `src/commands/start.ts`, `src/utils/ssrBundled.ts`,
  `src/utils/dual-copy-guard.ts`, `package-lock.json`, `tests/e2e/`, `playwright.config.ts` or the
  workflow; otherwise it passes at once. It always reports, so branch protection can require it
  (a skipped job never reports and would block every PR, the release PR included). Node 24.21.0
  (the shared PR workflow's), the npm in `packageManager`, `npm ci`, `npm run build`, the spec.
- Backlog 014 and 015 removed (this report replaces them; their last text is at
  [`b013598`](https://github.com/linked-fw/cli/blob/b013598/docs/backlog/015-one-copy-of-each-framework-package.md)).
  The code comments that cited them cite reports 014, 016 and 017; backlog 017 links the old text.
- Backlog 018 (new): `build-app` needs the data server, found in app-template#27.
- README ("Two copies of a framework package") and the Playwright config header describe the e2e.

## Measured

Node v22.23.3, npm 12.2.0, app-template `main` `15f109b` (app-template#27: `instanceof` again,
core resolved 2.35.0).

**This build** (`npx playwright test --config playwright.config.ts`, Docker up for
`create-app.spec.ts`):

```
  ✓  1 tests/e2e/create-app.spec.ts:114:1 › Person fixture: add → edit → delete round-trip (2.5s)
  ✓  2 tests/e2e/dual-copy.spec.ts:67:1 › the committed FusekiStore app boots and renders / with one copy of each package (6.0s)
  ✓  3 tests/e2e/dual-copy.spec.ts:85:1 › a RemoteDataset appData is the class the app imports, and so is its error (1.6s)
  3 passed (53.4s)
```

with `[linked] dual-copy guard: on` once per boot (3 boots) and
`[probe] appData instanceof RemoteDataset: true`,
`[probe] init() error instanceof RemoteDatasetUnreachableError: true`.

**cli 1.50.0** (guard, no standalone bundling; `E2E_CLI=@_linked/cli@1.50.0`), both fail:

```
  ✘  1 tests/e2e/dual-copy.spec.ts:67:1 › the committed FusekiStore app boots and renders / with one copy of each package (6.0s)
  ✘  2 tests/e2e/dual-copy.spec.ts:85:1 › a RemoteDataset appData is the class the app imports, and so is its error (3.3s)
    Error: 13 TWO COPIES line(s):
    Error: 8 TWO COPIES line(s):
  2 failed
```

the first of them:

```
[linked] TWO COPIES: Node loaded @_linked/react/lib/esm/utils/LinkedComponent.js (imported as "@_linked/react/utils/LinkedComponent" from file:///…/node_modules/@_linked/schema/lib/esm/package.js), but @_linked/react is bundled for the Vite SSR runner. Classes from it will fail `instanceof` and its module state exists twice.
```

13 and 8 are report 016's "before" counts. `instanceof` is already true with 1.50.0 (the loader
is 1.49.0's).

**cli 1.48.2** (no loader, no guard; `E2E_CLI=@_linked/cli@1.48.2`, RemoteDataset test):

```
[probe] appData instanceof RemoteDataset: false
[probe] init() error instanceof RemoteDatasetUnreachableError: false
RemoteDatasetUnreachableError: RemoteDataset: cannot reach the data server at http://127.0.0.1:9 (ping): fetch failed
  ✘  1 tests/e2e/dual-copy.spec.ts:85:1 › a RemoteDataset appData is the class the app imports, and so is its error (3.4s)
    Expected substring: "[probe] appData instanceof RemoteDataset: true"
```

the raw stack backlog 014 started from. The published 1.51.0 is this build's code, so
`E2E_CLI=@_linked/cli@1.51.0` passes; the failing runs pin the releases before.

Unit tests: 74 suites, 825 passed. CI: the PR's `Dual-copy e2e` run is quoted in its Outcome.

## The bug class, for the record

From backlog 015 (full table and ranking at `b013598`). The 19 cases had five recurring causes:
two loaders in dev SSR (Vite's runner and Node), Vite's dependency optimizer, a workspace or
localized copy next to an installed one, inlining at build time, and HMR re-evaluation. Options:
A the guard (report 015), B this e2e, C standalone bundling (report 016), D package conventions
that make a copy harmless (done, [report 020](020-shared-state-and-error-brands.md)), E a per-package copy marker (not planned;
waits for a browser or production case that cli#272 and cli#177 do not catch). Case 17 (a), the
webid.email `LinkedEmail` provider, is gone with C and a core 2.34.0+ floor (report 016).

What the guard and this e2e do not see: the browser, a built app, and the optimizer's copies.

Case 20, 2026-10-18, browser (CN plan 068 S5): an installed linked package's `src/` `.tsx` loaded
plain and with `?v`, two React contexts in shape-ui. Fixed in [report 018](018-one-browser-copy-of-installed-linked-src.md); the browser check is
[report 021](021-browser-side-dual-copy-check.md).

## Follow-ups

- Backlog 017, framework conventions (option D): done, [report 020](020-shared-state-and-error-brands.md).
- Backlog 018, `build-app` loads every store and needs the data server: done, [report 020](020-build-app-needs-no-data-server.md).
- The `Dual-copy e2e` check is added to `main`'s required checks once it has passed on this PR.

## PRs

- https://github.com/linked-fw/cli/pull/279 (backlog 014, a second copy of datasets-file stores)
- https://github.com/linked-fw/cli/pull/281 (backlog 014 fix chosen; backlog 015, one copy of each framework package)
- https://github.com/linked-fw/cli/pull/290 (the e2e)
