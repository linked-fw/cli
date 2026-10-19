---
date: 2026-10-19
summary: >
  `linked build-app` and `linked publish-app` find the `appAssets` file store by loading the app's
  `linked.backend.files.{ts,js}` alone when it has one, falling back to the whole storage file
  (backlog 018, option 1). The app template moved its file stores into that file (app-template#34),
  so a template app builds with its `RemoteDataset` answering nowhere: before, the build exited 1
  with "Could not reach the data server". CN and webid.email have no files file and build as
  before. A new e2e (`build-app.spec.ts`, in the `Dual-copy e2e` job) holds it. Minor release.
  Replaces backlog 018.
---

# 020 — `build-app` needs no data server

## Why

`build-app` resolves the publish destination before Vite runs, since the bundle's `base` is the
`appAssets` store's `accessURL`. It found the store by importing the app's whole
`linked.backend.storage.ts`, which runs `loadStores` and the template's awaited `appData.init()`.
With `appData` a `RemoteDataset` and no data server, the build exited 1 before Vite started
(app-template#27, CN plan 068 step D5). A FusekiStore app tried to create its dataset in whatever
Fuseki `FUSEKI_BASE_URL` named, during a build.

## The choice

Backlog 018 listed four options. Option 1, file storage in its own file, is the one that is correct
by construction: the build evaluates no dataset code at all, so no store is built, nothing is
pinged and no dataset is created, whatever the storage file does at load time. The others leave
the build running the storage file: option 2 (a build flag) needs every storage file and core's
`loadStores` to honour it, and the stores are still constructed; option 3 (the destination from
configuration) changes what the build knows about a dedicated CDN store; option 4 (lazy stores)
loses the boot message app-template#26 added. Option 1 costs a file name and a template change,
and an app without the file behaves as before.

## What changed

- `src/lifecycle.ts`: `findBackendFilesConfig(cwd, exists)` returns `linked.backend.files.ts`, then
  `.js`, at the app root. `loadBackendFileStorage()` imports that file alone (`Loading file storage
  from linked.backend.files.ts`), or calls `loadBackendStorageConfig()` when there is none. An error
  in the files file is thrown, not turned into a fallback.
- `src/app-release/app-assets-store.ts`: `resolveAppAssetsStore`'s default loader is
  `loadBackendFileStorage`. It serves `build-app` (web target) and `publish-app`.
- app-template#34 (`d11b7aa`): `linked.backend.files.ts` holds the `LocalFileStore` default store,
  and `linked.backend.storage.ts` imports it, so `linked start` and `serve-app` register it as
  before. Safe with an older CLI, which still loads the storage file.
- Tests: `tests/unit/backendFileStorage.test.ts` (`.ts`, `.js`, `.ts` preferred, a storage file is
  not a files file; files file imported alone, fallback, an error is not swallowed).
  `tests/e2e/build-app.spec.ts`: a template app with `appData` a `RemoteDataset` at
  `http://127.0.0.1:9` runs `npm run build` and must exit 0, print the `Loading file storage` line
  and no "Could not reach the data server", and write `public/bundles/linked-release.json`. The
  `Dual-copy e2e` job runs it too, and its PR filter adds `src/lifecycle.ts`,
  `src/app-release/app-assets-store.ts` and `src/commands/build-app.ts`.
- README ("A build needs no data server"), the Playwright config header.

## Measured

Node v22.23.3, npm 12.2.0. Template app: a copy of app-template#34's branch, `node
e2e/remote-mode.mjs .`, committed, nothing listening on `:9`.

`DATA_SERVER_URL=http://127.0.0.1:9 DATA_SERVER_TOKEN=t npm run build`, `@_linked/cli@1.51.2` from
npm, exit 1:

```
🔄 Resolving the appAssets file store...
Could not reach the data server at http://127.0.0.1:9
(linked.backend.datasets.json → datasets.appData).
```

this build (packed), exit 0:

```
🔄 Resolving the appAssets file store...
Loading file storage from linked.backend.files.ts
[LinkedFileStorage] Purpose 'appAssets' has no dedicated store; using the default store.
✅ Publishing destination: http://localhost:4000
✅ Release manifest ready: 13 artifacts under releases/0.1.0-31a8ea2b85af (public/bundles/linked-release.json)
```

The committed FusekiStore with `FUSEKI_BASE_URL=http://127.0.0.1:9`: exit 0, the same lines, no
dataset ensure. `npm run serve-app` of that build: `Up and running`, `GET /` 200; `npm start`:
`[linked] dual-copy guard: on`, `[storage] appData: FusekiStore`, `GET /` 200.

The e2e, after app-template#34 merged:

```
  ✓  1 tests/e2e/build-app.spec.ts:30:1 › a RemoteDataset app builds with nothing listening on its url (5.9s)
  ✓  2 tests/e2e/dual-copy.spec.ts:67:1 › the committed FusekiStore app boots and renders / with one copy of each package (6.1s)
  ✓  3 tests/e2e/dual-copy.spec.ts:85:1 › a RemoteDataset appData is the class the app imports, and so is its error (1.9s)
  3 passed (39.2s)
```

and with `E2E_CLI=@_linked/cli@1.51.2`:

```
  ✘  1 tests/e2e/build-app.spec.ts:30:1 › a RemoteDataset app builds with nothing listening on its url (3.1s)
    Expected substring: not "Could not reach the data server"
  1 failed
```

Apps without a files file take the fallback, so they load what they loaded before:

- CN (worktree of `main` `345e23773`, `npm ci`, this build installed, `npx linked build-all`, CN's
  `.env`, `FUSEKI_BASE_URL=http://127.0.0.1:9 LINKED_SYNC_SHAPES_ON_BOOT=false`):
  `NODE_ENV=production npm run build:app -- --allow-dirty` exit 0, `✅ Publishing destination:
  http://localhost:4040/uploads`, `✅ Release manifest ready: 142 artifacts`.
- webid.email (fresh clone of Semantu/webid-email `75f079b`, `npm ci`, this build installed,
  `FUSEKI_BASE_URL=http://127.0.0.1:9`): `npm run build -- --allow-dirty` exit 0, `Fuseki dataset
  ensure failed` (its storage file's own warning), `✅ Release manifest ready: 27 artifacts`.

`npx jest --config jest.config.cjs`: `Tests: 837 passed, 837 total`.

## Follow-ups

- CN and webid.email can move their file stores into a `linked.backend.files.js`/`.ts` to build
  without Fuseki; not needed today (both build with a dead Fuseki url). Not recorded as backlog.
- app-template `blank`: the sync merge conflicts on the storage file's imports; resolved by hand
  (app-template readme, "The blank variant").

## PRs

- https://github.com/linked-fw/cli/pull/297
