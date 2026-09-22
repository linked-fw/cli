---
summary: build-app now compiles the app backend with Vite in SSR mode instead of bare
  tsc, and names workspace packages in ssr.external so they stay out of lib/. Records
  why Vite would not externalize them on its own, why that mattered beyond build size,
  and the two guardrails added because a wrong answer here only fails at boot.
---

# Compiling the backend with Vite

## What changed

`linked build-app` used to compile the app backend by shelling out to `tsc`. It now runs Vite
in SSR mode against the app's own `vite.config`, and lists the app's workspace packages in
`ssr.external` so they are imported at runtime rather than compiled into the output.

Everything else about the release pipeline is unchanged: the same `lib/` layout, the same
entry-point contract, the same `serve-app`.

## Why `tsc` had to go

`linked start` loads `src/backend.ts`, `src/App.tsx` and `src/routes.tsx` through
`vite.ssrLoadModule`. So development and production resolved the same source two different
ways, and the production path was the weaker of the two:

- **`tsc` is a typechecker that happens to emit.** Any type error anywhere in the app's program
  failed the build, including in files the backend never loads. An app carrying a backlog of
  type errors could not produce a release at all, however healthy its backend was.
- **No extensionless-import resolution.** A storage config doing
  `import {Router} from './src/data/Router'` resolves under Vite and not under `tsc`.
- **`rootDir` was inferred** from whatever ended up in the program. An app importing workspace
  source pulled files from outside `src/` into the program, the common root became the repo
  root, and `lib/backend.js` landed at `lib/src/backend.js` — where `serve-app`'s artifact
  check does not look.
- No CSS-module or asset handling, unlike the dev path.

Emitting and typechecking are separate concerns. `build-app` now only emits.

## How it works

`src/app-release/build-backend.ts` holds the whole thing. `buildBackendWithVite` calls Vite's
`build()` with an inline config that Vite merges over the app's own `vite.config`, so the
workspace resolver, the decorator transform and the plugin pipeline all come along unchanged.

| Option | Why |
|---|---|
| `build.ssr: true` | Node output, not a browser bundle. |
| `preserveModules` + `preserveModulesRoot: <root>/src` | Keeps `src/`'s file layout in `lib/`, so entry paths stay where `serve-app` and `startServer` look and lazily imported pages keep their own files. |
| `entryFileNames`/`chunkFileNames: '[name].js'` | No content hashes — the entry names are a contract. |
| `build.copyPublicDir: false` | `public/` is the *client* build's output. Left on, Vite copied the already-built bundles into `lib/` — 38MB of duplication in the app this was validated against. |
| `rollupOptions.external: NODE_BUILTINS` | Vite externalizes built-ins for SSR only when it recognises the specifier. A bare `crypto` resolved instead to the abandoned `crypto` shim package in node_modules and failed the build. Both bare and `node:`-prefixed spellings are listed. |
| `base: '/'` | The client build sets `base` to the release URL; the backend emits no asset URLs and must not inherit one. |
| `dropManualChunks()` plugin | Rollup refuses `manualChunks` alongside `preserveModules`, and passing `undefined` inline does not remove it — Vite's config merge keeps the app's value. Cleared in the `outputOptions` hook, after the merge. |

`buildBackend` in `cli-methods.ts` now calls this and then `copyBackendStylesheets`, which
copies `src`'s CSS into `lib/` because the server reads stylesheets like `lib/css/theme.css`
off disk by path whether or not a module imported them.

## Workspace packages: the part that is not obvious

The first working version compiled **22 workspace packages into `lib/`, 77MB**, including
`@_linked/core`. The cause is a resolution rule that is easy to miss:

1. `node_modules/@_linked/core` is a workspace **symlink** to `packages/core`. This is true of
   npm and yarn alike — it is not a package-manager quirk.
2. Vite resolves package data with `preserveSymlinks: false`, so the resolved id **realpaths out
   of `node_modules`**.
3. Vite then declines to externalize it:

```js
if (!configuredAsExternal && !isInNodeModules(resolved.id)) return false;  // → bundled
```

`ssr.noExternal` has no say here — it only ever *forces* bundling. The single override is
`configuredAsExternal`, i.e. an explicit `ssr.external` entry keyed on an exact package name.
`workspacePackagesToExternalize` builds that list from `discoverWorkspaces`.

### Why it mattered beyond build size

A compiled app loads its pieces from two places:

| Loaded from | By | Resolves `@_linked/core` to |
|---|---|---|
| `lib/App.js`, `lib/routes.js`, `lib/backend.js` | `startServer`, from `lib/` | the inlined copy |
| `linked.backend.storage.*` | `loadBackendStorageConfig`, raw Node `import()` from the **app root** | node_modules — a second copy |

`LinkedStorage`'s routing state (`defaultDataset`, `shapeToDataset`) is a per-module-copy
static. So the storage config configured one copy and the backend queried another — the
dual-load failure that app-side single-instance guards exist to catch. The old `tsc` build never
hit it, because it emitted bare specifiers and Node converged on one copy. Naming the packages
in `ssr.external` restores that property.

### Three condition lists, not one

Externalizing was not enough on its own. The workspace-source export convention is

```json
"./*": { "development": "./src/*.ts", "import": "./lib/esm/*.js" }
```

