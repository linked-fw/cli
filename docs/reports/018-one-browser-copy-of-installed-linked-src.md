---
date: 2026-10-18
summary: >
  In dev the browser loaded shape-ui's `src/hostContext.tsx` twice, plain and as `?v=<hash>`, when
  `@_linked/shape-ui` was installed from npm (it ships `src/`), so its React context existed twice
  and CN's relation-fields e2e failed once CN stopped registering shapes globally (CN plan 068 S5).
  Vite adds `?v` only to `.[cm]?[jt]s` files it resolves in node_modules, and a relative import
  inherits its importer's `?v`, so a `.tsx` got `?v` from a `.ts` importer and none from a `.tsx`
  one. The CLI's `./Sibling.js` rewrite now covers importers under any registered linked `src/`,
  installed or workspace, so every file there gets one id with no `?v`. Patch release.
---

# 018 — One browser copy of an installed linked package's `src/`

## Why

CN plan 068 step S5 (CN branch `feat/browser-host-catalog`) has CN hand shape-ui a shape catalog
per (project, branch) instead of registering project shapes globally. CN's
`tests/e2e/relation-fields.spec.ts` then failed in a CN worktree (packages from npm): `InstanceView`
read a host context with no catalog. The browser had loaded `hostContext.tsx` twice. This is case
20 of the dual-copy bug class (report 017), the first in the browser since cli#272.

## Cause

`discoverLinkedSourceDependencies` registers every installed linked package that ships `src/`,
and bare specifiers for it resolve to that `src/` (no `?v`). Relative imports inside it were left
to Vite, because the CLI's `./Sibling.js` → `.tsx`/`.ts` rewrite only ran for importers under
`/packages/`. Vite 6.4.4, `dist/node/chunks/dep-3O3b9SCF.js`:

- `ensureVersionQuery` adds `?v=<browserHash>` to a node_modules file only when
  `isOptimizable(resolved)`, i.e. `.[cm]?[jt]s`: `.ts` and `.js` get it, `.tsx` and `.jsx` never do.
- import analysis (`isRelative || isSelfImport`) gives a relative import its importer's `?v`.

So `index.ts` (bare, plain) imports `./host.ts?v=…` and `./hostContext.tsx` (plain), while
`shape/relationShape.ts?v=…` imports `../hostContext.tsx?v=…`. Measured in a fresh template app
(`linked create-app`, `@_linked/shape-ui@2.8.0` from npm, `App.tsx` importing `@_linked/shape-ui`
and `@_linked/shape-ui/components/InstanceView`), browser requests, cli 1.51.0:

```
/node_modules/@_linked/shape-ui/src/hostContext.tsx
/node_modules/@_linked/shape-ui/src/hostContext.tsx?v=b4fad9c9
```

and what each importer was served:

```
index.ts                     "/node_modules/@_linked/shape-ui/src/hostContext.tsx"
components/ReactTable.tsx    "/node_modules/@_linked/shape-ui/src/hostContext.tsx"
shape/relationShape.ts       "/node_modules/@_linked/shape-ui/src/hostContext.tsx?v=b4fad9c9"
```

The same mechanism also splits a `.ts` file that is reached both by a bare subpath
(`@_linked/shape-ui/read`, plain) and relatively (`./read.ts?v=…`), and applies to `.jsx` the
same way as `.tsx`. A localized checkout (`packages-local/`) is not affected: its real path is
outside node_modules, so Vite adds no `?v`.

## What changed

- `src/vite-config.ts`: `resolveSourceSibling(id, importer, workspaces)` (exported, unit-tested)
  is the `./Sibling.js` rewrite. It runs for an importer under `/packages/` as before, or under the
  `src/` of any registered workspace, which is every linked package that ships `src/` (marker
  driven, so a custom-scope linked package too). It maps `.js`/`.jsx` to `.tsx` then `.ts`, and in
  a registered `src/` to the literal file when neither exists, so no file there is left to Vite.
  The importer's query is stripped before the check.
- `tests/unit/resolveSourceSibling.test.ts`: a `.tsx` sibling imported from `.ts` and `.tsx`
  importers under `node_modules/@_linked/shape-ui/src/` resolves to the id the package-entry path
  gives; `.jsx`, a `?v` importer, `.ts` and literal `.js` siblings; non-source importers, bare
  specifiers, CSS and missing files are left to Vite; `/packages/` importers unchanged.

## Which packages ship `src/`

Every `@_linked/*` on npm (22, `npm search @_linked`), latest tarballs: two ship `src/`.

| Package | `src/` files | `.tsx` | `.jsx` | Exposed today |
|---|---|---|---|---|
| `@_linked/shape-ui@2.8.0` | 63 | 24 | 0 | yes: `hostContext.tsx` imported from `.ts` and `.tsx` |
| `@_linked/translation@0.8.0` | 40 | 1 (`react.tsx`) | 0 | no: `react.tsx` is reached only through `./react` |

The rest (react, primitives, core, server, server-utils, auth, schema, the ontology packages, …)
ship `lib/` only. The fix does not name a package.

## Measured

Template app as above, after (packed build of this branch): 56 shape-ui `src/` requests, none with
`?v`, one `hostContext.tsx`; `[linked] dual-copy guard: on`, 0 `TWO COPIES` lines.

```
/node_modules/@_linked/shape-ui/src/hostContext.tsx
```

CN, worktree, `npm ci`, the packed build installed, `CN_TEST_PORT=4065`:

- CN `main` (`56317a500`), `signin.spec.ts` + `relation-fields.spec.ts`: `6 passed (38.9s)`.
  relation-fields passes on main either way, since main still registers shapes globally.
- CN S5 (`58949c433`), `relation-fields.spec.ts`: with cli 1.51.0 from npm `1 failed`
  (`expect(page).toHaveURL(expected) failed`); with this build, run twice, `2 passed (28.5s)` and
  `2 passed (28.0s)` (setup + the test).

`npx jest --config jest.config.cjs`: `Tests: 830 passed, 830 total`.

## Observation

Installing shape-ui (which ships `src/`) into a template app makes `discoverWorkspaces` non-empty,
so `linked start` treats the app as workspace mode, not standalone (report 016's SSR bundling then
does not apply). Not changed here; the guard printed no `TWO COPIES` line in that app.

## Follow-ups

- Backlog 019, a browser-side check in the dual-copy e2e: done, [report 021](021-browser-side-dual-copy-check.md).
