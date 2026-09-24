---
summary: >
  The unit suite does not run. Every suite that touches `@_linked/*` dies in configuration, because
  `moduleNameMapper` expects those packages under `packages/cli/node_modules` while the workspace
  hoists them to the repo root. Nothing here is verified by tests today.
---

# 002 — The unit suite cannot resolve `@_linked/*`

**Status:** open. Not caused by any recent change — it fails identically on `main`.

## The failure

```
● Test suite failed to run

  Configuration error:

  Could not locate module @_linked/core/utils/LinkedFileStorage mapped as:
  /Users/…/packages/cli/node_modules/@_linked/core/lib/esm/$1.js.
```

Five suites die this way: `buildApp`, `publisher`, `appAssetsStore`,
`createApp.reactNative`, `esmSpecifiers`. They fail **in configuration**, before a single assertion
runs, so the suite reports failures that say nothing about the code.

## Cause

`jest.config.cjs` maps `@_linked/<pkg>/<path>` to
`<rootDir>/node_modules/@_linked/<pkg>/lib/esm/<path>.js`. That path does not exist: the workspace
hoists `@_linked/*` to the **repo root** `node_modules`, where they are symlinks to `packages/*`.
`packages/cli/node_modules` has no `@_linked` directory at all.

This is the same local-vs-published divergence recorded in
[report 041](../../../docs/reports/041-compile-integrity-and-the-label-round-trip.md): a
configuration that is correct for one resolution model and silently wrong for the other. Here the
consequence is not a wrong answer but **no answer** — the tests never execute.

## Why it matters more than it looks

`npm run build` passing is currently the **only** evidence that a change to this package is safe.
That was the position when ten unreferenced dependencies were removed (`chore: drop ten
declared-but-unreferenced dependencies`): the removals were justified by reference counting across
`src/`, `tests/`, `defaults/`, every config file and every npm script, and confirmed by a clean
build and a clean `npm ci` — but **not** by the test suite, because it cannot run.

That is a reasonable bar for a dependency removal. It is not a reasonable bar for a behavioural
change to a package that builds and publishes every other package.

## Fix directions

Unverified; the resolution model needs deciding rather than patching:

1. **Point the mapper at the root** — `<rootDir>/../../node_modules/@_linked/…`. Smallest change,
   but it hard-codes the workspace layout into the package's own test config, which then breaks
   when the package is checked out on its own (it is a standalone repo).
2. **Resolve through Node rather than a hand-written map.** The packages have `exports` maps; if
   jest can be made to honour them, the mapper can go entirely. Most robust, most fiddly.
3. **Map to `src/` rather than `lib/esm/`.** Tests would then exercise source instead of build
   output, which is arguably what a unit test should do — and would stop the suite depending on a
   prior build.

Option 3 deserves the most thought: several failures in this ecosystem have come from a stale
`lib/`, and a unit suite that reads `src/` cannot have that problem.
