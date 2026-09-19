# @_linked/cli

Command-line tools for the `@_linked/*` packages and apps.

## Install

```bash
npm install --save-dev @_linked/cli
```

## Binaries

Three executables ship in this package:

- `linked` — primary command
- `lnk` — short alias for `linked`
- `lincd` — deprecated alias; prints a warning and forwards to `linked`. Will be removed in a future major release.

## Commands

Run `linked --help` for the full list. The commonly used ones:

### App scaffolding

```bash
linked create-app <name>          # scaffold a new app (interactive)
linked create-package <name>      # scaffold a new linkedPackage
linked create-shape <name>        # add a shape file to the current package
linked create-component <name>    # add a React component file
```

### Building

```bash
linked build                      # build the current package (tsc + checks)
linked build-app                  # build frontend + backend for the current app
linked build-app --target web     # web release: build and write public/bundles/linked-release.json
linked build-app --target capacitor  # Capacitor/local native build: local manifest only, never published
linked build-workspace            # build all linked packages in the workspace in dependency order
linked build-updated              # incremental: only packages that changed since last build
linked build-package <file>       # walk up from a file path to find its package and rebuild
```

`linked build` exits with code 1 whenever the build does not succeed, including when it is run in a `linkedApp` or
in a package without `"linkedPackage": true` (it used to exit 0 there). A build that finishes with warnings still
exits 0.

### App release / production runtime

```bash
linked build-app                  # build and write the release manifest (never uploads)
linked build-app --publish        # ...and upload it in the same run
linked publish-app                # dry-run the release manifest upload (pass --yes to write)
linked publish-app --yes          # upload the release described by the manifest
linked serve-app                  # run the compiled backend without Vite/HMR (production runtime)
```

**Building is not publishing.** `build-app` compiles the app and writes
`public/bundles/linked-release.json`, a manifest listing every file of the release with its sha256,
size, content type and cache policy. `publish-app` uploads exactly the files in that manifest —
nothing else in `public/` is touched. Pass `--publish` to `build-app` only when you want the two
chained in one command.

**Where it publishes.** Uploads go to the store returned by
`LinkedFileStorage.getStore(FileStorePurposes.appAssets)`. Configure a dedicated bundle store with
`LinkedFileStorage.setStore(FileStorePurposes.appAssets, store)`; an app that configures only
`setDefaultStore(store)` publishes to that store through the purpose fallback, which needs no extra
configuration.

**Every release gets its own prefix.** Object keys are
`releases/<appVersion>-<gitRevision>/<path>`, so publishing a new release cannot overwrite the
previous one and a rollback means pointing at an older prefix. Set `publish.releasePrefix` in
`linked.config.js` to change the `releases` base.

**Verification.** Files are re-hashed from disk and compared against the manifest immediately before
upload, so a build that changed since the manifest was written is refused. After upload the store is
asked for `statFile`; that method is optional and may report no `sha256`, in which case the remote
check is skipped with a single warning rather than a failure. An `etag` is never used as a content
hash. The manifest also records the store's `accessURL`, and publishing refuses to run against a
store that now writes somewhere else.

**The store must keep keys verbatim.** A release object has to be stored under exactly the key it
was given, or the URLs baked into the bundle point at nothing, so publishing passes
`preventDuplicates: false` and fails with a clear message if the store reports a different location.
`@_linked/server`'s `LocalFileStore` lowercases the keys it is handed, so an app publishing to it
needs lowercase asset filenames (`rollupOptions.output.hashCharacters: 'hex'` in `vite.config`).

**Cache policy.** A filename carrying a content hash gets
`public, max-age=31536000, immutable`; everything else, including `index.html` and the release
manifest, gets `public, max-age=60, must-revalidate`.

**Capacitor.** `--target capacitor` (or `APP_ENV`) writes a local, non-publishable manifest for
inspection. Its assets ship inside the native app, so no file store is resolved and nothing is
uploaded, even with `--publish`.

Use `linked start` for development; use `linked serve-app` after `linked build-app` for
staging/production.

### Publishing / release

