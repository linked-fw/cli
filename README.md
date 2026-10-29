# @_linked/cli

Command-line tools for the `@_linked/*` packages and apps.

## Install

```bash
npm install --save-dev @_linked/cli
```

## Binary

One executable ships in this package: `linked`. (`lnk`, `lincd` and `lincd-cli` were dropped in
[#40](https://github.com/linked-fw/cli/pull/40).)

In a project that has `@_linked/cli` installed — any linked app — run it as
`npx linked <command>`. Everywhere else, name the package: `npx @_linked/cli <command>`.
A bare `npx linked` outside such a project does **not** reach this CLI: npm resolves it to the
unrelated `linked` package on the registry, which has no binary, and fails with
`could not determine executable to run`.

## Commands

Run `linked --help` for the full list. The commonly used ones:

### App scaffolding

```bash
linked create-app <name>          # scaffold a new app (interactive)
linked create-package <name>      # scaffold an ontology package, an asset package or both
linked create-ont-package <name>  # <name>-ont: one ontology, no shapes or components
linked create-asset-package <name># <name>-assets: shapes, components and a backend
linked create-shape <name>        # add a shape file to the current package
linked create-component <name>    # add a React component file
```

An app (`"linked": {"kind": "app"}`) is not a linked package: its root registers no package, and its shapes
live in its packages. A linked package is one of two kinds:

- an **ontology package**, `<name>-ont` — exactly one ontology (`src/ontologies/<name>.ts`), no
  shapes, components or backend. Its ontology slug is `<name>` (without `-ont`), so its terms
  mint `https://linked.cm/ont/<name>/{Term}`, or `<uri_base>{Term}` when a namespace is given.
  Its data is Turtle, `src/data/<name>.ttl` (starting as `<namespace> a owl:Ontology .`), which
  `loadData` reads on the server through `@_linked/core/ontology/loadOntologyFiles`. The package
  declares it in `package.json` `"linkedOntologies"`, and its accessor modules
  (`src/ontologies/<name>.ts`, `.data.ts`, `.register.ts`) are the ones `linked
  generate-ontology` writes (see [Ontology accessor modules](#ontology-accessor-modules)): add terms
  to the Turtle and run it. `create-ontology` scaffolds the same files and entry in an existing
  package.
- an **asset package**, `<name>-assets` — shapes, components and a backend, and no ontology.

`create-package` asks which on a terminal; `--kind ontology|assets|both` answers it (`both`
creates the pair), and without a terminal and without `--kind` it exits 1 and says so.
With `both` and `--location packages`, the asset package depends on the ontology package
(`"<name>-ont": "^<version>"`), which npm workspaces link locally. Anywhere else (`packages-local`
or outside an app) it gets no such entry, because `npm install` would look the unpublished `-ont`
package up in the registry and fail with E404; one line says to run `npm install <name>-ont` in
the asset package once the ontology package is published.
`create-ont-package` and `create-asset-package` are the two kinds spelled out. The suffix is
never doubled: `create-ont-package foo-ont` creates `foo-ont`. Every package they create says
what it is in `"linked": {"kind": "ontology"}` or `{"kind": "assets"}`. `create-shape`, `create-component`, `create-set-component` and
`create-ontology` refuse where there is no `src/package.ts` (a new app root has none) instead of
writing an import of a package that does not exist: run them inside `packages/<name>`. An app that
does have a `src/package.ts` at its root is served as before.

The files a kind gets are also available as data, for a host that commits a package somewhere
other than the local disk: `buildPackageFiles(packageName, kind, {uriBase?, baseUri?,
dependencies?})` from `@_linked/cli/utils/packageFiles` returns package-relative path → content,
dotfiles under their real names. It writes, asks and installs nothing; `create-package` writes
exactly what it returns.

A package's IRIs are minted under a root: `linkedPackage(name, {baseUri})`, shapes at
`{baseUri}shape/<package>/<Name>`, an ontology package's terms at `{baseUri}ont/<slug>/<Term>`.
The root is, first match wins: `--base-uri <uri>`; inside an app, `LINKED_BASE_URI` from the
shell, then from the app's `.env.local`, then its `.env`. With none of them the package declares
no root and mints under `https://linked.cm/`, the normal root for an open-source package. That is
not a warning; the command prints one informational line:
`Shapes and terms in <package> mint under https://linked.cm/. They resolve once the package is
published (npx linked publish, coming soon).`

Inside an app (a `package.json` with `"linked": {"kind": "app"}` above the current directory),
`create-package` puts the package in one of two places, and asks which on a terminal:

```bash
linked create-package @_linked/foo --location packages        # part of the app's repository
linked create-package @_linked/foo --location packages-local  # a repository of its own
linked create-package @_linked/foo --remote <git-url> [--push] # the same, with an origin
```

- `packages/foo` — a workspace member: added to the app's `dependencies` (and `packages/*` to its
  `workspaces` if missing), installed at the app root.
- `packages-local/_linked-foo` — the name `linked localize` uses. `git init` and a first commit,
  `origin` and `repository.url` from `--remote`, pushed with `--push`; then handed to
  `linked localize --adopt`, which sets the app up for checkouts if needed (`packages-local/*` in
  `workspaces`, the lock-at-rest hook, `.gitignore` and the matching lockfile; commit those), installs at the app root so npm
  links it as a workspace member, and builds it. It is not added to the app's `dependencies` until
  it is published. `--remote` or `--push` imply this location.

Any of the three flags skips the question. With none of them and no terminal, it exits 1 and says
which flag to pass. An existing target folder is refused. Outside an app nothing changes: the
package goes in `./packages/`, `./modules/` or the current directory, and installs on its own.

### Building

```bash
linked build                      # build the current package (tsc + checks)
linked build --skip-shape-check "<reason>"  # the same without the shape hierarchy check and shapes.ttl
linked build-app                  # build frontend + backend for the current app
linked build-app --target web     # web release: build and write public/bundles/linked-release.json
linked build-app --target capacitor  # Capacitor/local native build: local manifest only, never published
linked build-workspace            # build all linked packages in the workspace in dependency order
linked build-updated              # incremental: only packages that changed since last build
linked build-package <file>       # walk up from a file path to find its package and rebuild
```

`linked build` copies the non-TypeScript files of `src/` that a package ships (`.json`, `.d.ts`,
`.css`, `.scss` and `.ttl`) into `lib/esm/` at the same relative path, and into `lib/cjs/` when the
package publishes CommonJS. A package's ontology data, `src/data/<file>.ttl`, therefore lands in
`lib/esm/data/`, next to the compiled `lib/esm/ontologies/` modules that read it through
`import.meta.url`. `linked build-app` copies the app's own `src/**/*.ttl` into `lib/` beside the
compiled backend (a failed copy fails the build); framework and workspace packages stay external
to the backend build and read their own `lib/esm/data/`.

After compiling, `linked build` checks the package's shapes against the class hierarchy
(**Checking shape hierarchy**). In one `node` process it loads the built package's `package.js`,
`shapes/index.js` and ontology data (`ontologies/*.register.js`), and the ontology data of every
linked dependency (dependencies and peerDependencies, transitively), then runs
`@_linked/core/shapes/checkShapeHierarchy`. It reports a shape that extends another whose class its
data does not make a superclass (`extends-without-subclass`), a subclass whose shape does not extend
its superclass's shape (`subclass-without-extends`), a shape that inherits its parent's class instead
of declaring its own (`borrowed-target-class`), a term in a mirrored standard's namespace the
package's data does not define (`mirror-undefined-term`), and an override that widens what it
inherits (`override-not-tightened`). Every finding is printed; an `error` fails the build, warnings
alone do not. A package without shapes, or without a `@_linked/core` dependency, is not checked.
`linked build --skip-shape-check "<reason>"` skips the check, and the `shapes.ttl` step below, and
prints the reason.

Then it writes the package's shapes as Turtle to `lib/esm/data/shapes.ttl` (**Writing
shapes.ttl**). A `node` process loads the built `package.js` and `shapes/index.js` (every shape
module when there is no index) and calls `packageShapesTurtle(<package name>)` from the
`@_linked/core/shapes/shapesToTurtle` that the package resolves, so the file holds the same bytes
an app's server generates in process: shapes as declared, in core's fixed order. The server syncs
the package's shape graph (`{package IRI}/graph/shapes`) from this file by a content hash. A
package that registers no shapes, or has no `@_linked/core` dependency, gets no file (one left by an
earlier build is removed); a core without `shapes/shapesToTurtle` warns and writes none; a shape
module that throws fails the build. With `--skip-shape-check` the step is skipped with a warning.
Whenever no new file is written, one left by an earlier build is removed.

`linked build` exits with code 1 whenever the build does not succeed, including when it is run in an app or
in a package without a package `linked.kind` (it used to exit 0 there). A build that finishes with warnings still
exits 0.

### Ontology accessor modules

```bash
linked generate-ontology          # write src/ontologies/<prefix>.ts, .data.ts and .register.ts from src/data/*.ttl
linked generate-ontology --check  # write nothing; exit 1 when a module is out of date
```

A package declares its ontologies in `package.json`, one entry per prefix. `data` names files in
`src/data/` and defaults to `["<prefix>.ttl"]`; a package with several namespaces has several
entries:

```json
"linkedOntologies": {
  "rdf": {"namespace": "http://www.w3.org/1999/02/22-rdf-syntax-ns#"},
  "rdfs": {"namespace": "http://www.w3.org/2000/01/rdf-schema#"},
  "schema": {"namespace": "http://schema.org/", "data": ["schema.ttl", "schema-added.ttl"]}
}
```

Each prefix gets three committed modules in `src/ontologies/`:

- `<prefix>.ts`: one `export const Term = /*#__PURE__*/ ns('Term')` per subject of its data files
  in its namespace (enumeration members and individuals included), sorted by name, each with a
  one-line JSDoc from `rdfs:comment` (else `rdfs:label`). Nothing else, so consumers write
  `import * as schema from '@_linked/schema/ontologies/schema'` and `schema.Person`, and a bundler
  keeps only the terms used. A subject whose remainder after the namespace holds `/`, `#` or `?`
  is not a term, and the command lists it.
- `<prefix>.data.ts`: `ns`, `dataFiles`, `loadData`, `_ontologyResource` and `Prefix.add`.
  `_ontologyResource` is the ontology's own IRI as its data declares it with `a owl:Ontology`: the
  namespace, else the namespace without its trailing `#` or `/` (`http://www.w3.org/2002/07/owl`),
  else the only declaration the namespace starts with; otherwise the namespace.
- `<prefix>.register.ts`: the `linkedOntology(...)` call; `src/index.ts` imports it.

A term's export name is its local name made a valid identifier by one rule: a character that
cannot appear in an identifier becomes `_` (`ISO639-2` → `ISO639_2`), a leading digit gets a leading
`_` (`3DModel` → `_3DModel`), and a reserved word gets a trailing `_` (`yield` → `yield_`). There is
no alias map. Two terms that the rule gives one name are refused, naming both. The output is
deterministic: the same Turtle gives the same bytes.

`linked build` starts with **Checking ontology modules**: when a module differs from what the data
generates, or is missing, the build fails and says to run `linked generate-ontology`. A package
without `linkedOntologies` is not checked.

The generator itself is `@_linked/cli/utils/ontologyModules` (pure, browser-safe: it takes the
terms as data) and `@_linked/cli/utils/ontologyTerms` (reads them from Turtle with `n3`).

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

**A build needs no data server.** To find that store, `build-app` and `publish-app` load the app's
`linked.backend.files.{ts,js}` when it has one: a file that registers the file stores and nothing
else, which `linked.backend.storage.ts` imports so the server gets them too. The storage file is
not loaded, so no dataset store is built and a `RemoteDataset`'s `init()` never pings its data
server during a build. An app without the file falls back to loading the whole storage file, which
then has to boot without a data server or Fuseki for the build to finish. The app template ships
the file.

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
`preventDuplicates: false` and `preservePath: true`. A compatible store preserves the safe relative
key exactly and rejects absolute or traversal paths. Publishing fails with a clear message if the
store reports a different location. `@_linked/server`'s `LocalFileStore` supports this contract;
stores that do not support exact keys cannot publish a linked release.

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

`linked start` keeps one Vite dev server for the life of the process. A change to `.env`,
`.env.local`, `.env.<mode>` or `vite.config.*` takes effect at the next `linked start`: Vite
would restart its server for it, which closes the SSR module runner the backend was loaded by, and
every later `import()` in the backend would fail with "Vite module runner has been closed.".
Source changes are reloaded in place as before.

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

### Two copies of a framework package

Under `linked start` a package in the dev `ssr.noExternal` list is evaluated by Vite's SSR module
runner. If Node also loads one of its files (an external package importing a bundled one, or a
native `import()` in Node-loaded code), the app holds two copies of that module: classes from it
fail `instanceof` and its module state is set on one copy and read on the other. `linked start`
watches for this and prints, once per boot and once per file:

```
[linked] dual-copy guard: on
[linked] TWO COPIES: Node loaded @_linked/server-utils/lib/esm/utils/Server.js (imported as "@_linked/server-utils/utils/Server" from file:///…/node_modules/@_linked/schema/lib/esm/shapes/ImageObject.class.js), but @_linked/server-utils is bundled for the Vite SSR runner. Classes from it will fail `instanceof` and its module state exists twice.
```

The guard only warns, it never stops a boot. It sees Node's loads in the dev server process, not
the browser or a built app. A file counts when it is under `node_modules/@_linked/<name>/`, or when
the nearest named `package.json` above it is a bundled `@_linked/*` package (a localized checkout
or a workspace); `@_linked/cli` itself is never reported. `LINKED_DUAL_COPY_GUARD=0` turns it off
(`[linked] dual-copy guard: off (LINKED_DUAL_COPY_GUARD=0)`); it needs Node 22.15+ or 23.5+
(`module.registerHooks`) and says `off` with the Node version otherwise.

What the runner bundles: in a standalone app (no workspaces) every `@_linked/*` package except
`@_linked/core` and `@_linked/cli` (`STANDALONE_SSR_BUNDLED`), so a template app boots with no
`TWO COPIES` line. Core stays a single Node copy (its registries are on `globalThis`, and
`loadStores` imports stores through the loader `linked start` installs, which needs
`@_linked/core` 2.34.0 or later); the CLI is the Node process. With workspaces, only the source
workspaces, the installed packages that depend on them and `@_linked/server` are bundled.

`tests/e2e/dual-copy.spec.ts` keeps it that way: it installs this CLI build into an app made from
the template, boots it on its FusekiStore and with a `RemoteDataset`, and fails on a missing `on`
line or any `TWO COPIES` line. It also covers the browser: with `@_linked/shape-ui` installed (it
ships `src/`), headless Chromium loads `/` and the spec fails when any `@_linked/*` script module is
requested in two forms (plain and `?v=`, from two paths, or from Vite's optimizer and file by file),
naming each URL (`npm run build && npx playwright test tests/e2e/dual-copy.spec.ts`; no Docker,
`npx playwright install chromium` once; `E2E_SHAPE_UI=<version>` pins shape-ui). CI runs it as the `Dual-copy e2e` check on PRs that touch the Vite config, `linked
start`, the guard or the lockfile, and nightly on `main`.

### Developing a dependency from a git checkout

`linked localize` clones an npm dependency into `packages-local/`, which the app lists in its
`workspaces` (`"packages-local/*"`), so npm links and dedupes the checkout like any workspace
member. A hook the app's `postinstall` and `dependencies` scripts run (`hooks/lock-at-rest.cjs`
in this package, called through a guard that does nothing where the cli is not installed) puts the
committed `package-lock.json` back after every install, so the working tree stays clean and CI, which has no checkouts,
installs from the registry as always. Each new checkout is built with its own build command:
`npm run build` when it has a `build` script, nothing otherwise (`--build <cmd>` overrides it,
`--build ''` builds nothing). Full
guide: [docs/localize.md](docs/localize.md).

```bash
linked localize @_linked/rdfs          # clone, npm install at the app root, build
linked localize @_linked/rdfs --adopt  # the same for a checkout already in packages-local/_linked-rdfs
linked localize                        # checkouts, parked checkouts and drift (same as --list)
linked localize --list --check         # print only the drift; exit 1 when there is any
linked delocalize @_linked/rdfs        # park it in .packages-local.parked/, back to the registry copy
linked localize --parked               # take every parked checkout back
linked delocalize @_linked/rdfs --purge  # delete it instead (exit 6 on unsaved work on any branch, a stash, or git failing)
linked localize --listed               # clone what package.json lists in linked.unpublishedPackages (transitively)
```

**Unpublished packages.** A package an app uses that is not on npm (a project's ontology or asset
package in a private repo) is listed in the app's committed `package.json`:
`"linked": {"unpublishedPackages": {"acme-ont": {"repo": "https://github.com/org/acme-ont.git"}}}`.
A package lists its own the same way (an asset package lists its ontology package).
`linked localize --listed` clones every listed package, transitively, that is not in
`packages-local/` yet, on the app's branch where the package repo has it (else its default
branch), then installs once. Once a package is published it moves into `dependencies` with a
range. For private repos the token comes only from `LINKED_GIT_TOKEN` (see below); it is never
put in a URL or written to disk.

The first `linked localize` in an app sets it up — `"packages-local/*"` in `workspaces`, the
lock-at-rest hook in `postinstall` and `dependencies`, `packages-local/` and
`.packages-local.parked/` in `.gitignore`, and the matching lockfile (made before anything is
cloned) — so `git status` then shows exactly `package.json`, `package-lock.json` and `.gitignore`
to commit ([details](docs/localize.md#set-up)). Run it anywhere in the app: it acts on the topmost
directory whose `package.json` has `workspaces`. It also writes git hooks into the clone:
`pre-commit` refuses a manifest that names a checkout, and `post-merge`/`post-checkout` run
`npm install` when dependencies changed. They work for an app below the git top level; under
`core.hooksPath` (husky) localize writes nothing and prints the line to add to each hook. Use
`npm install`, not `npm ci`, while checkouts are present.

**Drift.** npm links a checkout whatever its version. `--list` and the check before `linked start`,
`script`, `call` and `build-all` report a range a checkout misses, a second copy of a localized
package, a nested copy of `@_linked/core`/`react`/`server-utils`, and a checkout that is gone.

### Integration branches and worktrees

One piece of work across the app and its `packages-local/` checkouts, on an integration branch
with a target recorded per repo (`branch.<name>.linked-target`). Agents work in worktrees on
`<integration>--<agent>` branches that share the main checkout's install (a `node_modules` link
farm in which the worktree's own checkouts win), and land locally with
`merge --ff-only`. Full guide: [docs/integration-branches-and-worktrees.md](docs/integration-branches-and-worktrees.md).

```bash
linked branch start overhaul --target main core   # app + packages-local/_linked-core on `overhaul`
linked branch status                              # per repo: branch, target, dirty, ahead/behind, off-branch
linked worktree add agent1 --with core --port 4041  # ../wt/agent1 with its own core worktree; Vite, tsc and Node load it
linked worktree relink                            # in a worktree: rebuild its node_modules link farm (after npm install in the main checkout)
linked worktree list                              # agent worktrees and whether each branch has landed
linked worktree remove agent1                     # refuses while a branch has not landed (--force, --delete-unlanded)
linked branch start m1 --worktree --with core     # a master: m1 in ../wt/m1 with its own core worktree; nothing switched
linked worktree add step1 --from m1 --with core   # a step of m1: ../wt/m1--step1, lands into ../wt/m1
linked branch land m1                             # owner approved: merge dev into m1, ff dev in each checkout, build, push
linked branch list                                # integration branches and masters (port, steps), and other apps' masters on this machine
linked branch add-package m1 react                # a framework package joins running master m1 (and its steps, by relink)
linked worktree relink --all                      # every worktree of the app, masters first (after npm install in the main checkout)
linked branch fork change-1 acme-ont              # in an app checkout: create and push change-1 in that package checkout
linked branch push change-1                       # in an app checkout: push change-1 in the app and every package checkout on it
linked branch merge change-1 --into main          # packages in dependency order, then the app: --no-ff merge, push main
linked branch merge change-1 --into main --mode update  # protected main: merge main into change-1, push it, land by PRs
linked release plan                               # per repo: commits, reports, changesets, release PRs, next action
linked doctor resolve                             # where Vite and Node load each @_linked package; exit 1 on two copies
```

**Branch checkouts** (a server making one checkout per project branch, such as Create Now):
`linked checkout <branch>` in a projects root makes one bare base clone per repo
(`<root>/.repos/<owner>/<name>.git`), the app as a worktree on `<branch>` (created from `--from`
and pushed when the remote lacks it) and each package of `linked.unpublishedPackages` as a
worktree in its `packages-local/` (on `<branch>` where its repo has it, else detached at
`origin/<default>`), then installs once in the app worktree. `--add <repo>` checks out one more
package no list names, without an install or a build. `--pin <npm>=<branch>` puts a package on a
branch of the caller's choosing (detached unless it is the run's own branch) and `--pins-only` drops the
same-name rule for the rest. `--json` prints what it did. `linked branch fork <branch> <pkg>
--worktree <dir>` makes a package branch in a worktree of its own, outside every app checkout, and
`linked branch push <branch> --worktree <dir>` pushes it.
Credentials come only from `LINKED_GIT_TOKEN`: remote git calls get it through `GIT_ASKPASS`
(`hooks/git-askpass.cjs`) with credential helpers and git hooks off; the install, the builds and
every local git call run without it.

```bash
linked checkout change-1 --repo https://github.com/org/acme-app.git --root /srv/projects --json
linked worktree remove --branch change-1 --dir /srv/projects/acme-app/change-1  # once every repo has landed
```

### Registry / dev utilities

```bash
linked publish                    # publish the current package (for non-CI flows)
linked register                   # register the package to the linked registry
linked status                     # show which packages need build/publish
linked depcheck                   # check for missing/unused deps
```

## Package kinds

Every `package.json` says what it is in `linked.kind`, merged into any other `linked` keys
(`linked.serverOnly`):

```json
{
  "linked": {"kind": "ontology"}   // or "assets", "library" (framework code), "app"
}
```

A linked package is any kind but `app`: `linked build` builds it, and boot loading, the ontology
sync, Vite's dependency exclusion and `build-all`'s dependency order find it. An `app` is built with
`linked build-app`. `linkedKind(json)` from `@_linked/cli/installed-packages` is the one reader
(`@_linked/server/utils/linkedDependencies` has a byte-identical twin).

A package can also declare its ontologies under `"linkedOntologies"` (see
[Ontology accessor modules](#ontology-accessor-modules)).

The `lincd`, `lincdApp`, `linkedPackage` and `linkedApp` flags are not read.

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

### Windows

The cli is written to run on Windows but nobody runs it there yet, so treat it as untested. It
starts `npm`, `npx` and `node_modules/.bin` shims through one helper (`src/utils/spawn.ts`: npm's
own `npm-cli.js` when npm started the cli, else the `.cmd` through `cmd.exe` with quoted
arguments), links directories with junctions, imports files by `file:` URL and keeps CRLF in the
files it edits. Known limits: commands given as one string (`linked all <cmd>`, a `--build`) run
in `cmd.exe` as written, so they must not use POSIX shell syntax; and this package's own
`test:template` script sets an environment variable the POSIX way.
For `linked localize`, see [docs/localize.md](docs/localize.md#windows).

### Templates

Templates live in `defaults/`:

- `defaults/app-with-backend/` — used by `linked create-app`
- `defaults/app-static/` — minimal static app
- `defaults/package/` — the asset package of `linked create-package` / `create-asset-package`; its manifest, tsconfigs, dotfiles and `src/package.ts` are shared by every kind
- `defaults/package-ontology/` — what an ontology package (`create-ont-package`) gets on top of the shared files: the example ontology, its register sibling and its data
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
    src/shell/              env.ts (API URL), storage.ts (RemoteDataset)
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
  `Person` through `RemoteDataset` → API → Fuseki. A Jest integration test covers it.
- **Babel plugin.** Metro rejects `import('x.json', { with: { type: 'json' } })`, which Linked ontology packages
  use; `apps/mobile/babel/stripJsonImportAttributes.js` drops that options argument. Core's Node-only
  `loadOntologyFiles` needs no plugin: its `react-native` export condition gives Metro a stub without `import()`.
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

`linked-fw/cli` on GitHub. License: MIT.
