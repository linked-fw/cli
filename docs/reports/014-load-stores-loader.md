---
date: 2026-10-18
summary: >
  `linked start` installs the module loader core's `loadStores` reads from
  `globalThis[Symbol.for('@_linked/core:importModule')]`: a store whose package the dev
  `ssr.noExternal` bundles loads through `vite.ssrLoadModule`, any other through Node at the file
  Vite's SSR resolver returns. With a core that reads the loader, a template app's
  `RemoteDataset` datasets file gives `instanceof RemoteDataset` and
  `instanceof RemoteDatasetUnreachableError` true, and the FusekiStore file keeps
  `instanceof FusekiStore` true; a core that ignores it boots as before. CLI half of backlog 014's
  fix (CN plan 068 phase 4, step D1b). Minor release.
---

# 014 — `linked start` installs the `loadStores` loader

## What changed

- `src/utils/ssrBundled.ts`: `packageNameOf(specifier)` (`@scope/name/sub` → `@scope/name`,
  `name/sub` → `name`) and `isBundled(name, noExternal)` (a string entry is equal, a RegExp entry
  tests the name), matching the way Vite tests `ssr.noExternal` against the package name only.
- `src/commands/start.ts`: `createStoreLoader(vite, cwd)` returns the loader; `startWithVite`
  sets it at `STORE_LOADER_KEY` (`Symbol.for('@_linked/core:importModule')`) right after the Vite
  server is created and configured, before the storage file loads. Bundled package (or
  `noExternal === true`): `vite.ssrLoadModule(specifier)`. Otherwise:
  `vite.environments.ssr.pluginContainer.resolveId(specifier, <cwd>/index.js)` and Node's
  `import()` of that file URL, falling back to the bare specifier when the resolver returns
  nothing. The two branches are why the measured spike row "ssrLoadModule for every store" is not
  what ships: it made a Vite copy of the external `FusekiStore`.
- A restart under `linked start` respawns the process, so the loader always closes over the live
  server.
- Unit tests: `tests/unit/storeLoader.test.ts` (fake `vite`: bundled → `ssrLoadModule`;
  external → `resolveId` and Node, never `ssrLoadModule`; `noExternal: true` → everything to
  `ssrLoadModule`; null resolve → bare specifier; missing, single-string and single-RegExp
  `noExternal`), `tests/unit/ssrBundled.test.ts`.
- Docs: backlog 014's status, backlog 017 (package conventions, not scheduled).

## Measured

Template app from app-template `main`, created with this build
(`node lib/esm/launch.js create-app probe … --skip-install`), `npm install`, then
`npm install <this build's npm pack tarball>`. The storage file was given a probe after
`loadStores`: `appData instanceof RemoteDataset`, `appData instanceof FusekiStore`, and for a
`RemoteDataset`, `init()` against `http://127.0.0.1:9` and `err instanceof
RemoteDatasetUnreachableError`, each against the storage file's own import.

| core `loadStores` | datasets file | output |
|---|---|---|
| 2.33.0 as published (ignores the loader) | RemoteDataset | `[probe] instanceof RemoteDataset false, instanceof FusekiStore false`; `[probe] instanceof RemoteDatasetUnreachableError false (RemoteDatasetUnreachableError)` |
| with the loader (D1a's change applied to `lib/esm/utils/loadStores.js`) | RemoteDataset | `[probe] instanceof RemoteDataset true, instanceof FusekiStore false`; `[probe] instanceof RemoteDatasetUnreachableError true (RemoteDatasetUnreachableError)` |
| with the loader | FusekiStore (committed default) | `[probe] instanceof RemoteDataset false, instanceof FusekiStore true`; `[storage] appData: FusekiStore`; `GET /` 200 |
| 2.34.0 from npm (core's half released) | RemoteDataset | `[probe] instanceof RemoteDataset true, instanceof FusekiStore false`; `[probe] instanceof RemoteDatasetUnreachableError true (RemoteDatasetUnreachableError)` |
| 2.34.0 from npm | FusekiStore | `[probe] instanceof RemoteDataset false, instanceof FusekiStore true`; `[storage] appData: FusekiStore`; `GET /` 200 |

The first row is today's behaviour and shows the CLI half is harmless with an older core.

## CN boot proof

A CN worktree of `main` (`4900ce4e3`), `npm ci` (no `packages-local/`), `npm install` of this
build's tarball, then `CN_TEST_PORT=4079 npx playwright test tests/e2e/signin.spec.ts`:

```
[globalSetup] CN is healthy on :4079 after 29.4 s
  5 passed (51.7s)
```

CN's own storage file imports its stores by name and never calls `loadStores`, so the loader is
installed but unused there. The log has two `[CN-err] Fatal socket error Error: read/write
ECONNRESET` lines during the iframe sign-in redirect (a browser-side socket reset); the tests pass.

## Not done here

- Other native `import()`s of bundled packages (backlog 015's guard and bundling steps).
- A CLI e2e asserting `instanceof` with a `RemoteDataset` datasets file (CN plan 068 step D4).
- App-template's `name` + `url` fallback goes back to `instanceof` once core's half is released
  (step D5).

## PRs

- https://github.com/linked-fw/cli/pull/284