```bash
linked setup-publish              # install a changesets-based publish workflow in the current repo
linked setup-publish --dual-branch          # use main + dev with @next prereleases
linked setup-publish --configure-github     # also set branch protection via gh CLI
linked setup-publish --scope community      # use NPM_AUTH_TOKEN_CM instead of NPM_AUTH_TOKEN
```

`setup-publish` writes:

- `.github/workflows/ci.yml`, `publish.yml`, `changeset-check.yml`
- `.changeset/config.json` + `README.md`
- `.gitignore` entries
- `publishConfig: {access: public}` + `@changesets/cli` devDeps in `package.json`
- `package-lock.json` (via isolated tmpdir)

### Dev workflow

```bash
linked start                      # run the dev server (app)
linked start --api-only           # run only the backend API (no page rendering, no vite.config needed)
linked dev                        # file-watch rebuild (package)
linked yarn <args>                # safe-yarn: run yarn at root while preserving nested yarn.lock files
```

### Registry / dev utilities

```bash
linked publish                    # publish the current package (for non-CI flows)
linked register                   # register the package to the linked registry
linked status                     # show which packages need build/publish
linked depcheck                   # check for missing/unused deps
```

## Package flags

The CLI recognizes two flags in `package.json`:

```json
{
  "linkedPackage": true,     // marks a reusable library; build-workspace builds it
  "linkedApp": true          // marks a deployable app; build-workspace skips it
}
```

The legacy `lincd: true` / `lincdApp: true` flags are no longer read. Migrate to `linkedPackage` / `linkedApp`.

### Extensionless relative imports

Package source may use extensionless relative imports (`./shapes/Example` rather than `./shapes/Example.js`) —
useful for a shapes package consumed as TypeScript source by Metro, which does not map `.js` specifiers to `.ts`
files. No configuration is needed. After compiling ESM, `linked build` rewrites every relative specifier in
`lib/esm` — in the emitted `.js` and in the `.d.ts` declarations beside them, so consumers on TypeScript
`node16`/`nodenext` resolution get valid declarations — to `./x.js` or `./dir/index.js`, so Node can load the
output. For a package that already writes `.js` specifiers the rewrite is a no-op.

The build finishes "with warnings" and lists each relative specifier it could not resolve (left unchanged), and
fails when `tsconfig-esm.json` is present but `lib/esm` was not emitted. A package without a `tsconfig-esm.json`
has no ESM build, so the step is skipped.

The import check (`linked check-imports`, also run as the first build step) still fails the build for imports
that reach outside the package source root, and for imports into another linked package's `/src/` or `/lib/`.

## API-only backend

`linked start --api-only`, or `server.apiOnly: true` in `linked.config.js`, serves only the backend API
(`/call/...`, `/api/...` and provider routes). There is no server-side page rendering, page requests get a 404,
and no `vite.config.*` is required. Use it for a backend whose frontend lives elsewhere, such as a React Native
app:

```js
// linked.config.js
export default {
  server: {apiOnly: true},
};
```

API-only mode is never inferred: a web app without a `vite.config.*` and without the flag still fails at startup.

## Development

```bash
cd packages/cli
npm install
npm run build
```

Dual ESM + CJS build via `tsconfig-to-dual-package`. Sources in `src/`, output in `lib/esm/` and `lib/cjs/`.

### Templates

Templates live in `defaults/`:

- `defaults/app-with-backend/` — used by `linked create-app`
- `defaults/app-static/` — minimal static app
- `defaults/package/` — used by `linked create-package`
- `defaults/setup-publish/` — workflow + changeset files written by `linked setup-publish` (single-branch default; `dual-branch/` subdirectory for the `--dual-branch` variant)

### `linked create-app` template structure

`linked create-app <name>` copies `defaults/app-with-backend/` to the new app's folder, substitutes `${name}` / `${hyphen_name}` / `${app_prefix}` / `${app_domain}` placeholders in selected files, and copies `linked.backend.datasets.example.json` → `linked.backend.datasets.json` so first boot works zero-config. Dependencies are installed with `npm install`, and the next-steps message tells you to run `npm start`.

