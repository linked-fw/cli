---
"@_linked/cli": minor
---

## Linked app release pipeline

Adds a manifest-driven web build/publish/serve flow so apps can ship CDN assets safely without the old recursive `public/` upload.

### New commands

```bash
linked build-app --env <env> --target web        # build + auto-publish eligible non-dev web releases
linked build-app --env <env> --target capacitor  # local/Capacitor build; never CDN-publishes
linked publish-app --env <env>                   # dry-run by default; pass --yes to upload
linked serve-app --env <env>                     # Vite-free compiled runtime (use instead of `linked start` in prod)
```

`build-app` for web: Vite frontend → backend compile → release manifest → verified publish through the app's explicit `IArtifactStore` static store. Development and Capacitor/`APP_ENV` builds skip publishing.

### New exports

Importable from `@_linked/cli`:

- Commands/helpers: `publishApp`, `serveCompiledApp`, `validateCompiledAppArtifacts`, `createReleaseManifest`, `serializeReleaseManifest`, `writeReleaseManifest`, `planReleasePublish`, `publishRelease`, `resolveBuildTarget`, `resolveDeclaredStaticAssets`, `assertArtifactStore`
- Path helpers: `joinObjectKey`, `joinStaticAssetUrl`, `normalizeReleasePath`, `resolveExistingPathWithinRoot`
- Types: `AppBuildTarget`, `AppPublishConfig`, `BuildAppOptions`, `LinkedAppReleaseManifest`, `LinkedAppReleaseFile`, `LinkedAppReleaseDestination`, `PublishPlan`, `PublishResult`

Requires `@_linked/core`'s `IArtifactStore` (and an S3 adapter that implements it) for publishing.

### Safety behavior

- Standalone `publish-app` is dry-run unless `--yes`
- Only publishable `target: 'web'` manifests are uploaded
- Exact bucket/prefix checks; no remote deletes; hashed assets before the release manifest
- Secrets redacted from publisher errors
