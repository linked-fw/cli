---
"@_linked/cli": minor
---

## App release pipeline on the file-store API

A manifest-driven build/publish/serve flow for Linked apps, replacing the old recursive upload of
everything under `public/`.

### New commands

```bash
linked build-app --env <env> --target web        # build + write public/bundles/linked-release.json
linked build-app --env <env> --publish           # ...and upload it in the same run
linked build-app --env <env> --target capacitor  # local, non-publishable manifest; never uploads
linked build-app --revision <sha>                # identify the release outside a git checkout
linked build-app --allow-dirty                   # build uncommitted work as <sha>-dirty
linked publish-app --env <env>                   # dry run by default; pass --yes to upload
linked publish-app --manifest <path>             # publish a manifest from another path
linked serve-app --env <env>                     # compiled runtime, no Vite/HMR
```

`build-app` never uploads on its own — it writes a release manifest, and `publish-app` uploads
exactly the files that manifest lists.

### Publishing destination

Uploads go through `LinkedFileStorage.getStore(FileStorePurposes.appAssets)`. An app that dedicates a
bundle store configures `setStore(FileStorePurposes.appAssets, store)`; an app with a single store
configures only `setDefaultStore(store)` and publishing reaches it through the purpose fallback, with
no extra configuration and no error.

### Behaviour

- Object keys are `releases/<appVersion>-<revision>/<path>`, so releases no longer overwrite each
  other. `publish.releasePrefix` in `linked.config.js` changes the base. A manifest may only upload
  to its own prefix: each `objectKey` is recomputed from the prefix and source path before any
  write, so an edited or foreign manifest cannot overwrite a different release, and source paths
  that leave the app root (`../`, absolute, or through a symlink) are refused.
- The client bundle is built with `base = <accessURL>/<releasePrefix>/public/bundles/`, so the URLs
  it emits for its own chunks and assets resolve under the release prefix on a plain static store
  with no server rewrite. The value is recorded as `destination.baseURL`; the unused `publicRoot`
  field is gone. The store is therefore resolved before Vite runs, and a release is built for one
  store.
- The release revision comes from a clean `git rev-parse HEAD`. A dirty tree is refused (two builds
  of the same uncommitted work would share a prefix and overwrite each other); `--allow-dirty`
  builds as `<sha>-dirty`. `--revision <sha>`, `LINKED_RELEASE_REVISION` and `GITHUB_SHA` work
  outside a Git checkout.
- Cache policy follows a file's origin, not its name: files in the Vite manifest are hashed by
  construction and get `public, max-age=31536000, immutable`; declared static assets and the
  release manifest get `public, max-age=60, must-revalidate`. The old filename heuristic gave
  `og-image-1200x630.png` and `sw-v20260101.js` a year of immutable caching.
- `publish.staticAssets` globs are checked per match, not only per pattern, so brace expansion
  (`public/{,../}secret/**`) and symlinks can no longer pull in files from outside `public/`.
- `APP_ENV` selects the Capacitor target only when it is literally `capacitor`. Any other value
  (`production`, `staging`, …) builds web instead of silently producing an empty, non-publishable
  manifest.
- Files are re-hashed locally against the manifest before upload. The post-upload check uses the
  optional `IFileStore.statFile`; a store that lacks it, or reports no `sha256`, is warned about once
  and skipped rather than failing. `etag` is never treated as a content hash.
- The manifest records the store's `accessURL` and publishing refuses a store that no longer matches.
- Objects are written with `preventDuplicates: false` and a store that reports a different location
  than the key it was given fails the publish, rather than scattering renamed files.
- A failure partway through an upload names the file, the object key, the store and how many objects
  were already uploaded, and says that re-running resumes the release.
- Standalone `publish-app` is a dry run unless `--yes`; only publishable `target: 'web'` manifests
  upload; the manifest is read before a store is resolved, so a Capacitor manifest fails with a
  manifest error rather than a storage error; nothing is ever deleted remotely; credentials are
  redacted from publisher errors.
- `build-app`, `publish-app` and `serve-app` print a single error and exit 1 instead of surfacing an
  unhandled rejection, and `--target`/`--publish`/`--revision`/`--allow-dirty` are rejected on the
  legacy webpack path instead of being ignored.

### New exports

From `@_linked/cli`: `buildViteApp`, `hasViteConfig`, `publishApp`, `serveCompiledApp`,
`validateCompiledAppArtifacts`, `createReleaseManifest`, `serializeReleaseManifest`,
`writeReleaseManifest`, `buildReleasePrefix`, `releaseObjectKey`, `getCacheControl`,
`planReleasePublish`, `publishRelease`, `loadReleaseManifest`, `resolveAppAssetsStore`,
`normalizeAccessURL`, `resolveBuildTarget`, `resolveDeclaredStaticAssets`, `resolveReleaseIdentity`,
`resolveSourceRevision`, `releaseBaseURL`, `VITE_OUTPUT_DIR`, the path helpers, and the release
types.

Apps must build with `build.outDir: 'public/bundles'` and `build.manifest: true` (both already set
by `createViteConfig`) and must not set `base` themselves; see the README.

Requires `@_linked/core` 2.20.1 for the purpose-named file stores and `IFileStore.statFile`.