Storage configuration follows the two-layer pattern from [backlog 016](https://github.com/c### `linked create-app --template react-native`

`linked create-app <name> --template react-native` (with the usual `--app-name`, `--app-prefix`, `--app-domain`,
`--skip-install`) copies `defaults/app-react-native/` instead of cloning the web template. The result is an npm
workspaces monorepo for Expo SDK 57 / React Native 0.86 / React 19.2 with an API-only Linked backend on Fuseki:

```
<name>/
  package.json              enumerated workspaces; scripts fuseki:up/down, api, check:react, lint, typecheck,
                            test, test:integration
  docker-compose.yml        local Fuseki (secoresearch/fuseki, host port FUSEKI_PORT, default 3030)
  eslint.config.js          flat config; keeps apps/mobile on @_linked/server subpath imports
  apps/mobile/              Expo app (ios/ and android/ are generated, not committed)
    App.tsx                 imports ./src/shell/env, @_linked/react/native, ./src/shell/storage
    babel.config.js         registers babel/stripJsonImportAttributes.js
    src/shell/              env.ts (API URL), storage.ts (BackendAPIStore)
    src/components/         PersonOverview / PersonPreview: example add/edit/delete screen
    __tests__/              unit tests; __tests__/integration/ runs against the API and Fuseki
  packages/<prefix>-shapes/ Linked shapes package: TypeScript source with extensionless imports; `linked build`
                            rewrites the emitted specifiers so lib/esm is Node-loadable
  services/api/             API-only backend (`linked start --api-only`) on @_linked/server, Fuseki through
                            linked.backend.datasets.json, node --test unit tests
```

What the scaffold does:

- Refuses, before writing anything, a prefix that does not match `^[a-z][a-z0-9-]*$`, and a target folder that
  exists and is not empty.
- Restores shipped dotfiles at any depth (`gitignore.template` becomes `.gitignore`, `env.example.template`
  becomes `.env.example`). npm strips real dotfiles like `.gitignore` from the CLI tarball.
- Renames `packages/app-shapes` to `packages/<prefix>-shapes`, and replaces the literal `app-shapes` token in
  every text file.
- Sets the root `name` to `<hyphen-name>-monorepo`, and `app.json` `expo.name`, `expo.slug` and
  `expo.ios.bundleIdentifier`. The bundle ID is the reversed domain plus the prefix, e.g. `com.example.demo`.
- Stamps the Fuseki dataset names `<prefix>-dev` and `<prefix>-test` from the prefix.
- Never runs the `${…}` placeholder substitution, so template literals in the sources are left alone.
- Installs with `npm install` (never Yarn) unless `--skip-install` is given. If the install fails, the files
  stay and the command exits non-zero; run `npm install` in the folder to retry.

The generated app:

- **Render defaults** come from `@_linked/react/native`, which replaces `@_linked/react`'s `<svg>` loader and
  error elements (they crash on React Native).
- **Person example.** `PersonOverview` and `PersonPreview` list, add, edit and delete `@_linked/schema`'s
  `Person` through `BackendAPIStore` → API → Fuseki. A Jest integration test covers it.
- **Babel plugin.** Metro rejects `import('x.json', { with: { type: 'json' } })`, which Linked ontology packages
  use; `apps/mobile/babel/stripJsonImportAttributes.js` drops that options argument.
- **Before every PR.** The template ships no CI workflow. Its README has a checklist to run locally and paste
  into the PR:

```bash
npm run check:react
npm run lint
npm run typecheck
npm test
npm run fuseki:up && npm run test:integration
cd apps/mobile && npx expo export --platform ios --output-dir /tmp/export
```

To run it: `npm run fuseki:up`, `npm run api`, then `cd apps/mobile && npx expo run:ios`.

Tests for this template in this repo: `npm run test:unit` covers the scaffold offline, using the fixture in
`tests/fixtures/app-react-native-min` and the real template. `npm run test:template` runs the built CLI with
install, then checks the generated files, `check:react`, lint, typecheck, `npm test`, the shapes build and a
Metro iOS bundle. It builds nothing itself, needs network and takes several minutes.

## Repository

`linked-cm/cli` on GitHub. License: MPL-2.0.
