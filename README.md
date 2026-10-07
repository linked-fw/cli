# @_linked/cli

Command-line tools for the `@_linked/*` packages and apps.

## Install

```bash
npm install --save-dev @_linked/cli
```

## Binary

One executable ships in this package: `linked`. (`lnk`, `lincd` and `lincd-cli` were dropped in
[#40](https://github.com/linked-fw/cli/pull/40).)

In a project that has `@_linked/cli` installed — any linked app, including Create Now — run it as
`npx linked <command>`. Everywhere else, name the package: `npx @_linked/cli <command>`.
A bare `npx linked` outside such a project does **not** reach this CLI: npm resolves it to the
unrelated `linked` package on the registry, which has no binary, and fails with
`could not determine executable to run`.

## Commands

Run `linked --help` for the full list. The commonly used ones:

### App scaffolding

```bash
linked create-app <name>          # scaffold a new app (interactive)
linked create-package <name>      # scaffold a new linkedPackage (see below for where it goes)
linked create-shape <name>        # add a shape file to the current package
linked create-component <name>    # add a React component file
```

Inside an app (a `package.json` with `"linkedApp": true` above the current directory),
`create-package` puts the package in one of two places, and asks which on a terminal:

```bash
linked create-package @_linked/foo --location packages        # part of the app's repository
linked create-package @_linked/foo --location packages-local  # a repository of its own
linked create-package @_linked/foo --remote <git-url> [--push] # the same, with an origin
```

- `packages/foo` — a workspace member: added to the app's `dependencies` (and `packages/*` to its
  `workspaces` if missing), installed at the app root.
- `packages-local/_linked-foo` — the name `linked localize` uses. `git init` and a first commit,
  `origin` and `repository.url` from `--remote`, pushed with `--push`; then installed, built,
  linked and recorded by `linked localize --adopt`. It is not added to the app's `dependencies`
  until it is published. `--remote` or `--push` imply this location.

Any of the three flags skips the question. With none of them and no terminal, it exits 1 and says
which flag to pass. An existing target folder is refused. Outside an app nothing changes: the
package goes in `./packages/`, `./modules/` or the current directory, and installs on its own.

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
linked build-app --revision <sha> # identify the release without asking git
linked build-app --allow-dirty    # allow uncommitted changes; revision gets a "-dirty" suffix
linked publish-app                # dry-run the release manifest upload (pass --yes to write)
linked publish-app --yes          # upload the release described by the manifest
linked publish-app --manifest <p> # publish a manifest other than the default path
linked serve-app                  # run the compiled backend without Vite/HMR (production runtime)
```

**Required Vite config.** The release flow reads `vite build` output directly, and the paths are
hardcoded: the client bundle must land in `public/bundles` and Vite must write its manifest.
`createViteConfig()` from `@_linked/cli/vite` already sets both; a hand-written `vite.config.ts`
needs them explicitly:

```ts
export default defineConfig({
  build: {
    outDir: 'public/bundles',  // release object keys are <prefix>/public/bundles/...
    manifest: true,            // build-app reads public/bundles/.vite/manifest.json
  },
});
```

Without `manifest: true` the build fails with a missing `public/bundles/.vite/manifest.json`; with a
different `outDir` nothing is found to publish. Do not set `base` yourself — `build-app` passes it
(see "How a release is served").

**Building is not publishing.** `build-app` compiles the app and writes
`public/bundles/linked-release.json`, a manifest listing every file of the release with its sha256,
size, content type and cache policy. `publish-app` uploads exactly the files in that manifest —
nothing else in `public/` is touched. Pass `--publish` to `build-app` only when you want the two
chained in one command. `publish-app` is a dry run unless `--yes` is given, and `--manifest <path>`
publishes a manifest from somewhere other than `public/bundles/linked-release.json` (the path is
relative to the app root and must stay inside it).

**Where it publishes.** Uploads go to the store returned by
`LinkedFileStorage.getStore(FileStorePurposes.appAssets)`. Configure a dedicated bundle store with
`LinkedFileStorage.setStore(FileStorePurposes.appAssets, store)`; an app that configures only
`setDefaultStore(store)` publishes to that store through the purpose fallback, which needs no extra
configuration.

**Every release gets its own prefix.** Object keys are
`releases/<appVersion>-<revision>/<path>`, so publishing a new release cannot overwrite the
previous one and a rollback means pointing at an older prefix. Set `publish.releasePrefix` in
`linked.config.js` to change the `releases` base. A manifest may only upload to its own prefix: every
`objectKey` is recomputed from the prefix and the source path before anything is written, so an
edited or foreign manifest cannot reach into another release.

**How a release is served.** Because every release has its own key prefix, the bundle's own URLs have
to carry that prefix — nothing rewrites them at request time. `build-app` therefore resolves the
store and the release prefix *before* running Vite and passes

```
base = <store accessURL>/<releasePrefix>/public/bundles/
```

so the chunk and asset URLs the bundle emits are absolute URLs into the release prefix. This works on
a plain static store or CDN with no rewrite rules, and two releases can be served side by side. The
value is recorded as `destination.baseURL` in the release manifest.

The HTML entry tags are not part of the bundle — `@_linked/server` renders them as
`${STATIC_ACCESS_URL}/public/bundles/<file>`. So serving a particular release is one deployment
variable, which `build-app` prints when it finishes:

```
STATIC_ACCESS_URL=<store accessURL>/releases/<appVersion>-<revision>
```

Set that on the app server (or roll back by setting it to an older release prefix) and the entry
tags and everything the bundle loads resolve to the same release. Note the consequence of baking the
base in: a release is built for one store, and pointing it at another means rebuilding.

**Which revision identifies a release.** By default the short `git rev-parse HEAD` of a **clean**
tree. A dirty tree is refused, because two builds of the same uncommitted work would share a release
ID and prefix and silently overwrite each other while removed files linger; pass `--allow-dirty` to
build anyway as `<sha>-dirty`. Outside a Git checkout (an exported tarball, some CI images) pass
`--revision <sha>`, or set `LINKED_RELEASE_REVISION` or `GITHUB_SHA`; those win over Git and skip
the clean-tree check.

**Verification.** Files are re-hashed from disk and compared against the manifest immediately before
upload, so a build that changed since the manifest was written is refused. After upload the store is
asked for `statFile`; that method is optional and may report no `sha256`, in which case the remote
check is skipped with a single warning rather than a failure. An `etag` is never used as a content
hash. The manifest also records the store's `accessURL`, and publishing refuses to run against a
store that now writes somewhere else. A failure partway through names the file, the object key, the
store and how many objects were already uploaded; the manifest is uploaded last, so an incomplete
release is never marked complete, and re-running `publish-app` resumes it.

**The store must keep keys verbatim.** A release object has to be stored under exactly the key it
was given, or the URLs baked into the bundle point at nothing, so publishing passes
`preventDuplicates: false` and fails with a clear message if the store reports a different location.
`@_linked/server`'s `LocalFileStore` lowercases the keys it is handed, so an app publishing to it
needs lowercase asset filenames (`rollupOptions.output.hashCharacters: 'hex'` in `vite.config`).

**Cache policy follows the origin, not the filename.** Files listed in the Vite manifest are
content-hashed by construction and get `public, max-age=31536000, immutable`. Everything else —
declared `publish.staticAssets` and the release manifest — gets
`public, max-age=60, must-revalidate`. (Guessing from the filename was tried and dropped:
`og-image-1200x630.png` and `sw-v20260101.js` read as hashed, and a year of immutable caching on
those cannot be undone without renaming the file.)

**Extra static assets.** `publish.staticAssets` in `linked.config.js` lists globs of files under
`public/` to ship besides the bundle. Both the pattern and every match must resolve inside
`public/`, so brace expansion and symlinks cannot pull in files from elsewhere in the repo.

**Capacitor.** `--target capacitor` (or `APP_ENV=capacitor`, matched literally) writes a local,
non-publishable manifest for inspection. Its assets ship inside the native app, so no file store is
resolved, no `base` is set and nothing is uploaded, even with `--publish`. Any other `APP_ENV` value
(`production`, `staging`, …) is ignored by the target choice and builds web.

Use `linked start` for development; use `linked serve-app` after `linked build-app` for
staging/production.

### Publishing / release

```bash
linked setup-publish              # install the changesets-based publish pipeline in the current repo
linked setup-publish --configure-github     # also apply the uniform branch protection via gh CLI
linked setup-publish --scope community      # use NPM_AUTH_TOKEN_CM instead of NPM_AUTH_TOKEN
```

`setup-publish` writes:

- `.github/workflows/pr.yml` and `publish.yml` — thin callers of the shared reusable workflows in
  `linked-fw/.github`, pinned `@v1`. Any pre-consolidation `ci.yml` / `changeset-check.yml` is removed.
- `.changeset/config.json` + `README.md`
- `.gitignore` entries
- `publishConfig: {access: public}` + `@changesets/cli` devDeps in `package.json`
- `package-lock.json` (via isolated tmpdir)

### Dev workflow

```bash
linked start                      # run the dev server (app)
linked start --api-only           # run only the backend API (no page rendering, no vite.config needed)
linked dev                        # file-watch rebuild (package)
```

```bash
linked app-doctor                 # in an app: check optimizeDeps.include and React peer ranges of linked packages' deps
```

`createViteConfig()` takes care of two things apps used to configure by hand:

- **HMR port.** Derived from the dev port (`24678 + (PORT - 4040)`); when another process already
  holds it, the next free port is used and logged. `LINKED_HMR_PORT` sets it explicitly.
- **`optimizeDeps.include` for linked packages' dependencies.** Linked packages are excluded from
  Vite's optimizer, so Vite never sees their own imports (Radix, `vaul`, `js-cookie`…). In dev
  those are read from the packages' import graph — server-only code left out, npm-nested
  installs written as `'<pkg> > <dep>'` — and added to whatever the app lists. `DEBUG=linked`
  prints them; `clientDepIncludes: {deny: [...]}` keeps entries out and
  `clientDepIncludes: false` (or `LINKED_CLIENT_DEP_INCLUDES=0`) turns it off.

### Developing a dependency from a git checkout

`linked localize` clones an npm dependency, installs inside the checkout, builds
it with `linked build` and symlinks it into `node_modules` — **without** touching
`package.json` or `package-lock.json`, so the manifest still describes the
released dependency and CI is unaffected.

```bash
linked localize @_linked/rdfs     # clone, install, build, symlink into node_modules
linked localize                   # report what is localized (same as --list)
linked localize --list --check    # exit 1 when something recorded is not actually linked
linked localize --relink          # recreate the recorded symlinks — run this from postinstall
linked localize @_linked/rdfs --adopt  # link a checkout already in packages-local/_linked-rdfs, no clone
linked delocalize @_linked/rdfs   # unlink and forget, keeping the checkout
linked delocalize --purge         # undo everything and delete the checkouts
```

Checkouts go in `packages-local/` under the npm name with the scope flattened:
`@_linked/rdfs` → `packages-local/_linked-rdfs`.

`npm install <name>` — with a package name — does not run the app's own `postinstall`, so it
replaces every localized link with the registry copy and prunes the checkouts' dependencies,
silently. Run `linked localize --relink` after it (a bare `npm install` runs the hook itself).

Name packages exactly as npm names them (`@_linked/rdfs`, `lodash`): the
repository is read from the package's published `repository` field, so there is
no short-name expansion and no org guessing. `--dir` moves the checkout
directory (default `packages-local`), `--repo`/`--subdir` cover a package whose
published metadata does not point at the right place, and `--build "<cmd>"`
replaces `linked build` (an empty string builds nothing). A failing build only
warns — a package whose build is broken is usually why you localized it.

**One copy of each framework package.** A checkout's own install leaves its own
`@_linked/core` (pinned by the checkout's lockfile, often older than the app's)
and a registry copy of any localized sibling in its `node_modules`, and Node
loads those instead of the app's. So after installing, and on every `--relink`,
`linked localize` removes from every checkout's `node_modules` its own copy of
`@_linked/*`, `react` and `react-dom` (plus its peerDependencies) when the app
has a version that satisfies the checkout's range; a localized sibling always
counts. A copy the app's version does not satisfy is kept, with a warning naming
the package, the range and the app's version. The checkout still builds and runs
its tests, resolving those packages from the app — this CLI included: npm puts
every ancestor's `node_modules/.bin` on the `PATH`, so `npx linked build` in a
checkout runs the app's `linked`. `--no-prune` keeps every checkout's
`node_modules` as npm left it. The
Vite config dedupes every installed `@_linked/*` package plus React as well, so
the dev server resolves them from the app root whatever a checkout has.

The work is done by [`@_linked/localize`](https://www.npmjs.com/package/@_linked/localize),
which is dependency-free and framework-agnostic; this CLI supplies the
build command and the list of what an app provides. That package's own binary, `linked-localize`, is the same mechanism with
three differences: it builds nothing unless given `--build "<cmd>"`, it treats only localized
siblings and peerDependencies as provided unless given `--provided "@_linked/*,react,react-dom"`,
and its verbs are subcommands —
`linked-localize adopt <pkg>` and `linked-localize remove <pkg>` where this CLI has
`linked localize --adopt <pkg>` and `linked delocalize <pkg>`. In a linked app, use
`linked localize`.

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
- `defaults/setup-publish/` — caller workflows + changeset files written by `linked setup-publish` (`main`-only; `--dual-branch` is a deprecated no-op)

### `linked create-app` template structure

`linked create-app <name>` copies `defaults/app-with-backend/` to the new app's folder, substitutes `${name}` / `${hyphen_name}` / `${app_prefix}` / `${app_domain}` placeholders in selected files, and copies `linked.backend.datasets.example.json` → `linked.backend.datasets.json` so first boot works zero-config. Dependencies are installed with `npm install`, and the next-steps message tells you to run `npm start`.

### `linked create-app --template react-native`

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