and Vite expands its `development|production` condition token from `NODE_ENV` — which during a
release build is whatever the app's `.env` says, routinely `development`. The package then
resolves to TypeScript, which **cannot** be externalized because Node could not load it, so it
gets compiled in regardless of `ssr.external`.

The fix is to drop the token rather than pin it to `production`, leaving `import` (which Vite
always appends last) to win. `createViteConfig` already applies the same treatment to a
standalone install, for the mirror-image reason. All three lists have to say it:

- `resolve.conditions` — the plugin pipeline
- `ssr.resolve.conditions` — the SSR graph, which does **not** inherit from the above here
- `ssr.resolve.externalConditions` — the packages that end up external

## Guardrails

A wrong answer here produces perfectly valid JavaScript and only surfaces as a storage-routing
error at boot, far from the cause. Two checks close that gap:

- **`assertNoInlinedWorkspaces`** runs after the build and fails it on any relative import from
  `lib/` into `packages/`, naming what leaked and why it matters. It checks every entry
  (`backend`, `App`, `routes`) because `App` and `routes` reach code the backend never imports,
  and matches dynamic `import("…")` as well as static `from "…"` because a lazily imported page
  only appears in the output as the former.
- **`explainUnresolvedWorkspaceImport`** rewrites Rollup's unresolved-import error when the
  specifier belongs to an externalized workspace package, because externalizing changes where
  that package resolves from:

```
[vite]: Rollup failed to resolve import "some-pkg/orchestrators/Refresh" …

"some-pkg" is a workspace package, so a release build resolves it through its published
exports — its lib/, not its src/. If this file exists in some-pkg/src but not in its build
output, that package's lib/ is stale. Build it first (`linked build` in the package, or
`linked build-workspace`) and run build-app again.
```

## Behaviour change for consumers

**A release build now depends on workspace packages' `lib/` being built and current.**
Previously the backend build compiled them from `src`, so stale or missing build output went
unnoticed. It no longer does.

This is a correctness improvement rather than a new burden: `lib/` is what runs in production
either way, so a package whose `lib/` lacks a file an app imports was always going to fail at
runtime. The build now says so instead. Validating this change against a real app turned up
nine such imports across three of its workspace packages, every one of which would have crashed
a production boot.

## Public API

Everything in `src/app-release/build-backend.ts` is exported and unit-tested:

| Export | Responsibility |
|---|---|
| `buildBackendWithVite(options, dependencies)` | Runs the SSR build. `dependencies.viteBuild` is injectable for tests. |
| `resolveBackendEntries(appRoot, exists?)` | Maps `backend`/`App`/`routes` to whichever extension the app uses. |
| `workspacePackagesToExternalize(appRoot, discover?)` | The `ssr.external` list, deduplicated and sorted. |
| `findInlinedWorkspaceImports(source)` | Relative imports into `packages/`, static and dynamic. |
| `assertNoInlinedWorkspaces(appRoot, readFile?)` | Post-build check across all entries. |
| `explainUnresolvedWorkspaceImport(message, externals)` | The stale-`lib/` explanation, or `null`. |
| `copyBackendStylesheets(appRoot, listCssFiles)` | CSS the server reads off disk. |

## Tests

`tests/unit/buildBackend.test.ts` — 12 tests: entry resolution across extensions and partial
apps; the externals list including dedup/sort and the no-workspaces case; inlined-import
detection for static, dynamic and false-positive (`@pkg/foo/packages/bar`) forms; and the
stale-`lib/` explanation including the two cases where it must stay out of the way.

Full suite: 23 files, 299 tests.

## Verified against a real app

- `build-app` completes — client bundle, backend, release manifest. `tsc` could not get past the
  backend step at all.
- `lib/App.js`, `lib/routes.js`, `lib/backend.js` at the top level; 80 page modules preserved
  one-to-one; `src/` not polluted with emitted `.js`.
- `lib/backend.js` imports `@_linked/core/utils/LinkedStorage` as a bare specifier;
  `find lib -path '*packages/core*' -name '*.js' | wc -l` → **0**.
- Workspace inlining: 22 packages / 77MB → 1 / 23MB, the remaining one being a stale `lib/` in
  the app's own package, which the new error message identified.

## Known limitations

- **node_modules dependencies stay external**, as Vite's SSR default. `lib/` is not a
  self-contained deployable; it needs the workspace tree and `node_modules` present.
- `workspacePackagesToExternalize` relies on `discoverWorkspaces`, which registers a package
  only if it ships a `src/` directory. A workspace with no `src/` resolves through node_modules
  and is externalized by Vite anyway, so this is not known to be a gap — but it is an
  assumption, not a guarantee.
- An app that aliases a package subpath straight to source in its own `vite.config` bypasses the
  package-name check, because an alias resolves to an absolute path before externalization sees
  a name. Not hit in validation; worth knowing.

## Follow-up considered and not taken

Bundling the backend self-contained — storage config included, so `lib/` runs with no workspace
tree — was explored and deferred. It changes the contract that the storage config is the app's
own file loaded from the app root, and adds a compiled-vs-source branch to
`loadBackendStorageConfig`. Worth revisiting if a deployment target makes shipping the workspace
tree impractical, or if the stale-`lib/` requirement proves painful in practice.

PR: [#106](https://github.com/linked-fw/cli/pull/106)
