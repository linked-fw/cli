---
summary: >
  `linked build-app` (the template's `npm run build`) evaluates the app's whole
  `linked.backend.storage.ts` to find the `appAssets` file store, so it builds every dataset store
  as well and runs whatever the file does at load time. With `appData` a `RemoteDataset` the
  template awaits `appData.init()`, which pings the data server, and the build exits with "Could
  not reach the data server" unless one answers. A build should not need the data server (or
  Fuseki). Four options; the lean one is to load file storage on its own.
status: Open -- found in app-template#27 (CN plan 068, step D5); not scheduled
---

# 018 — `build-app` needs the data server

## Symptom

App-template `main` (`15f109b`), `appData` switched to a `RemoteDataset` with
`e2e/remote-mode.mjs`, committed (the build refuses a dirty tree), nothing listening at the url:

```
$ DATA_SERVER_URL=http://127.0.0.1:9 DATA_SERVER_TOKEN=t npm run build
🔄 Loading build environment...
✅ Build environment loaded
🔄 Resolving the appAssets file store...
Could not reach the data server at http://127.0.0.1:9
(linked.backend.datasets.json → datasets.appData).
Start Create Now locally, or point appData at Fuseki directly:
```

and the process exits 1 before Vite starts. Any storage file that awaits a store at load time
has the same problem; a FusekiStore app without Fuseki was not measured.

## Where the stores are initialised

1. `src/commands/build-app.ts:147-152`: for the `web` target (the default) `buildViteApp`
   resolves the publish destination before the client bundle is built, since the bundle's `base`
   is baked in (`store.accessURL`), through `resolveAppAssetsStore`.
2. `src/app-release/app-assets-store.ts:29-35`: `resolveAppAssetsStore` calls
   `loadBackendStorageConfig()` and then reads `LinkedFileStorage.getStore(appAssets)`.
3. `src/lifecycle.ts:155-171`: `loadBackendStorageConfig` imports the app's
   `linked.backend.storage.{ts,js}` (`importFile(candidate)`, `:171`), which runs the file
   top to bottom.
4. The template's `linked.backend.storage.ts`: `loadStores(config)` builds every store in
   `linked.backend.datasets.json`, then `await appData.init()` pings a `RemoteDataset`'s data
   server and `process.exit(1)` on `RemoteDatasetUnreachableError` /
   `RemoteDatasetUnauthorizedError` (the boot message, `src/utils/storageErrors.ts`).

Only step 2's file store is needed, and only its `accessURL`. `buildBackend`
(`src/cli-methods.ts:2200`) compiles with Vite and does not load the storage file.

## Options

1. **File storage on its own.** The CLI loads an optional `linked.backend.files.{ts,js}` (or
   whatever name is chosen) for `appAssets`, falling back to the storage file when it is absent;
   the template moves its `LinkedFileStorage` lines there and the storage file imports it.
   No dataset is built during a build. Costs a convention and a template change.
2. **A build flag the storage file reads.** `build-app` sets `LINKED_PHASE=build` (or a
   `Symbol.for('@_linked/cli:phase')` on `globalThis`) before loading the file, and the template
   skips `init()` and the dataset ensure under it. Smallest change, but every storage file has to
   know about it, and `loadStores` still constructs the stores.
3. **The destination from configuration, not a live store.** The release prefix and access URL
   come from the publish config or an env value (`STATIC_ACCESS_URL` is already the serving side
   of it), and the store itself is resolved only by `publish-app`. Changes what "the build knows
   where it will be published" means for apps with a dedicated CDN store.
4. **Lazy stores.** Stores never touch the network until first use; the template drops its
   awaited `init()` and reports a dead data server on the first query instead. Loses the boot
   message at startup, which is why app-template#26 added it.

## Related

- app-template#27 (where it was found), CN plan 068 phase 4 status table (D5 note).
- [Report 017](../reports/017-dual-copy-e2e.md) boots the same RemoteDataset app under
  `linked start`; it does not build it.
