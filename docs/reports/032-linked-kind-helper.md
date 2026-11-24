---
date: 2026-10-27
summary: >
  One helper, `linkedKind(json)` (`@_linked/cli/installed-packages`, twin in
  `@_linked/server/utils/linkedDependencies`), decides what a `package.json` is from
  `linked.kind` (`app`, `ontology`, `assets`, `library`); every reader in the CLI, the server and
  the host app uses it and none reads `linkedPackage` / `linkedApp`, except the app's reader of an
  app clone's npm-installed packages until the release. Scaffolds and both app identity stampers
  write `linked.kind`. A step of the host app's plan; landed with report 033. Minor.
---

# 032 — `linked.kind` through one helper

## PR

### Summary

What a package is comes from `"linked": {"kind": …}` alone. `linkedKind(json)` returns
`'app' | 'ontology' | 'assets' | 'library' | undefined`; a linked package is any kind but `app`
(`isLinkedPackageJson`, now defined on top of it). `linkedPackage: true` and `linkedApp: true` are
no longer read. Everything the CLI and the host app scaffold writes the kind. Landed back to back
with report 033, which gave every `package.json` of the app's tree its kind.

### Changes

- **cli** `src/installed-packages.ts`: `LinkedKind`, `LINKED_KINDS`, `linkedKind`;
  `isLinkedPackageJson` = kind set and not `app`. Readers switched: `lifecycle.ts` (`isApp`,
  build-all), `cli-methods.ts` (`linked build` guard and its messages), `client-dep-includes.ts`
  (both checks), `utils/shapeHierarchy.ts` (the `@_linked/` scope fallback is gone: no test needed
  it), `localize/app-root.ts` (field renamed `isPackage`), `utils/createPackageLocation.ts`
  (`findLinkedAppRoot` → kind `app`), `commands/build-package.ts`; comments in `vite-config.ts`.
- **cli** writers: `defaults/package/package.json` → `"linked": {"kind": "assets"}`;
  `buildPackageFiles` merges `kind` (`ontology` / `assets`) into the template's `linked` object;
  react-native template `packages/app-shapes` → `assets`, `services/api` → `app`;
  `applyAppIdentity` drops a template's `linkedApp` and merges `linked.kind: "app"`.
- **server** (report 020): the twin helper, boot loading by kind, `discoverLinkedDependencies`
  takes an optional `isLinked` test.
- **the host app**: its app identity stamper drops `linkedApp`, merges `linked.kind: "app"`, refuses
  a template whose kind is set and not `app`; its reader of an app clone's packages accepts
  `linked.kind` or `linkedPackage: true` (master decision, below); its tests; its architecture docs
  and a how-to name `linked.kind`.
- Tests: new `tests/unit/linkedKind.test.ts`; `packageFiles` keeps an existing `linked` key;
  `createApp.identity` turns `linkedApp: true` into the kind; every fixture and test that wrote
  the old flags writes `linked.kind`. `tests/template/package.full.test.ts` now replaces the
  scaffold's installed CLI `lib`/`hooks` with this repo's, as the react-native one already did.
- README §Package kinds (was §Package flags) and the create-package/build sections.
- Contract K-kind (sub-plan 002 and the host app's plans) records the helper's path, the twin and
  the optional `isLinked` argument.

### Verification

Run in a worktree with report 033's change applied, rebased on `dev`.

- Verify grep (`\.linkedPackage\b|linkedPackage ?(===|:) ?true|"linkedPackage"|linkedApp`) in
  cli `src defaults`, server `src` (outside tests) and the host app's `src` (outside tests): only
  comments that say the old field is not read, the two stampers' `delete pkg.linkedApp`, and the
  app's clone-package reader's fallback with its comment.
- cli `npm run test:unit` (rebased on the latest core change): `Test Suites: 92 passed, 92 total` /
  `Tests: 1081 passed, 1081 total`, 56 s.
- cli `npm run test:template`: `Test Suites: 2 passed, 2 total` / `Tests: 22 passed, 22 total`,
  1:22.
- cli `npx linked build`: `✔ Build successful`, 8 s.
- server: see report 020 (one test known to fail on `dev` since a core change).
- The host app: see report 033 (its typecheck gate and its regular test set).
- `planBuildAll` / `getLincdPackages` / `discoverLinkedDependencies` over the worktree list the
  same 27 / 27 / 26 packages as the main checkout before landing (old flags, old CLI).

### Deviations

- **The host app's npm fallback** (master decision): `discoverLinkedDependencies(appDir, pkg,
  isLinked?)` gained an optional third parameter; only the app's clone-package reader passes one, accepting
  `linkedPackage: true` too. The server itself reads only the kind.
- **Twin by comment**, not by test: the copies are byte-identical between `// linkedKind: twin of
  …` and `// end of the linkedKind twin.` markers. A cross-repo source-text test could only run in
  the app's tree (CI checks out one repo).
- The stampers name `linkedApp` once each, to delete it from a template that still carries it.
- `shapeHierarchy.ts`'s `name.startsWith('@_linked/') ||` fallback removed: neither the unit
  suite nor `test:template` (which builds against npm-installed `@_linked/*`) needed it.
- Until the release, a package scaffolded by this CLI cannot be built by the published CLI its
  `devDependencies` install (that one requires `linkedPackage: true`); hence the
  `package.full` test change. Ends with the release.

### Follow-ups

- Remove the `linkedPackage` fallback in the host app after the release republishes every
  package — recorded in the app's plan.
- The worktree link farm points the app's own workspace members at the main checkout — cli
  backlog 011.

## Details

- `linkedKind` reads only `json.linked.kind` and accepts the four strings; anything else (no
  `linked`, a non-object, a number, an unknown string, the old flags) is `undefined`.
- `buildPackageFiles` now always re-serialises `package.json` (`JSON.stringify(…, null, 2)`);
  the template is already in that form, so `create-package`'s output is unchanged apart from the
  kind.
- `create-app` keeps working with today's published `linked-fw/app-template`
  (`linkedApp: true`): the stamp turns it into the kind. The template's own change is report 033's.
