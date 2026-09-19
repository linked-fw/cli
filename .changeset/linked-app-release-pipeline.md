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
linked publish-app --env <env>                   # dry run by default; pass --yes to upload
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

- Object keys are `releases/<appVersion>-<gitRevision>/<path>`, so releases no longer overwrite each
  other. `publish.releasePrefix` in `linked.config.js` changes the base.
- Hashed filenames are stored with `public, max-age=31536000, immutable`; entry files and the
  manifest with `public, max-age=60, must-revalidate`.
- Files are re-hashed locally against the manifest before upload. The post-upload check uses the
  optional `IFileStore.statFile`; a store that lacks it, or reports no `sha256`, is warned about once
  and skipped rather than failing. `etag` is never treated as a content hash.
- The manifest records the store's `accessURL` and publishing refuses a store that no longer matches.
- Objects are written with `preventDuplicates: false` and a store that reports a different location
  than the key it was given fails the publish, rather than scattering renamed files.
- Standalone `publish-app` is a dry run unless `--yes`; only publishable `target: 'web'` manifests
  upload; nothing is ever deleted remotely; credentials are redacted from publisher errors.

### New exports

From `@_linked/cli`: `buildViteApp`, `hasViteConfig`, `publishApp`, `serveCompiledApp`,
`validateCompiledAppArtifacts`, `createReleaseManifest`, `serializeReleaseManifest`,
`writeReleaseManifest`, `buildReleasePrefix`, `releaseObjectKey`, `getCacheControl`,
`planReleasePublish`, `publishRelease`, `resolveAppAssetsStore`, `normalizeAccessURL`,
`resolveBuildTarget`, `resolveDeclaredStaticAssets`, the path helpers, and the release types.

Requires `@_linked/core` 2.20.1 for the purpose-named file stores and `IFileStore.statFile`.
