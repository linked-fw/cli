# Changelog

## 1.22.2

### Patch Changes

- [#125](https://github.com/linked-fw/cli/pull/125) [`14f215f`](https://github.com/linked-fw/cli/commit/14f215f0c9d88ae03f29a3f169e8e0e731baa065) Thanks [@flyon](https://github.com/flyon)! - Document both `manualChunks` cycles and the invariant behind them — see
  `docs/reports/003-manual-chunk-cycles.md`.

## 1.22.1

### Patch Changes

- [#123](https://github.com/linked-fw/cli/pull/123) [`fe88c7d`](https://github.com/linked-fw/cli/commit/fe88c7d52d8aeb1c2d742b0fdf8f0dcc028ee6ba) Thanks [@flyon](https://github.com/flyon)! - The TypeScript loader resolves a relative `./x.js` onto `./x.ts`.

  This is the NodeNext convention — TypeScript requires the `.js` spelling in
  source that emits ESM and rewrites nothing — so a module written that way could
  previously only be loaded from a built `lib/`, never from source. The loader
  now falls back to the TypeScript file when the `.js` does not exist on disk,
  matching what `tsc` itself does.

  It matters most for a self-referential ontology namespace import
  (`import * as _this from './vocab.js'`), which is exactly the shape the
  framework's own ontology files use.

## 1.22.0

### Minor Changes

- [#121](https://github.com/linked-fw/cli/pull/121) [`a719ff5`](https://github.com/linked-fw/cli/commit/a719ff5718df8beb8b7f762ee8a3d876dbdc7599) Thanks [@flyon](https://github.com/flyon)! - Stop building CommonJS for packages that do not publish it.

  `linked build` ran a second full `tsc` pass, copied assets into `lib/cjs` and
  wrote a dual-package marker for every package — including the many that are
  `"type": "module"` with an import-only `exports` map, where nothing could ever
  resolve that output.

  Whether to build CJS is now read from the manifest: a package opts in by
  pointing `main` at a CJS build or declaring a `require` condition in `exports`.
  Packages that publish CJS are unaffected; the rest build faster and stop
  shipping a `lib/cjs` no consumer can reach.

  `packagePublishesCjs` is exported from `@_linked/cli/package-manifest` for
  tooling that needs the same answer.

## 1.21.5

### Patch Changes

- [#115](https://github.com/linked-fw/cli/pull/115) [`7c8315b`](https://github.com/linked-fw/cli/commit/7c8315bb38aecfeece419be6e77e424de1d5fab7) Thanks [@flyon](https://github.com/flyon)! - Keep registry-installed framework packages in the `linked` chunk.

  `manualChunks` grouped `@_linked/*` into `linked` only when the module resolved
  to a workspace path. An app can hold both at once — a published
  `@_linked/server` in `node_modules` alongside a workspace `@_linked/core` — and
  the published copy fell through to the catch-all `vendor` chunk. The two then
  imported each other, and Rollup's chosen order left a binding in its temporal
  dead zone: `Cannot access 'Wo' before initialization`, thrown before the app
  rendered anything.

  `node_modules/@_linked/*` and `node_modules/lincd-*` now join the workspace
  copies in `linked`.

## 1.21.4

### Patch Changes

- [#118](https://github.com/linked-fw/cli/pull/118) [`e9050cf`](https://github.com/linked-fw/cli/commit/e9050cf77f63c6b98d2cf657aeb5cfd1ee81c2c4) Thanks [@flyon](https://github.com/flyon)! - Compile the whole `src` folder, and let a bare import resolve under Node10.

  The build only emitted what an entry transitively reached, so any module
  nothing imported was never built — and never type-checked, so it rotted
  quietly. `include` now covers `src/**/*` with tests excluded explicitly.

  `typesVersions` maps every specifier through `lib/esm/*`, so a `types` value
  that already carried that prefix had it applied twice and no consumer on
  classic Node10 resolution could `import` the package by its bare name.

## 1.21.3

### Patch Changes

- [#116](https://github.com/linked-fw/cli/pull/116) [`0377581`](https://github.com/linked-fw/cli/commit/0377581afa4e97070a70f7cc263f2baf6d5e4a9d) Thanks [@flyon](https://github.com/flyon)! - Drop `optimize-css-assets-webpack-plugin`, so `npm install` and `npm ci` work without `--legacy-peer-deps`.

  The package declares `webpack ^5`, but this plugin's last release peers on
  `webpack ^4`. npm cannot satisfy both, so a plain install failed outright:

  ```
  npm error ERESOLVE could not resolve
  npm error While resolving: optimize-css-assets-webpack-plugin@6.0.1
  npm error Found: webpack@5.108.4
  npm error Could not resolve dependency: peer webpack@"^4.0.0"
  ```

  The workaround was `--legacy-peer-deps`, which silences every peer check in the
  tree, not just this one — and it left `npm ci` broken, so a clean
  lockfile-driven install never worked at all.

  Nothing imports the plugin: it appears only in `devDependencies`, with no
  reference anywhere in `src/`. It is also deprecated upstream in favour of
  `css-minimizer-webpack-plugin`, which is not needed here either, since the
  webpack config does not minify CSS through it.

  Removing it is the whole fix. `npm install` and `npm ci` both succeed with no
  flags, 28 fewer packages are installed, and the audit total drops from 20 to 19.

## 1.21.2

### Patch Changes

- [#113](https://github.com/linked-fw/cli/pull/113) [`476689a`](https://github.com/linked-fw/cli/commit/476689a2cce89639389b19daea2a240d929eacfd) Thanks [@flyon](https://github.com/flyon)! - Drop four declared-but-unused dependencies: `child-process-promise`, `css-parse`, `postcss-comment` and `postcss-strip-inline-comments`.

  None of them is referenced anywhere outside `package.json`. The only trace of
  any is a commented-out `// import parseCSS from 'css-parse';` at the top of
  `src/loaders/css-loader.mts`.

  They are worth removing rather than leaving because this package is a runtime
  dependency of `@_linked/server`, not just a build tool: `lib/esm/cli.js`
  statically imports `cli-methods.js`, so the whole dependency graph is loaded in
  the serving process. Carrying advisories for code nothing calls is pure cost to
  every consumer.

  Together they account for 7 advisories — `cross-spawn` (ReDoS) via
  `child-process-promise`, six `postcss` 5/6 advisories via the two postcss
  wrappers, and `decode-uri-component` via `css-parse` → `css` →
  `source-map-resolve`. None of the removed packages is the _current_ postcss:
  the real one is 8.5.28 and is unaffected.

  Typecheck clean, `test:unit` 303/303, build clean, and the audit total drops
  from 27 to 20 in this repo.

## 1.21.1

### Patch Changes

- [#109](https://github.com/linked-fw/cli/pull/109) [`2c6918c`](https://github.com/linked-fw/cli/commit/2c6918c0fefe08c65290b7cd28f7ab0b5b31aa4f) Thanks [@flyon](https://github.com/flyon)! - Stop `buildFrontend` calling the deprecated `LinkedFileStorage.getDefaultDataset`, and publish CDN assets under the names they were built with.

  The legacy `public/` upload path was the last caller of a `Dataset`-era alias in
  this package. Core forwards it to `getDefaultStore` today, but the aliases are
  removed in core's next major, so this was a dated build break. The swap is
  behaviour-free: `getDefaultStore` returns the same value, `undefined` included,
  so the truthiness guard reads the same.

  The same path published every file with a bare two-argument `saveFile`, leaving
  `preventDuplicates` unspecified. It now passes `false` explicitly, because a CDN
  publish is the one case where the key _is_ the address: `main-hwqwrAvA.css` has
  to land as `main-hwqwrAvA.css` or the name compiled into the HTML does not
  resolve, and republishing an unchanged build has to overwrite in place rather
  than leave a second copy behind under a different key.

## 1.21.0

### Minor Changes

- [#106](https://github.com/linked-fw/cli/pull/106) [`587b764`](https://github.com/linked-fw/cli/commit/587b7641cd90c853147bd42f9b13c8792b3b2a1f) Thanks [@flyon](https://github.com/flyon)! - Compile the app backend with Vite instead of bare `tsc`.

  `linked start` already loads `src/backend.ts`, `src/App.tsx` and
  `src/routes.tsx` through `vite.ssrLoadModule`, so production was resolving the
  same source a different way. `tsc` could not follow the workspace resolver or
  an extensionless relative import, it inferred `rootDir` from whatever happened
  to be in the program (so `lib/backend.js` could land in `lib/src/`), and being
  a typechecker first it failed the build on any type error anywhere in the app —
  including in files the backend never loads. Emitting and typechecking are
  separate concerns.

  Workspace packages are named in `ssr.external`. Vite will not externalize them
  on its own: a workspace symlink realpaths out of `node_modules`, and Vite
  refuses to externalize anything that does not look like it lives there, so they
  were all compiled into `lib/` — giving the app a second copy of
  `@_linked/core` and splitting `LinkedStorage`'s routing state from the one the
  storage config configures. A post-build check now fails the build if any
  workspace package ends up inlined, rather than leaving it to surface as a
  storage-routing error at boot.

  Note the consequence: a release build resolves workspace packages through their
  published exports, so **their `lib/` must be built and current**. A stale one
  fails the build with a message saying so.

## 1.20.0

### Minor Changes

- [#105](https://github.com/linked-fw/cli/pull/105) [`5263cc3`](https://github.com/linked-fw/cli/commit/5263cc3c5c596499507df7581205f1a92523fa35) Thanks [@flyon](https://github.com/flyon)! - Read `.env` before `.env-cmdrc.json`, and warn that the profile file is deprecated.

  The order was the other way round, which made migrating awkward: an app that
  added a flat `.env` next to its existing profile file saw none of it, silently.
  Now `.env` wins, so adding it _is_ the migration — the profile file can be
  deleted whenever convenient.

  `.env-cmdrc.json` is still read when it is the only file present, so no app
  breaks. It now warns that it, and the `--env` flag that exists only to serve
  it, are going away: a flat `.env` plus whatever the deployment injects into the
  environment replaces both. An app holding both files is told explicitly that
  the profile file and any `--env` name passed with it are being ignored.

## 1.19.2

### Patch Changes

- [#107](https://github.com/linked-fw/cli/pull/107) [`b031903`](https://github.com/linked-fw/cli/commit/b031903536ed0cdcee4fe46c485a78673e40f526) Thanks [@flyon](https://github.com/flyon)! - `build` now sets the executable bit on its bin output.

  `package.json` declares `"bin": {"linked": "lib/esm/launch.js"}`. A package
  manager sets that file's executable bit at install time; an in-place rebuild does
  not, and `lib/` is gitignored so git preserves no mode either. So after a local
  rebuild, anything spawning `linked` fails with `EACCES` on a file that plainly
  exists — a confusing failure, and one that has bitten the integration harness.

  `npm run build` now ends with `chmod +x lib/esm/launch.js`.

## 1.19.1

### Patch Changes

- [#102](https://github.com/linked-fw/cli/pull/102) [`f3f2ea9`](https://github.com/linked-fw/cli/commit/f3f2ea918a357b683b1f9005d533776471d1d7ab) Thanks [@flyon](https://github.com/flyon)! - Keep `react-router` and `@remix-run/router` in the `react-vendor` chunk.

  `react-router-dom` was grouped with React but `react-router`, which it
  re-exports, was left in the catch-all `vendor` chunk. That made the two chunks
  import each other — `vendor` also runs `React.createContext(...)` at module
  scope — and Rollup resolved the cycle by running `vendor` first, so every
  production build threw `Cannot read properties of undefined (reading
'createContext')` before the app rendered a single frame.

  The chunk routing is now exported as `chunkForModuleId` and covered by unit
  tests, since getting it wrong produces a bundle that builds cleanly and only
  fails in the browser.

## 1.19.0

### Minor Changes

- [#100](https://github.com/linked-fw/cli/pull/100) [`8ef0fd7`](https://github.com/linked-fw/cli/commit/8ef0fd7f810dfff26b95f5390565661b8c38c7ac) Thanks [@flyon](https://github.com/flyon)! - ## App release pipeline on the file-store API

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

## 1.18.0

### Minor Changes

- [#98](https://github.com/linked-fw/cli/pull/98) [`0d2c4c0`](https://github.com/linked-fw/cli/commit/0d2c4c04f7354af8add4a31c2780597b61d27098) Thanks [@flyon](https://github.com/flyon)! - `setup-publish` scaffolds the consolidated pipeline: two thin caller stubs (`pr.yml`, `publish.yml`) for the shared reusable workflows in `linked-fw/.github` instead of three standalone workflows, and `--configure-github` applies the uniform branch-protection profile (required check `checks / Build & Test`, non-strict, admins enforced). `publishConfig.provenance` is no longer stripped now that publishing is OIDC-first, and `--dual-branch` is a deprecated no-op.

## 1.17.0

### Minor Changes

- [#94](https://github.com/linked-fw/cli/pull/94) [`b4140fd`](https://github.com/linked-fw/cli/commit/b4140fdb7ed0face4978d5436e0cee2876eb1d09) Thanks [@flyon](https://github.com/flyon)! - npm is now the CLI's default package manager; yarn is detected, not assumed.

  A new `detectPackageManager()` walks up from the directory being acted on and
  only reports `yarn` when the tree actually is a yarn project (`yarn.lock`,
  `.yarnrc.yml`, a vendored `.yarn/releases/`). The nearest marker wins, so an npm
  package checked out inside a yarn workspace is treated as npm. Everything else
  is npm. Existing yarn monorepos keep working; `linked yarn` (safe-yarn) is
  unchanged.

  What changed per command:

  - `linked build-workspace` runs each package's build with `npm run build`
    instead of always `yarn build` (still `yarn build` inside a yarn workspace).
  - `linked build <path>` (the editor hook) invokes the `linked` binary via
    `npx --no-install` instead of always `yarn exec` (yarn, including a vendored
    release, is still used inside a yarn workspace).
  - `linked create-package` installs with npm unless the new package lands inside
    an existing yarn project. `planPackageSetup()` gained an
    `insideYarnProject` argument; having yarn on `PATH` no longer selects it. The
    closing hint now names the package manager that was actually used.
  - `linked publish` uses `npm version … --no-git-tag-version && npm publish`
    outside a yarn project (Berry's `yarn version` / `yarn npm publish` is kept
    inside one).
  - The backend TS compile step uses `npx --no-install tsc` outside a yarn
    project.
  - Capacitor setup installs with npm and writes `npx cap …` / `npm run …`
    scripts instead of `yarn cap …`.
  - The `create-package` template (`defaults/package/package.json`) builds with
    `npm run …` and bare local bins, so a scaffolded package no longer needs yarn.

  Also: the CLI's own `build`, `dev`, `test` and `format` scripts no longer shell
  out to `yarn`, so `npm run build` works without yarn installed (previously it
  failed under Yarn Berry with "the nearest package directory doesn't seem to be
  part of the project", and needed a Yarn 1 shim). Stale yarn mentions in the
  README, help text and comments now say npm.

### Patch Changes

- [#94](https://github.com/linked-fw/cli/pull/94) [`2ec3601`](https://github.com/linked-fw/cli/commit/2ec3601cd473ffbcbd6bfd5fdf4031c28efb48ab) Thanks [@flyon](https://github.com/flyon)! - Declare npm as the package manager for this repo and mark `package-lock.json` as a generated file.

## 1.16.0

### Minor Changes

- [#93](https://github.com/linked-fw/cli/pull/93) [`4b944dc`](https://github.com/linked-fw/cli/commit/4b944dc5a0a37b7858cb8f34d078879965f8b648) Thanks [@flyon](https://github.com/flyon)! - `create-app` now scaffolds web apps with npm.

  The web template used to install with yarn (and prompted for a package manager
  when both were on PATH); it now always runs `npm install`, matching the
  react-native template, and the next-steps message prints `npm start`. The empty
  `yarn.lock` that create-app wrote to pin down Yarn's project-root search is no
  longer created, so a new app has a single npm lockfile.

  create-app also strips every yarn project file from the clone (the legacy
  `yarnrc.yml.template` it used to rename into `.yarnrc.yml`, plus `.yarnrc.yml`,
  `.yarn/` and any `yarn.lock` the template still carries), so a scaffolded app is
  an npm project end to end.

## 1.15.3

### Patch Changes

- [#73](https://github.com/linked-cm/cli/pull/73) [`92e8f6b`](https://github.com/linked-cm/cli/commit/92e8f6ba07b80f3a72adae9238bd855fc94869b6) Thanks [@abdipramana](https://github.com/abdipramana)! - `linked start --vite`: widen development config discovery so apps that predate
  the current filenames still start.

  - The app's linked config is now looked up as `linked.config.js` **or** the
    legacy `lincd.config.js` (current name wins when both exist). Apps that never
    renamed the file silently lost their whole `server` block — `cachePaths`,
    `apiOnly` and the rest of LinkedServer's options — because only the new name
    was read. The lookup is exposed as `resolveLinkedConfigPath()`.
  - SSR page discovery also skips `*.d.ts` files in `src/pages/` (alongside the
    existing `.test` / `.spec` skip). Type declarations have no runtime module,
    so preloading them into the SSR graph only produced errors.
  - The backend storage config is discovered under several legacy filenames
    (`backend-storage-config.*`, `scripts/backend-storage-config.*`,
    `scripts/storage-config.js`) in addition to `linked.backend.storage.*`.

## 1.15.2

### Patch Changes

- [#71](https://github.com/linked-cm/cli/pull/71) [`b3e482b`](https://github.com/linked-cm/cli/commit/b3e482bdd55a43fb5fe9a11ab58d06e6bea66f5d) Thanks [@carlenmy](https://github.com/carlenmy)! - `createViteConfig`: give each app a unique HMR websocket port, derived from its
  dev port (`PORT` env override, else `opts.port`), instead of Vite's shared
  default `24678`.

  Every app built on `createViteConfig` defaulted to `24678` for HMR, so running
  two of them at once (parallel worktrees / multiple `@_linked` apps on one
  machine) collided — `WebSocket server error: Port 24678 is already in use`, and
  HMR silently broke for the loser. The port is now `24678 + (devPort - 4040)`, so
  apps that already use distinct dev ports get distinct HMR ports for free.

  The derivation lives in the new exported `hmrPortFor()` helper and is defensive
  about its input: a `PORT` that is not a whole port number (`PORT=abc`, a
  negative or out-of-range value) falls back to the `4040` default rather than
  producing `NaN`, and the derived port is clamped into `1024`–`65535`. Apps can
  still override via `server.hmr` in their own merged config.

## 1.15.1

### Patch Changes

- [#72](https://github.com/linked-cm/cli/pull/72) [`3bab3ab`](https://github.com/linked-cm/cli/commit/3bab3ab287ad72dff74c21f15d93a6229702b0e6) Thanks [@flyon](https://github.com/flyon)! - Backend provider HMR reloads are now debounced and serialised.

  `vite.watcher.on('change')` called `server.onSourceChange(pkg)` once per changed
  file with no debounce and no queue. Since `onSourceChange` disposes a package's
  providers and re-registers their Express routes, it mutates the shared router
  stack — and a multi-file save, a format-on-save, or a branch switch ran several
  of those dispose/re-register cycles concurrently against that same stack with
  nothing ordering them.

  Changed packages are now collected over a 150 ms window and their reload cycles
  run one at a time on a promise chain. Reload failures are still logged per
  package and no longer abort the cycles queued behind them.

  No API change; dev-server behaviour only.

## 1.15.0

### Minor Changes

- [#86](https://github.com/linked-cm/cli/pull/86) [`1f8908f`](https://github.com/linked-cm/cli/commit/1f8908fa276a5b65ed3ffe1c1e3bc23417ef9043) Thanks [@flyon](https://github.com/flyon)! - Always rewrite emitted ESM import specifiers

  `linked build` appends `.js` (or `/index.js`) to relative specifiers in `lib/esm` for every package, with no
  opt-in. The rewrite covers the emitted `.d.ts` declarations as well as the `.js`, so consumers on TypeScript
  `node16`/`nodenext` resolution get valid declarations. For a package that already writes `.js` specifiers the
  rewrite is a no-op.

  It runs at the end of the build, after the assets and hand-written declarations have been copied into `lib` and
  after stale output has been removed, so every specifier is resolved against the files the package actually ships.
  Asset imports such as `./styles.scss` resolve and are left as written, copied `.d.ts` files are rewritten too, and
  a leftover `x.js` can no longer make `./x` point at a file the cleanup then deletes.

  Also in this release:

  - The `missing_extension` rule is gone from the import check, in the build gate and in `linked check-imports`.
    Extensionless relative imports in source no longer fail the build; the rewrite warns about any relative
    specifier it cannot resolve, and Vite, Metro and `tsc` catch the rest. `outside_package` and the
    internal-import rule remain hard errors for every package.
  - The rule that stops a package reaching into another Linked package's internals now actually fires. It matched
    only import paths containing the literal string `lincd`, so after the rename to the `@_linked/*` scope it was a
    no-op for every current package: `@_linked/core/lib/esm/utils/Shape` passed. It now matches `@_linked/<pkg>/...`
    as well as `lincd`-prefixed package names, on a `/src/` or `/lib/` path segment, and is called
    `isInternalLinkedImport`. This can fail builds that previously passed — which is the point: such an import
    breaks when the other package changes its build layout and bypasses its exports map. Import the public subpath
    instead. Relative specifiers are exempt, so a local `./lib/helpers` is still fine.
  - Both import rules now see every form that names a module — `export ... from`, `import()` in value and type
    position, and `import x = require()` — not just `import ... from`.
  - `linked check-imports` prints the report and exits 1 when an import is invalid, instead of exiting 0.
  - `linked build` reports failures accurately: a step that fails names itself instead of a bare "Build failed",
    and a failed build always exits non-zero, including under `--silent` and when building updated packages.
  - `isImportOutsideOfPackage` normalises the path before judging it, so `./a..b` is no longer flagged and
    `../a/../b` is counted as the one level it actually climbs.
  - A relative specifier with a trailing slash (`./file/`) names a directory, so it resolves to `./file/index.js`
    and never to a sibling `./file.js`.

  A package without a `tsconfig-esm.json` has no ESM build, so the rewrite step is skipped rather than failing. When
  `tsconfig-esm.json` is present but `lib/esm` was not emitted, the build fails.

## 1.14.1

### Patch Changes

- [#83](https://github.com/linked-cm/cli/pull/83) [`566cb44`](https://github.com/linked-cm/cli/commit/566cb44f8728f25e852987ed4426063df9575492) Thanks [@flyon](https://github.com/flyon)! - React Native template: the integration test setup now tells apart "Docker is not installed", "Docker Compose is unavailable" and "Compose Fuseki is not running" (unit-tested in the scaffold); the integration Jest config comment says "Integration tests". README: document that `linked build` exits 1 whenever the build does not succeed (including in a `linkedApp` or a package without `linkedPackage: true`), and 0 with warnings. Reworded a stale migration comment in `linked start`.

## 1.14.0

### Minor Changes

- [#81](https://github.com/linked-cm/cli/pull/81) [`d1c0729`](https://github.com/linked-cm/cli/commit/d1c07296a9470ed3c995ce83a9ade22c0632395c) Thanks [@flyon](https://github.com/flyon)! - `create-app --template react-native` now scaffolds the Linked backend next to the app.

  - `services/api`: an API-only Linked backend (`linked start --api-only`) on `@_linked/server`, with Fuseki through `linked.backend.datasets.json`, a local file store (or `S3FileStore` when the S3 variables are set), a Fuseki reachability check and `node --test` unit tests.
  - A root `docker-compose.yml` for Fuseki (`secoresearch/fuseki:5.5.0`, host port `FUSEKI_PORT`), root scripts `fuseki:up`, `fuseki:down`, `api`, `check:react`, `lint`, `typecheck`, `test` and `test:integration`, a root ESLint flat config (with a rule that keeps `apps/mobile` on `@_linked/server` subpath imports) and a "Before every PR" checklist in the README (the template ships no CI workflow).
  - Pins `@_linked/server` 2.3.0, `@_linked/server-utils` 1.2.0 and `@_linked/cli` 1.13.0.
  - `apps/mobile/babel.config.js` registers a Babel plugin that strips JSON import attributes (`import('x.json', { with: { type: 'json' } })`), so Metro bundles Linked ontology packages.
  - `resolveApiUrl` ignores a non-string `extra.apiUrl`: the dev-client manifest delivers `null` as `{}`, which crashed the app with "LincdServerProxy requires a root URL".
  - `apps/mobile` imports `@_linked/react/native` (1.5.0) instead of its own render defaults, resolves the API URL in `app.config.ts` and `src/shell/env.ts`, and sends queries to the API through `BackendAPIStore`. The root `overrides` entry is gone.
  - An example add/edit/delete screen (`PersonOverview`, `PersonPreview`), ported from the web app-template to React Native with `@_linked/schema`'s `Person`, with a Jest integration test against the running API and Fuseki.
  - The shapes package sets `"linked": {"extensionlessImports": true}`, so `linked build` emits Node-loadable `lib/esm`.
  - With `linked.extensionlessImports`, `linked build` fails when `lib/esm` was not emitted (no `tsconfig-esm.json`), finishes "with warnings" listing every relative specifier it could not resolve, and handles `'.'`, `'..'` and `'./dir/'`. `linked build` now exits non-zero when the build fails.
  - README: documents `linked start --api-only` / `server.apiOnly`, the `extensionlessImports` flag, and the react-native template as it is now.
  - Integration tests only reset a Fuseki that is this repo's Compose `fuseki` on localhost (`docker compose port fuseki 3030`) with a `-test` dataset. They read `services/api/.env` (the shell wins), pass every `FUSEKI_*` variable to the API explicitly, blank the S3 variables (removing `AWS_REGION`, which `@_linked/s3` rejects when empty), and kill the API's process group on timeout, early exit, SIGINT, SIGTERM and exit. `INTEGRATION_API_BIN` and `INTEGRATION_API_TIMEOUT_MS` exist for testing that cleanup.
  - Load order is enforced by imports: `storage.ts` imports `env.ts`, and the example linked components import `storage.ts`. The default API port is shared from `apps/mobile/src/shell/apiPort.json`.
  - `wait-for-fuseki.mjs` honours `WAIT_FOR_FUSEKI_TIMEOUT_MS`. New tests: `storage.test.ts` (load order) and `waitForFuseki.test.mjs`. Local uploads go to `services/api/data/uploads/`, which is gitignored.
  - `linked call` (a direct `callBackendMethod`) now prints the error and exits 1 when the method is unmatched or fails, instead of an unhandled rejection.
  - The Fuseki dataset names (`<prefix>-dev`, `<prefix>-test`) are stamped from the app prefix.
  - Shipped dotfiles are restored at any depth, and `env.example.template` becomes `.env.example`.

## 1.13.0

### Minor Changes

- [#79](https://github.com/linked-cm/cli/pull/79) [`fd27a8d`](https://github.com/linked-cm/cli/commit/fd27a8d827b591c2d6db6bd2a7db1aa1de94b71d) Thanks [@flyon](https://github.com/flyon)! - Add `linked start --api-only` for a Linked backend without a web frontend.

  - No `vite.config.*` is required: without one, Vite runs with the `createViteConfig()` defaults inline, so TypeScript, decorators and extensionless imports in source-only shape packages still work.
  - No `src/App.tsx` or `src/routes.tsx` is loaded. The CLI sets `server.apiOnly` on the LinkedServer config instead of the page rendering hooks, so `/call/...` and `/api/...` routes are served and page requests get a 404 (needs a `@_linked/server` release that honours `server.apiOnly`).
  - The mode is explicit and never inferred from missing files. `server.apiOnly: true` in `linked.config.js` turns it on too.
  - `LinkedServerConfig` gains the `apiOnly` field.

  Add `"linked": {"extensionlessImports": true}` to a package's `package.json` for packages whose source uses extensionless relative imports (for example, shapes shared with React Native, where Metro does not map `.js` specifiers to `.ts` source).

  - `linked build` skips the "Checking imports" step for that package and logs that it did.
  - After compiling ESM, it appends `.js` (or `/index.js` for a directory) to extensionless `./` and `../` specifiers of static imports, exports and `import()` calls in `lib/esm/**/*.js`, so the output loads under Node. Specifiers it cannot resolve are left unchanged with a warning. `.d.ts` files are not rewritten.
  - Packages without the field build exactly as before.

  Fix linked-package discovery in `linked start` for apps inside an npm/yarn workspaces monorepo: dependencies are now resolved the way Node resolves them, walking up parent `node_modules` directories to the workspace root. A linked package hoisted to the root `node_modules` is found, so the app no longer falls into standalone mode (which dropped the `development` export condition).

  In workspace mode, `linked start` now bundles only the discovered source workspaces through Vite SSR (`ssr.noExternal`). Published framework packages installed in `node_modules` (such as `@_linked/core`) stay external and load through Node. Before, every `@_linked/*` package was force-bundled, so Vite ran its own `@_linked/core` while a store loaded by core's `loadStores` through a native `import()` (for example `@_linked/fuseki/shapes/FusekiStore`) pulled in a second, Node-loaded core. That split the shape registry ("Cannot resolve an rdf:type for shape"). An installed package that depends (directly or transitively, through `dependencies` or `peerDependencies`) on a discovered workspace is bundled too. For example, when `@_linked/core` is itself a source workspace, a published `@_linked/fuseki` goes through Vite and uses the same core. Only the dependency closure of the app and its workspaces is scanned.

## 1.12.0

### Minor Changes

- [#77](https://github.com/linked-cm/cli/pull/77) [`38cf9a7`](https://github.com/linked-cm/cli/commit/38cf9a77dbeab632e617846a51d75c41a6f6edda) Thanks [@flyon](https://github.com/flyon)! - Add `linked create-app <name> --template react-native`, which scaffolds a Linked React Native monorepo.

  The template ships in the CLI as `defaults/app-react-native` and needs no git clone. It generates an npm
  workspaces monorepo:

  - `apps/mobile`: an Expo SDK 57 / React Native 0.86 / React 19.2 app, with its Metro and Jest configuration
    already set up for `@_linked/*`, and render defaults that replace `@_linked/react`'s `<svg>` loader and error
    elements. Tests cover shape registration and those defaults.
  - `packages/<prefix>-shapes`: a Linked shapes package, consumed as TypeScript source.
  - `services/api`: a backend stub.

  The app's identity is stamped into named places only: the shapes package name, the monorepo name, and
  `app.json` `name`, `slug` and the reverse-domain `ios.bundleIdentifier`. The `${…}` substitution the web template
  uses is not applied, so template literals in the sources stay intact. Dependencies install with npm. `ios/` is
  generated by `expo run:ios` and is not committed. `--template web` stays the default and is unchanged.

  Before writing anything, the React Native path checks that `--app-prefix` matches `^[a-z][a-z0-9-]*$` (it becomes
  a directory, an npm package name, a bundle-ID label and part of a Jest pattern) and refuses a target folder that
  exists and is not empty. A failed `npm install` keeps the files but fails the command, and `create-app` exits
  non-zero whenever it fails. The template pins `expo-dev-client` and `@react-native/jest-preset` explicitly, so it
  does not depend on npm auto-installing peers.

  Also fixes `linked create-package` when the CLI is installed from npm. npm honoured the template's nested
  `.npmignore` when packing the CLI, so `defaults/package/src` was missing from the published tarball and new
  packages had no `src/`. Yarn-packed builds were unaffected. The template now ships the file as
  `npmignore.template`, and `create-package` renames it back. `.gitignore` files in templates get the same
  treatment.

### Patch Changes

- [#77](https://github.com/linked-cm/cli/pull/77) [`32791fd`](https://github.com/linked-cm/cli/commit/32791fd80b3c2b8849a35dfa4483785b601cc8b2) Thanks [@flyon](https://github.com/flyon)! - Publish only what the CLI needs at runtime: a `files` allowlist (`lib`, `defaults`, README, CHANGELOG, LICENSE) keeps test fixtures, Playwright `test-results/` and `package-lock.json` out of the tarball.

  Fix `linked create-package` failing at its final step. With Yarn 2+ the new package was installed with Plug'n'Play (no `node_modules`), so `npm exec linked build` could not find the binary. Scaffolded packages now get `nodeLinker: node-modules` under Yarn 2+, the initial build runs through the CLI that is already executing, and a failed install or build sets a non-zero exit code.

## 1.11.2

### Patch Changes

- [#74](https://github.com/linked-cm/cli/pull/74) [`b6969b1`](https://github.com/linked-cm/cli/commit/b6969b174a7e0c571a318aff7b69c601d97f3e41) Thanks [@flyon](https://github.com/flyon)! - Make `linked create-package` produce a package that builds.

  Four things stopped it, none of which the scaffolded output survived:

  - The final step ran `npm exec lincd build`. `lincd` is the **old** CLI's binary, and its
    compiled output imports `lincd/lib/esm/utils/LinkedFileStorage.js`, which the current
    workspace does not ship. The result was `Could not install dependencies` and no build.
    It now runs `linked build`.
  - The template's `src/package.ts` destructured `linkedComponent` from `linkedPackage()`.
    That is not part of core's `LinkedPackageObject` — component binding lives in
    `@_linked/react` — so every new package failed to compile on its own boilerplate.
  - The ontology template imported `NamedNode` from bare `@_linked/core`. The symbol no
    longer exists there, and the bare specifier cannot resolve under the template's
    `moduleResolution: "node"` anyway. It now uses `NodeReferenceValue`, matching how the
    framework's own ontologies are written.
  - `src/index.ts` had `import './types'` with no extension, which the CLI's own import check
    rejects.

  Verified by scaffolding a package and building it: ESM, CJS, dual-package output, import
  check and dependency check all pass with no edits.

## 1.11.1

### Patch Changes

- [#68](https://github.com/linked-cm/cli/pull/68) [`441372f`](https://github.com/linked-cm/cli/commit/441372f82706abb7b89d08d5b3b4348df04c5554) Thanks [@flyon](https://github.com/flyon)! - `linked create-app` now stamps the chosen app identity into the scaffolded app. The app template ships without `${var}` scaffold placeholders (so a raw clone boots on defaults), so create-app writes the real per-app values after cloning: `.env`/`.env.example` (`APP_NAME`, `APP_PREFIX`), `package.json` `name`/`displayName`, the runtime `linkedPackage(...)` id in `src/package.ts`, and the pm2 / VS Code launch names. Both the `--app-name` flag and the interactive prompt now produce an app that carries the chosen name (previously every scaffolded app inherited the template defaults).

## 1.11.0

### Minor Changes

- [#66](https://github.com/linked-cm/cli/pull/66) [`e11d012`](https://github.com/linked-cm/cli/commit/e11d012d05b61e13ae6ebe7e2ca5b6d59df47bee) Thanks [@flyon](https://github.com/flyon)! - Native `.env` support, app-name for the client bundle, and standalone SSR single-instance fixes.

  - **`.env` loading** — `ensureEnvironmentLoaded` now loads the app environment from a flat `.env` via Node's native `process.loadEnvFile` (no `env-cmd` dependency) when no `.env-cmdrc.json` is present. `.env-cmdrc.json` still takes priority when it exists (profile-based, honours `--env a,b`), so existing apps are unaffected. When neither file exists the cli no longer hard-exits — it relies on the ambient environment (e.g. env injected by a host at spawn time). The original shell environment is still re-applied last, so it wins over file values.
  - **`process.env.APP_NAME`** is now inlined into the client bundle (like `SITE_ROOT`/`NODE_ENV`), so components can render the app display name; defaults to `'Linked App'` when unset.
  - **Standalone SSR** now dedupes and bundles the React-context holders (`@_linked/server-utils`, `@_linked/react`) into a single instance, fixing a null `AppContext` during SSR in ejected/standalone apps.

## 1.10.0

### Minor Changes

- [#64](https://github.com/linked-cm/cli/pull/64) [`b16a090`](https://github.com/linked-cm/cli/commit/b16a0902943ff361e31d15d7779922cc5fca811f) Thanks [@flyon](https://github.com/flyon)! - - Standalone apps: framework packages (`@_linked/*` / `lincd-*`) are excluded from Vite's dep-optimizer so the browser loads one copy of each — fixes class-name duplication (`Person`→`Person2`) that broke cross-runtime shape lookup and the app's write path.
  - The client build now defines `process.env.SITE_ROOT` / `NODE_ENV` (webpack `EnvironmentPlugin` parity); apps add their own public env vars via `define` in their `vite.config.ts`.
  - A single `FRAMEWORK_PKG_PATTERNS` constant now drives every single-instance lever (`optimizeDeps.exclude`, `ssr.noExternal`).

## 1.9.1

### Patch Changes

- [#62](https://github.com/linked-cm/cli/pull/62) [`61be66a`](https://github.com/linked-cm/cli/commit/61be66a63d915e80fb0b2c1d12820a23dfbff17a) Thanks [@flyon](https://github.com/flyon)! - Workspace-member clones (e.g. per-branch `apps/<app>/<branch>` checkouts with symlinked `@_linked/*` sources) now boot under `linked start`: their linked deps are excluded from Vite's dep optimizer so the workspace source resolver handles them, instead of esbuild failing to pre-bundle symlinked package subpaths (`No known conditions for ./shapes/SHACL`).

## 1.9.0

### Minor Changes

- [#59](https://github.com/linked-cm/cli/pull/59) [`98dbb5a`](https://github.com/linked-cm/cli/commit/98dbb5a7767aed3ee1da62009c096eeb76b2c377) Thanks [@flyon](https://github.com/flyon)! - ESM-only. Dropped the CommonJS build; ships ES modules only (`type: module`, no `require` export condition, no `lib/cjs`). Fixed the root `types` field. CJS consumers on Node 22+ can `require()` it (sync ESM) or use dynamic `import()`.

- [#59](https://github.com/linked-cm/cli/pull/59) [`647417b`](https://github.com/linked-cm/cli/commit/647417bdcfbd5603daeb02ffd9ddc94f702a960e) Thanks [@flyon](https://github.com/flyon)! - Standalone dev + template git-clone scaffolding:

  - **Standalone dev resolution** — `createViteConfig` now detects when an app is NOT inside a workspace (lib-only npm install of `@_linked/*`) and resolves those deps via `import → lib/esm` (conditions `['module','node']`) instead of the `development → src` export they don't ship. Fixes "Failed to load `@_linked/server/shapes/LinkedServer`" on a clean install. Monorepo/workspace dev is unchanged.
  - **`create-app` clones the template repo** — new apps are scaffolded by `git clone`-ing `linked-cm/app-template` (single source of truth, same repo CN's server-side project creation uses) instead of copying a bundled defaults tree. The bundled `defaults/app-with-backend` is removed.
  - Removed the orphaned tsx `register`/`register-css-only` loaders (+ `tsx` dep); apps run plain `linked start` (Vite handles TS transform).

## 1.8.2

### Patch Changes

- [#57](https://github.com/linked-cm/cli/pull/57) [`e8385bd`](https://github.com/linked-cm/cli/commit/e8385bd4d4287afd85fbb86d6d4d20b1ea7152a7) Thanks [@flyon](https://github.com/flyon)! - CLI sub-template imports updated to use `@_linked/core` instead of legacy
  `lincd/...`:

  - `defaults/shape.ts` — `Shape` + `NamedNode` from `@_linked/core`
  - `defaults/package/src/package.ts` — `linkedPackage` from `@_linked/core/utils/Package` (clean 1:1 swap; `@_linked/core` exports it identically)
  - `defaults/package/src/ontologies/example-ontology.ts` — `NamedNode` + `createNameSpace` from `@_linked/core` (unused `lincd-jsonld` import dropped)

  **Important caveat — TODO comments inline in the template files explain**:
  the `package.ts` template is a clean working swap. The `shape.ts` and
  `ontologies/example-ontology.ts` templates' generated output **will fail
  to compile** because `@_linked/core` doesn't export `NamedNode` or
  `Literal` as runtime classes — the new framework architecture moved past
  direct node construction. Templates need a rewrite to emit the modern
  getter-only `@_linked/*` shape pattern (see `@_linked/schema/shapes/Person.ts`).
  The import-path change is a deliberate signal-of-intent that lands
  incomplete; the actual template rewrite is tracked as downstream
  Shape-Builder / Ontology-Manager review work.

  Users of `linked create shape Foo` and `linked create package Bar`: if you
  hit "Cannot find name NamedNode" or "Cannot find name Literal" errors
  in scaffolded files, you've hit the documented gap. The fix path is the
  template rewrite, not reverting to legacy lincd.

  Context: see create-now plan-011 report (docs/reports/009-legacy-lincd-eradication.md).

## 1.8.1

### Patch Changes

- [#54](https://github.com/linked-cm/cli/pull/54) [`5d475c7`](https://github.com/linked-cm/cli/commit/5d475c718a5435ebf8d9ce0db358ebcb84a91642) Thanks [@flyon](https://github.com/flyon)! - `setup-publish` now generates publish workflows that author the changesets "Version Packages"
  PR (and, for dual-branch, the post-release sync) via an org **GitHub App token**
  (`actions/create-github-app-token`, org secrets `RELEASE_APP_ID` / `RELEASE_APP_PRIVATE_KEY`)
  instead of the default `GITHUB_TOKEN` — so those PRs' checks run without a manual "Approve and
  run" gate. The dual-branch template's version-only `sync-version-to-dev` job is replaced by a full
  **back-merge `main -> dev`** (carrying the version bump, CHANGELOG, and changeset deletions, so dev
  never re-releases consumed changesets). `--configure-github` also enables "Allow auto-merge" so the
  back-merge PR self-merges once checks pass.

## 1.8.0

### Minor Changes

- [#52](https://github.com/linked-cm/cli/pull/52) [`3b5d645`](https://github.com/linked-cm/cli/commit/3b5d645ac6f10851bc3aee055a9f312186fbf606) Thanks [@flyon](https://github.com/flyon)! - Four scaffolding/runtime fixes from first external-user feedback:
  - **Template `src/package.ts` now imports from `@_linked/react/package`** instead of `@_linked/core/utils/Package`. Core's `LinkedPackageObject` doesn't expose `linkedComponent` / `linkedSetComponent` (they're React-only) — the old import caused `tsc` to error on a fresh scaffold the moment a user added their first shape. Requires `@_linked/react@>=1.3.1` (which fixed the recursion in `linkedPackage`).
  - **`linked` CLI swapped `tsx` for a custom esbuild-based ESM loader** for TS/TSX user code. tsx hardcodes esbuild's default decorator emit (TC39 standard) and ignores `experimentalDecorators` in the user's tsconfig — silently breaking `@literalProperty` / `@objectProperty` / `@linkedShape` everywhere, since `@_linked/core` ships legacy-signature `(target, propertyKey, descriptor)` decorators. The new loader at `lib/esm/loaders/ts-loader.mjs` reads the user's `tsconfig.json`, force-enables `experimentalDecorators: true` in the esbuild `tsconfigRaw`, preserves import-attribute (`with { type: 'json' }`) syntax, and backfills extension-less relative imports. Net effect: legacy decorator emit just works, no esbuild-bundle workaround needed for scripts.
  - **`create-app` now writes an empty `yarn.lock` in the new app**. Without it, Yarn climbs ancestor dirs looking for a project root and may decide an ancestor's stray `yarn.lock` is "the project" — aborting install with "the nearest package directory doesn't seem to be part of the project declared in <ancestor>".
  - **Template `linked.backend.storage.ts` and `src/linked.frontend.storage.ts` use `with { type: 'json' }`** for the JSON dataset config imports, replacing the deprecated `assert { type: 'json' }` syntax (which Node 22+ rejects).

## 1.7.0

### Minor Changes

- [#50](https://github.com/linked-cm/cli/pull/50) [`182b907`](https://github.com/linked-cm/cli/commit/182b9075d806121b0324bf9c2c956ace549e50e2) Thanks [@flyon](https://github.com/flyon)! - `create-app` now picks between npm and yarn deliberately instead of silently preferring yarn:
  - If only one of `npm` / `yarn` is on `PATH`, that one is used.
  - If both are installed AND the user is running interactively, `create-app` asks `Package manager [npm/yarn] (default: yarn):`. Empty answer keeps the old default (yarn). Typing `npm` or `yarn` overrides.
  - If both are installed but flags (`--app-name` / `--app-prefix` / `--app-domain`) were passed, no prompt — yarn wins, matching the previous non-interactive default.
  - The chosen package manager flows through the install step AND the final "next command" hint, so the copy-paste line at the end is always `cd my-app && npm start` or `cd my-app && yarn start` matching what was actually installed (instead of always showing `npm start` with a yarn comment).

  Why this matters: scaffolding with yarn but then running `npm start` (without re-running `npm install`) used to leave critical packages unresolved at webpack-compile time. Picking one PM and reusing it removes that footgun.

## 1.6.4

### Patch Changes

- [#48](https://github.com/linked-cm/cli/pull/48) [`dce9cb5`](https://github.com/linked-cm/cli/commit/dce9cb5e669b40f131494bbf5ed5c6990bb02cb3) Thanks [@flyon](https://github.com/flyon)! - Template `tsconfig.json` switched from `moduleResolution: "node"` to `moduleResolution: "bundler"`. The classic Node resolver doesn't honor the `exports` field in package.json, and `@_linked/react` (and friends) declare types only inside `exports[".".types]`, not as a top-level `types` field. The result was a fresh scaffold compiling cleanly with yarn install but exploding under webpack/ts-loader:

  ```
  TS2307: Cannot find module '@_linked/react' or its corresponding type declarations.
    There are types at '.../node_modules/@_linked/react/lib/esm/index.d.ts', but
    this result could not be resolved under your current 'moduleResolution' setting.
    Consider updating to 'node16', 'nodenext', or 'bundler'.
  ```

  `bundler` is the right choice for a webpack-bundled app — it honors `exports`, doesn't require `.js` extensions on relative imports, and doesn't enforce full ESM strictness.

## 1.6.3

### Patch Changes

- [#46](https://github.com/linked-cm/cli/pull/46) [`c1aa8d4`](https://github.com/linked-cm/cli/commit/c1aa8d49306a26513eb4826ab5ed9cbb98bc01d1) Thanks [@flyon](https://github.com/flyon)! - Two install-time fixes:
  - **Template `eslint-plugin-react-hooks` bumped to `latest`** (from `^4.6.0`). The old range maxed out at eslint 8, but `eslint: "latest"` resolves to 10, so a fresh `npm install` after `create-app` blew up with `ERESOLVE could not resolve peer eslint`. Yarn was permissive enough to silently accept the mismatch, which is how it slipped past create-app's install step.
  - **Install spinner no longer swallows warnings.** Even on a 0-exit install, stderr (peer-dep warnings, deprecations, ERESOLVE warns) is now printed under the green checkmark. Silent installs hide real problems that bite users the moment they touch the lockfile.

## 1.6.2

### Patch Changes

- [#44](https://github.com/linked-cm/cli/pull/44) [`e366008`](https://github.com/linked-cm/cli/commit/e366008075ddee7774a30ae4d99d4acf30582b90) Thanks [@flyon](https://github.com/flyon)! - `linked start` no longer aborts standalone (non-workspace) apps. `getLincdPackages()` used to print "Could not find package workspaces" and call `process.exit()` when no `workspaces` field was present in the nearest `package.json`. That broke `npm start` for every `npx @_linked/cli create-app …` scaffold, since the resulting app is a single-package repo with no workspaces.

  It now returns `[]` in that case — there simply are no local workspace packages to scan, which is the correct answer for a standalone app. Monorepo behavior is unchanged.

## 1.6.1

### Patch Changes

- [#42](https://github.com/linked-cm/cli/pull/42) [`81ac274`](https://github.com/linked-cm/cli/commit/81ac2740d9d98b1755a27c54174e6225a45da158) Thanks [@flyon](https://github.com/flyon)! - Stripped `@_linked/auth` from the default scaffold. It was wired in (`<ProvideAuth>` in `App.tsx`, `RequireAuth` import in `routes.tsx`) but no signin provider was configured, so it did nothing — while still dragging the entire legacy `lincd-*` chain (`foaf`, `lincd-input`, `lincd-mui-base`, `lincd-rdfs`, `lincd-sioc`) into the dep tree and crashing on startup with `Error: Multiple versions of LINCD are loaded` (both `lincd@1.0.3` and `@_linked/core` claim the same `globalThis.lincd` key).

  To add sign-in back: `yarn add @_linked/auth`, wrap `<AppRoutes/>` in `<ProvideAuth>`, import `RequireAuth`, set `requireAuth: true` on the route you want protected. Inline comments in `App.tsx` and `routes.tsx` show where.

## 1.6.0

### Minor Changes

- [#40](https://github.com/linked-cm/cli/pull/40) [`582ad13`](https://github.com/linked-cm/cli/commit/582ad13dc947d59b51df499dc223260f602c1b09) Thanks [@flyon](https://github.com/flyon)! - Simplified the package to ship a single bin (`linked`). The legacy `lincd`, `lincd-cli`, and `lnk` aliases are gone.

  With only one bin, npx can resolve it without `-p`:

  ```sh
  npx @_linked/cli@latest create-app my-app
  ```

  If you previously used `lincd` or `lincd-cli` from `@_linked/cli` (the deprecation shim), switch to `linked`. The `lnk` short alias was undocumented and has been removed alongside.

## 1.5.2

### Patch Changes

- [#38](https://github.com/linked-cm/cli/pull/38) [`d56f6ab`](https://github.com/linked-cm/cli/commit/d56f6ab8c006e7204216ba8a0781f5cd23f98334) Thanks [@flyon](https://github.com/flyon)! - Template polish + create-app UX:
  - **Cleaner install output.** The verbose `Replacing variables in files …` log is gone. `yarn install` / `npm install` output is now hidden behind an `ora` spinner during scaffolding — on failure, the captured stdout/stderr is dumped so you still see what went wrong.
  - **Page1 tabs render only after mount.** Radix's `useId()` auto-IDs drift between `<StaticRouter>` (server) and `<BrowserRouter>` (client) trees, producing an `aria-controls did not match` React hydration warning. The showcase now defers `Tabs.Root` to after hydration so the warning is gone. The header still renders during SSR so the page isn't blank on first paint.
  - **Inactive tab panels stay hidden.** Added a `.TabPanel[hidden], .TabPanel[data-state='inactive'] { display: none; }` rule so the grid layout no longer overrides Radix's `[hidden]` attribute and leaks empty grid containers below the active tab.
  - **Bumped template fuseki dep to `^2.0.1`** which has `[FusekiStore] SPARQL …` per-query logs gated behind `DEBUG_FUSEKI=1`.

## 1.5.1

### Patch Changes

- [#36](https://github.com/linked-cm/cli/pull/36) [`fc37baa`](https://github.com/linked-cm/cli/commit/fc37baa54874d64349622b56b05d14f691bafb1c) Thanks [@flyon](https://github.com/flyon)! - The components-showcase page (`/page1`) is now a public route by default — the template doesn't wire up an authentication provider out of the box, so `requireAuth` would just hide the page behind a redirect to a non-functional signin. The `requireAuth: true` line is now commented out with a note pointing readers to `@_linked/auth` when they want to add it.

  Top-of-file comment in `Page1.tsx` updated to match.

## 1.5.0

### Minor Changes

- [#34](https://github.com/linked-cm/cli/pull/34) [`4138d8f`](https://github.com/linked-cm/cli/commit/4138d8fbbee6c5def8538d2297bedd5c0ed3e4e7) Thanks [@flyon](https://github.com/flyon)! - Template visual upgrade: animated background + primitives showcase.

  **Animated background.** `App.module.css` now renders a fixed-position layer underneath all content with three soft radial-gradient blobs that drift and gently pulse on a 22s loop. Brand-colored via `--color-primary-300` / `--color-secondary-300` / `--color-tertiary-200`, so the look re-tints automatically when an app overrides theme tokens. Honors `prefers-reduced-motion: reduce`.

  **Protected page** (`/page1`) reworked into a `@_linked/primitives` showcase, organized into `Tabs` (Forms / Display / Buttons). Exercises `Button` (variants, colors, sizes), `Input`, `Switch`, `Checkbox`, `RadioGroup`, `Slider`, `Progress`, `Avatar`, `Label`, `Separator` — useful both as a visual smoke-test of the active theme and as starter code showing how to reach for each primitive.

  `@_linked/primitives` added as a template dep (`^1.0.6`).

## 1.4.5

### Patch Changes

- [#32](https://github.com/linked-cm/cli/pull/32) [`2f0b4d3`](https://github.com/linked-cm/cli/commit/2f0b4d349b98eea9271fad9028a2ddae824bcd29) Thanks [@flyon](https://github.com/flyon)! - Template's `@_linked/auth` dep range bumped from `~1.0` (which pinned to the broken 1.0.x empty-tarball releases) to `^1.1.0` (which has the actual `lib/`). Same for `@_linked/server-utils` (`^1.0.5` → `^1.0.6`) and `@_linked/schema` (`^1.0` → `^1.0.6` — both versions were empty before 1.0.6).

  Also fixes `PersonPreview.tsx` template: `Person.update(...).for(source)` and `Person.delete(source)` now pass `{ id: source.id }` with an early-return guard, since `source.id` is optional on the shape type.

## 1.4.4

### Patch Changes

- [#30](https://github.com/linked-cm/cli/pull/30) [`420c735`](https://github.com/linked-cm/cli/commit/420c7350741e5e2c1b7b76ecbaa4608a9b7ae4f0) Thanks [@flyon](https://github.com/flyon)! - `defaults/package/package.json` (the `linked create-package` template) now uses the explicit per-step build pipeline instead of `yarn linked build`. The wrapper script was silently swallowing TS compile errors and shipping empty tarballs — the exact same bug that affected every existing `@_linked/*` package built with it.

  New packages created via `linked create-package` now ship with a build script that fails loudly on real errors and produces complete `lib/esm/` + `lib/cjs/` output.

## 1.4.3

### Patch Changes

- [#28](https://github.com/linked-cm/cli/pull/28) [`1d2338c`](https://github.com/linked-cm/cli/commit/1d2338c09a38e44caec2aa69a72b3feda7d098bf) Thanks [@flyon](https://github.com/flyon)! - `.npmignore` was excluding the starter template's `defaults/app-with-backend/src/` (and `scripts/`) because the `src` pattern matched **anywhere** in the tree, overriding the `!defaults/**/*` re-include. The published tarball was missing all the template's TypeScript source files, so `linked create-app` was producing apps without `src/`.

  Anchor the cli's own-source ignore rules to the package root (`/src`, `/*.ts`, `/tsconfig.json`) and add an explicit `!defaults/**` re-include after.

## 1.4.2

### Patch Changes

- [#26](https://github.com/linked-cm/cli/pull/26) [`6e018c1`](https://github.com/linked-cm/cli/commit/6e018c11dedee787f818c01139b2ca53e184921e) Thanks [@flyon](https://github.com/flyon)! - Template now requires `@_linked/fuseki ^2.0` — that's the version which ships the `FusekiStore` config-object constructor that the new storage layout expects.

## 1.4.1

### Patch Changes

- [#24](https://github.com/linked-cm/cli/pull/24) [`c5d1321`](https://github.com/linked-cm/cli/commit/c5d13216bde74e591111a281253afcaf43c8bfb9) Thanks [@flyon](https://github.com/flyon)! - Template (`app-with-backend`) dep bumps so a fresh scaffold installs versions that match the APIs the template uses:
  - `@_linked/core: ^2.6` (needs `parseDatasetsConfig` + `loadStores`)
  - `@_linked/server: ^2.0` (needs the new `BackendAPIStore` config-object constructor + the dataset-terminology renames)
  - `@_linked/server-utils: ^1.0.5` (1.0.4 shipped an empty tarball)
  - `@_linked/react: ^1.3` (needs the loader/errorElement resolution chain + `_refresh` on `linkedSetComponent`)
  - `@_linked/cli: ^1.4` (template uses the loader bin)

  Also: `theme.css` top-comment no longer references the colours as "CN-branded" — they're just the default palette; users override `--color-primary-*` / `--color-secondary-*` to brand. README workspace-note generalized to "another repo's `packages/`" instead of a specific path.

## 1.4.0

### Minor Changes

- [#23](https://github.com/linked-cm/cli/pull/23) [`a00168d`](https://github.com/linked-cm/cli/commit/a00168d0e55a3f7f8164df1ea90e8fe52aefd5d4) Thanks [@flyon](https://github.com/flyon)! - Rename `LincdConfig` / `LincdWebpackConfig` / `LincdServerConfig` → `LinkedConfig` / `LinkedWebpackConfig` / `LinkedServerConfig`. Function `getLincdConfig` → `getLinkedConfig`. Legacy package.json flags `lincd: true` and `lincdApp: true` are no longer read — migrate to `linkedPackage: true` / `linkedApp: true`. Built loader registration is unaffected.

  Plus: CLI command help text refresh (`LINCD app` → `Linked app`, etc.). Config file name `lincd.config.{js,json}` → `linked.config.{js,json}` (hard cut, no fallback) — was previously rolled out separately.

- [#23](https://github.com/linked-cm/cli/pull/23) [`a00168d`](https://github.com/linked-cm/cli/commit/a00168d0e55a3f7f8164df1ea90e8fe52aefd5d4) Thanks [@flyon](https://github.com/flyon)! - Starter template: CN-branded CSS theme + `@_linked/react` integration in the example components.

  **Brand defaults.** The `app-with-backend` template now ships with the CN palette (`--color-primary-*` mapped to a teal-blue ramp, `--color-secondary-*` to mint green) as a default-branded baseline. Apps override `@theme { --color-primary-500: ... }` to swap brand.

  **Semantic-token shell.** `App.module.css`, `DefaultLayout.module.css`, `Header.module.css` rewritten using `@_linked/css` semantic tokens (`--bg-page`, `--bg-card`, `--color-primary-*`) instead of hardcoded hex. Module CSS files using `--spacing(N)` import `@_linked/css/package.css` per the documented pattern.

  **Person CRUD demo uses `@_linked/react`.** `PersonOverview` is now built with `linkedSetComponent`, and `PersonPreview` with `linkedComponent` — replacing the previous `useEffect` + `useState` query patterns. The wrappers handle loading state via the framework's `.ld-loader` and inject `_refresh` so the form (sibling) and rows (children) can trigger re-fetch. Optimistic UI on inline edit via `_refresh({givenName, familyName})`.

  **Pages polish.** `Home`, `Signin`, `Page1`, `PageNotFound` get card layouts using semantic tokens — consistent across routes.

  **`@_linked/react` is now a direct dep** in the scaffolded app's `package.json` so the bindings can be imported. Companion changes ship in `@_linked/react` (loader / errorElement API, `_refresh` on set, factory overloads) and `@_linked/css` (`.ld-loader` / `.ld-error` defaults + `--color-error-*` ramp).

  **Storage layout.** Template now ships `linked.backend.storage.ts` + `linked.backend.datasets.json` and a mirror `src/linked.frontend.storage.ts` + `src/linked.frontend.datasets.json`. Backend uses `loadStores` (async, dynamic-import). Frontend hardcodes the per-alias store mapping for webpack-friendly bundling.

  **npm + yarn compatibility.** `create-app` works with either package manager. Lockfile-based detection determines which to invoke for install.

  No breaking changes. Existing scaffolded apps that don't pull in the template updates keep working.

### Patch Changes

- [`67f01ab`](https://github.com/linked-cm/cli/commit/67f01abcbed04625175a5c82e584f09fee41cdea) - Remove `preflight.css` — moved to `@_linked/css`.

  `preflight.css` is a CSS asset; it belongs in the CSS package alongside `theme-defaults.css` and `utilities.css`. Consumers should update imports from `@_linked/cli/preflight.css` to `@_linked/css/preflight.css`.

  The exports entry `"./preflight.css": "./preflight.css"` is also removed from `package.json`.

- [`2b40588`](https://github.com/linked-cm/cli/commit/2b405880cbb21992c5005cb048f910df79c32145) - Relax `typescript` dep from `^5.7.3` to `^5.4.0` so consumers that pin a lower 5.x version (e.g. CN at 5.4.5) don't end up with a nested `typescript@5.9.x` install in `packages/cli/node_modules/`. The nested 5.9.x was incompatible with `react-refresh-typescript@2.0.12`'s AST walk — crashed frontend builds with `TypeError: Cannot read properties of undefined (reading 'declarations')` inside `VariableStatement.declarationList.declarations` traversal.

## 1.3.3

### Patch Changes

- [`8179c96`](https://github.com/linked-cm/cli/commit/8179c9627757be6c67de44e22b6ae7b08e83bcc1) - Remove webpack loader `./plugins/check-imports` from the package barrel (`src/index.ts`). The loader is CJS (uses `require()`) and was crashing ESM consumers at import time with "require is not defined in ES module scope". Webpack loads this file directly by path via `config-webpack.ts`, so no public export is needed. Also fix two relative imports in `tailwind.config.ts` and `utils.ts` that were missing `.js` extensions.

- [#19](https://github.com/linked-cm/cli/pull/19) [`eb1224e`](https://github.com/linked-cm/cli/commit/eb1224ea65ae65d7f534923b286d5daa0cdc151d) Thanks [@flyon](https://github.com/flyon)! - Remove `prepack: yarn build && pinst --disable` and `postpack: pinst --enable` scripts. These were conflicting with the CI publish flow (ENEEDAUTH on the actual `npm publish` call). Build now happens only in the dedicated CI "Build" step. Also remove `postinstall: husky install` (not needed for published installs).

## 1.3.2

### Patch Changes

- [#19](https://github.com/linked-cm/cli/pull/19) [`2111d11`](https://github.com/linked-cm/cli/commit/2111d113039c95304458e72c29dc2a58ca97ba16) Thanks [@flyon](https://github.com/flyon)! - Remove `prepack: yarn build && pinst --disable` and `postpack: pinst --enable` scripts. These were conflicting with the CI publish flow (ENEEDAUTH on the actual `npm publish` call). Build now happens only in the dedicated CI "Build" step. Also remove `postinstall: husky install` (not needed for published installs).

## 1.3.0

### Minor Changes

- [#17](https://github.com/linked-cm/cli/pull/17) [`3c81281`](https://github.com/linked-cm/cli/commit/3c81281ce9ef4b16c08f341923f6920b9b9c7f6b) Thanks [@flyon](https://github.com/flyon)! - Phase 0.3 accumulated changes:
  - **New `linked setup-publish` command**: scaffolds a changesets-based publish workflow in any package repo. Supports single-branch (default) and `--dual-branch` (main + dev with `@next` prereleases). Patches package.json (publishConfig + changesets devDeps), generates package-lock.json in an isolated tmpdir, writes `.github/workflows/{ci,publish,changeset-check}.yml`, and optionally configures GitHub branch protection via `--configure-github` (uses `gh` CLI).
  - **`linked build-workspace` now invokes each package's own `yarn build` script** instead of the internal buildPackage pipeline. Lets @\_linked/core use pure tsc, pure-CSS packages use no-ops, and lincd-style packages use `yarn linked build`.
  - **`linked yarn` (safeYarn) gains `LINKED_YARN_DRY_RUN` env** for testing arg forwarding without executing.
  - **Import checker is warn-only** (was fatal): emits yellow warnings listing missing `.js` extensions but doesn't abort the build.
  - **compilePackageESM/CJS** skip gracefully when tsconfig-{esm,cjs}.json is absent (pure-CSS packages).
  - **Dual-package step** uses `npx tsconfig-to-dual-package` so the binary resolves from nearest node_modules.
  - **runOnPackagesGroupedByDependencies**: tolerate packages without `dependencies` field.
  - **Package template modernized**: uses `yarn linked build` pattern (matches foundational packages), Gruntfile removed.
  - **App template**: adds `mrgit-template.json`, `yarn setup` script, `linkedApp: true` flag, `mrgit` devDep.
  - **`linkedPackage: true` / `linkedApp: true`** flags added to cli-methods readers (alongside legacy `lincd` / `lincdApp` for transition period).
  - **Bug fix**: lingering `lincd-server/*` imports in LincdServer.tsx migrated to `@_linked/server/*`.

All notable changes to `@_linked/cli` (formerly `lincd-cli`) are documented here.

This project follows [Keep a Changelog](https://keepachangelog.com/) and [Semantic Versioning](https://semver.org/).

## [1.2.11] - 2026-04-22

### Changed

- **Renamed package**: `lincd-cli` → `@_linked/cli`. Repo moved from `semantu/lincd-cli` → `linked-cm/cli`.
- **Primary binary** is now `linked` (with `lnk` as a short alias).
- **Flag in package.json** is now `linkedPackage: true` (packages) / `linkedApp: true` (apps). The legacy flags `lincd: true` / `lincdApp: true` are still read for a transition period.
- **Package template** (`defaults/package/`) no longer ships a `Gruntfile.js`. New packages use `rimraf + tsc + tsconfig-to-dual-package` for dual ESM/CJS output.
- **App template** (`defaults/app-with-backend/`) now includes `mrgit-template.json`, a `yarn setup` script, and `mrgit` as a devDep. Run `yarn setup` after `linked create-app` to optionally clone sibling `@_linked/*` repos for local development.

### Added

- `linked build-workspace` — builds all linked packages in the current workspace in dependency order. Supports `-u` (updated only) and `--use-git` (git-based change detection). Migrated from `@semantu/cli`.
- `linked build-package <filepath>` — given a file path, walks up to the nearest `package.json` and rebuilds that package. Designed for editor save hooks. Migrated from `@semantu/cli`.
- `linked yarn <args>` — safe-yarn wrapper that preserves nested repo yarn.lock files during root-level yarn commands (for mrgit workflows). Migrated from `@semantu/cli`.

### Deprecated

- The `lincd` binary is retained as a deprecated alias that prints a warning to stderr on invocation. It will be removed in a future major release; migrate scripts to `linked`.
- `generateGruntConfig` export has been removed; it had no active callers. If you still reference it, migrate your package build to `tsc + tsconfig-to-dual-package` (see the package template).

### Removed

- Grunt bin entry (`grunt`) removed from package.json bins.
- Internal `config-grunt.cts` and `getGruntConfig` helper removed.
- Grunt-related devDependencies (`grunt`, `grunt-cli`, `grunt-*`, `@lodder/grunt-postcss`, `load-grunt-tasks`) removed.

### Migration notes

- Update `package.json` deps: `lincd-cli` → `@_linked/cli`.
- Update `package.json` flag: `lincd: true` → `linkedPackage: true` (and `lincdApp: true` → `linkedApp: true` for apps). Legacy flags still read for now.
- Update scripts: `yarn lincd <cmd>` → `yarn linked <cmd>`. The legacy alias still works but emits a deprecation warning.
- Update import paths: `lincd-cli/<module>` → `@_linked/cli/<module>`.
