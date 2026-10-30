---
date: 2026-10-30
summary: >
  `linked build-app --compile-only` (also `compileViteApp`): compile and check an app's client and
  backend without a release: no file store, no store accessURL, no revision, no manifest. Asked for
  by Create Now's hub-update check (CN backlog 322, plan 311 decision E8).
---

# 046 — `build-app --compile-only`

## Why

Create Now's hub-update check builds an app's clone at a new dependency version to learn whether it
still builds. `build-app` is a release build: a web build resolves the `appAssets` store first (the
client bundle's base URL is under the release prefix) and writes a release manifest that needs the
store's `accessURL`. The check runs sandboxed with none of CN's environment, so it stopped at
`A web release manifest requires the accessURL of the store it will be published to`.

## What changed

- `src/commands/build-app.ts`: the environment load and the client+backend compile are two shared
  steps (`loadBuildEnvironment`, `compileClientAndBackend`). `compileViteApp(options, deps)` runs only
  those: no store, no release identity (so a dirty tree or no revision is fine), no manifest; the
  client bundle gets no base URL. `buildViteApp` is unchanged in behaviour and return type.
- `src/cli.ts`: `build-app --compile-only`. It refuses `--target`, `--publish`, `--revision` and
  `--allow-dirty` by name (`compileOnlyConflicts`) rather than ignoring them.
- `src/index.ts` exports `compileViteApp`.
- README: the flag in both command lists and a paragraph "Compiling is not a release".
- Changeset `build-app-compile-only.md` (minor).

## Phases and validation

1. Implementation and unit tests (`tests/unit/buildApp.test.ts`: order environment → frontend →
   backend with no base and no manifest, with no revision available; backend failure; no backend
   after a frontend failure; the conflict list).
2. E2E (`tests/e2e/build-app.spec.ts`, second test): the scaffolded template app, its manifest
   removed, `npx --no-install linked build-app --compile-only` exits 0, prints the compile-only
   line, never resolves the store, writes `.vite/manifest.json` and no `linked-release.json`.

Results:

```
Test Suites: 103 passed, 103 total
Tests:       1267 passed, 1267 total
Time:        87.496 s
```

```
  ✓  1 tests/e2e/build-app.spec.ts:31:1 › a RemoteDataset app builds with nothing listening on its url (5.7s)
  ✓  2 tests/e2e/build-app.spec.ts:63:1 › build-app --compile-only compiles without a store or a release manifest (7.9s)
  2 passed (30.7s)
```

## Consumer

CN runs it with its own cli (`linkedBin()`), not the clone's npm-installed copy: CN report 322.
