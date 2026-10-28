---
date: 2026-10-25
summary: >
  A directory is a workspace root only when one of its `workspaces` globs matches an existing
  package. An app listing `packages-local/*` with no checkout of its own, nested in a parent
  workspace (webid.email in CN), now resolves the parent's localized `@_linked/*` checkouts as
  source instead of loading two copies of `@_linked/core`. Patch.
---

# 038 — A nested app with an empty `packages-local/*` is not a workspace root

## Why

An app made from the app template declares `"workspaces": ["packages-local/*"]` so it can
localize packages standalone. Run inside CN's workspace (`create_now/packages-local/semantu-webid-email`)
with no `packages-local/` of its own, its dependencies are hoisted to CN's `node_modules`, whose
`@_linked/*` entries are symlinks into CN's `packages-local/_linked-*`. `isWorkspaceRoot` treated
any `package.json` with `workspaces` as a root, so `readInstalledPkg` stopped at the app and never
reached CN's `node_modules`. The Vite plugin registered no linked package as source while Node
walked up to the checkouts, and the app booted with "2 copies of @_linked/core's shape registry".
`linked doctor resolve` from the app printed an empty table; `linked start` watched 1 package.

## What changed

- `src/installed-packages.ts`: `isWorkspaceRoot(dir)` is true only when `hasWorkspaceMembers`
  finds a `<glob>/package.json` that exists and no negation excludes. A missing or empty base
  folder, dot directories (`.repos/`) and folders without a `package.json` do not count.
- `src/lifecycle.ts`: `discoverLocalPackages` (behind `getLincdPackages`, `build-all`) uses the
  same rule when choosing its root, so it climbs past such an app like `readInstalledPkg` does.
- The other root detection already agrees: `findWorkspaceRoot`/`findAppRoot` (localize, worktree,
  branch, release, build-all) climb to a parent whose globs cover the app; `doctor resolve`,
  `discoverWorkspaces` and `start`'s watch list get the fix through `readInstalledPkg`.
- `tests/unit/nestedWorkspaceRoot.test.ts`: an app with no, an empty, a dot-only or a
  manifest-less `packages-local/` inside a parent workspace is not a root, resolves the parent's
  installed package and registers the parent's checkout as source; an app with a checkout of its
  own stays a root; a negated member and an exact-path workspace are covered.

## Gate

- New tests against the old `src/`: `Tests: 18 failed, 3 passed, 21 total`; with the fix all 21 pass.
- `npm run test:unit` (after `npx linked build`): `Test Suites: 91 passed, 91 total`,
  `Tests: 1066 passed, 1066 total`. `npx tsc -p tsconfig-esm.json --noEmit`: exit 0.
- `doctor resolve` from `create_now/packages-local/semantu-webid-email`: the installed CLI prints
  only the header `name  vite  node  bundled  flag`; this branch's built CLI lists 12 `@_linked/*`
  packages, each with `vite` and `node` on the same `_linked-*` checkout and no flag.
- `discoverWorkspacePackages` (the HMR watch list) from the same directory: 1 package before,
  13 after (the app plus its 12 localized dependencies).
- `doctor resolve` from the CN root: output identical before and after.

## Follow-ups

- `doctor resolve` lists names from `<cwd>/node_modules/@_linked` only; a nested app's published
  (non-source) `@_linked/*` dependencies hoisted to the parent are not rows. Not recorded
  elsewhere; minor.

## Rebased onto dev

Written as report 031 against an older base; renumbered 038 because 031 is taken on `dev`.
Rebasing onto `dev` (which by then had `linked.kind`, `unpublishedPackages`, `linked checkout`,
the worktree link farm, c31c7a3's nested-worktree app root and 1078909's hoisted-package
resolution) conflicted only in the import lines of `src/installed-packages.ts` and
`src/lifecycle.ts`; both sides' imports are kept. No logic conflicted: `findWorkspaceRoot`
(c31c7a3) still climbs to a parent whose globs cover the app, and 1078909's walk in
`vite-config.ts` goes through `readInstalledPkg`, so it gets this rule.
The test fixtures marked their packages with the retired `linkedPackage: true`, which `dev` no
longer reads; they now use `linked: {kind: 'library'}`. After the rebase, `npm run test:unit`:
`Test Suites: 99 passed, 99 total`, `Tests: 1158 passed, 1158 total`.

## PR

A directory counts as a workspace root only when one of its `workspaces` globs matches a package
that exists. An app that lists `packages-local/*` with no checkout of its own, nested in a parent
workspace (webid.email inside CN), stopped `readInstalledPkg`'s walk at itself: no `@_linked/*`
package was registered as source while Node loaded CN's checkouts, so the app booted two copies of
`@_linked/core`. `isWorkspaceRoot` now requires an existing, non-negated member
(`hasWorkspaceMembers`), and `discoverLocalPackages` picks its root by the same rule.
`findWorkspaceRoot` already climbed to the parent; `doctor resolve`, the Vite resolver table and
`start`'s HMR watch list are fixed through `readInstalledPkg`.

**Verification**

- `tests/unit/nestedWorkspaceRoot.test.ts` against the old `src/`: `Tests: 18 failed, 3 passed, 21 total`; with the fix: 21 passed.
- `npm run test:unit`: `Test Suites: 91 passed, 91 total`, `Tests: 1066 passed, 1066 total`.
  `npx tsc -p tsconfig-esm.json --noEmit`: exit 0.
- `linked doctor resolve` from `create_now/packages-local/semantu-webid-email`: before, only the
  header row; after, 12 rows such as `@_linked/core  _linked-core  _linked-core  yes` with no flag.
- HMR watch list from the same app: 1 package before, 13 after.
- `linked doctor resolve` from the CN root: identical before and after.

**Deviations:** `discoverLocalPackages` also changed, so the server's `getLincdPackages` and
`build-all` agree with the resolver about the root. **Follow-ups:** `doctor resolve` takes its
names from `<cwd>/node_modules/@_linked` only (report 038, Follow-ups).
