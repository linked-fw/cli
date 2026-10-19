---
date: 2026-10-19
summary: >
  Three `linked start` / dev fixes. (1) `createViteConfig` keeps the app's installed linked
  packages out of Vite's dependency pre-bundler in every dev mode, not only standalone apps, and
  runs the optimizer's esbuild with `keepNames: true`; before, an app with source workspaces got
  `@_linked/core` duplicated per pre-bundled chunk and shape classes renamed (`Person` →
  `Person3`), so the server rejected every query (cli 1.47.3). (2) The linked package sort ignores
  devDependencies, so core (devDependency on the cli) and the cli no longer read as a cycle and
  "Could not sort lincd packages, circular dependencies?" is gone (cli 1.48.1). (3) The `o<enter>`
  open hint uses the server's `PORT` (patch changeset, the release after 1.52.0).
---

# 022 — Dev start fixes: optimizer exclusion, package sort, open-hint port

## 1. Installed linked packages stay out of the dep optimizer (cli#272, 1.47.3)

**Why.** Every app made from the template has source workspaces (`packages/*-ont`,
`packages/*-assets`). In that mode `createViteConfig` excluded only the workspace names from
`optimizeDeps`, so the installed `@_linked/*` packages were pre-bundled. esbuild inlined a copy of
`@_linked/core` into each per-subpath chunk and renamed colliding classes; in
`node_modules/.vite/deps/@_linked_schema_shapes_Person.js`:

```
var Person2 = class Person3 extends Thing2
```

The shape IRI became `https://linked.cm/shape/schema/Person3`, and the server answered every query
with `Invalid query` / "Cannot resolve shape". The exclusion of installed linked deps existed, but
only for standalone apps (no workspaces).

**What changed** (`src/vite-config.ts`):

- `installedLinkedDeps(cwd)` (exported): the app's direct dependencies and devDependencies whose
  installed `package.json` has `linkedPackage: true`. Best-effort, `[]` without a `package.json`.
- In every dev mode, `optimizeDeps.exclude` is the deduplicated union of workspace names and those
  deps. The standalone-only parts (`resolve.conditions`, the standalone dedupe pair,
  `ssr.noExternal`) are unchanged.
- `optimizeDeps.esbuildOptions: {keepNames: true}` as a second guard: a linked package that still
  lands in a pre-bundled chunk (a transitive one such as `@_linked/xsd`, or one an app re-includes)
  keeps each class's `name`, which shape URIs derive from. Vite 6 (the peer range) pre-bundles with
  esbuild, so `esbuildOptions` is the API.
- `linked:client-dep-includes` already scans every excluded framework package for its third-party
  client deps, so Radix, vaul and CJS deps still get `optimizeDeps.include` entries.

**Measured** in a CN-created app (two workspaces, vite 6.4.4, `node_modules/.vite` deleted): with
cli 1.47.0, `.vite/deps` held `class Person3` and the server logged `ServerCallError: Invalid
query`; with this build, no `@_linked_*` chunks, `0` "Invalid query" lines, the People list
rendered, `/` and `/page1` loaded with no console errors.

**Tests:** `tests/unit/viteDedupe.test.ts` — a workspace-mode app with an installed linked
package is excluded; `keepNames` is set in every mode. Both fail without the fix. The browser side
of this bug class is now held by the dual-copy e2e ([report 021](021-browser-side-dual-copy-check.md)).

**Limits:** only direct linked deps are excluded; transitive ones rely on `keepNames`. Apps that
added `keepNames` locally as a workaround can drop it.

## 2. The linked package sort ignores devDependencies (cli#277, 1.48.1)

**Why.** Every app run printed `Could not sort lincd packages, circular dependencies?`.
`getLINCDDependencies` ordered linked packages by `dependencies` + `devDependencies`, and
`@_linked/core` has `@_linked/cli` as a devDependency while the cli depends on core — a cycle that
does not exist at runtime.

**What changed** (`src/utils.ts`): `sortDependencyNames(packageJson)` (exported) returns
`dependencies` + `peerDependencies`; the sort edges use it. Discovery is unchanged: the walk still
follows the root's devDependencies to find packages.

**Tests:** `tests/unit/linkedDependencySort.test.ts` — a fixture `node_modules` with core
(devDependency on cli) and cli (dependency on core) sorts as `[core, cli]` with no warning.

## 3. The open hint uses `PORT` (cli#302, patch)

**Why.** `linked start` built the `o<enter>` hint and action URL from
`linkedConfig.server.port ?? opts.port ?? 4040`, while the server listens on `process.env.PORT`
(and logs "Up and running at …" from it). An app with `PORT=4050` in `.env` was told to open 4040.

**What changed** (`src/commands/start.ts`): `resolveAppUrl(env, configuredPort?)` (exported)
returns `http://localhost:<port>/` with `PORT` first, then the configured port, then 4040; the
shortcut installer uses it.

```ts
resolveAppUrl({PORT: '4050'}, 4040); // 'http://localhost:4050/'
resolveAppUrl({}, undefined);        // 'http://localhost:4040/'
```

**Tests:** `tests/unit/resolveAppUrl.test.ts`. Not checked live (the dev ports were in use).

## Follow-ups

None.

## PRs

- https://github.com/linked-fw/cli/pull/272
- https://github.com/linked-fw/cli/pull/277
- https://github.com/linked-fw/cli/pull/302
