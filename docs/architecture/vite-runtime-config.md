---
summary: How createViteConfig keeps the @_linked/* framework packages single-instance across the browser and Node (SSR) runtimes; the workspace vs standalone resolution modes; @_linked/cli loaded by Node only; which code Node loads natively in dev; the per-worktree Vite cache; and how a git worktree overlays one package.
---

# Vite runtime config — two runtimes, single framework instance

A linked app runs in **two JavaScript runtimes**:

- **Browser** — the client bundle Vite builds.
- **Node** — the backend (providers, storage, SSR render), loaded in dev via `vite.ssrLoadModule`.

Each runtime instantiates its own copy of the framework packages. Within a *single*
runtime, the stateful framework packages — `@_linked/core` (shape registry,
`LinkedStorage`, query context) and everything that registers into it — **must be one
module instance**. Two copies in one runtime split that state and mangle shape identity
(`Person`→`Person2`), which breaks cross-runtime shape lookup.

`createViteConfig` enforces single-instance per runtime. The packages it treats as
framework packages are one constant in `src/installed-packages.ts`:

```ts
export const FRAMEWORK_PKG_PATTERNS: RegExp[] = [/^@_linked\//, /^lincd-/];
```

## Two resolution modes

`createViteConfig` detects its mode via `discoverWorkspaces()`:

- **Workspace mode** — an app with source workspaces: its own `workspaces` globs
  (`packages/*`, `packages-local/*`) and installed linked packages that ship `src/` on disk.
  Those resolve to `src/` through the `linked:resolve-workspace-ts` pre-plugin, which maps a
  bare specifier to the package's source with `.tsx`/`.ts` probing. No export condition is
  involved: the framework packages export only `lib/esm`.
- **Standalone mode** — no source workspaces: an app created by the CLI, with published,
  lib-only deps from npm.

## The levers

| Runtime | Lever | Workspace | Standalone |
|---|---|---|---|
| Browser | `optimizeDeps.exclude` | exclude workspace members and the app's framework deps | exclude the app's framework deps (`linkedDeps`) |
| Node (SSR) | `ssr.noExternal` | **bundle** the source workspaces, the installed packages that depend on them, and `@_linked/server` (`ssrNoExternal`) | **bundle** every `@_linked/*` except core and the CLI (`STANDALONE_SSR_BUNDLED`) |
| Node (SSR) | `ssr.external` | a small allowlist (`react`, `express`, …) plus `@_linked/cli` | the allowlist |
| Node (SSR) | `ssr.resolve.conditions` | Vite defaults | `['module','node']` (→ `import → lib/esm`) |
| Both | `cacheDir` | `<app>/.vite-cache` when `node_modules` is a symlink, else Vite's default | same |

**Why *exclude* on the browser, not just dedupe:** Vite's dep-optimizer (browser-only)
pre-bundles each *subpath* import into its own chunk, and each chunk inlines its own
copy of `@_linked/core` → duplication. Excluding the framework packages lets the
browser's native ESM graph load one module per URL. (These packages are ESM with no
bare-CJS runtime deps — e.g. `classnames` is inlined in `@_linked/react` — so
native-ESM serving needs no interop shim.)

**Why bundle on the backend, and what stays external.** A package the SSR runner bundles
is one instance as long as Node never loads the same package itself. Workspace mode bundles
the source workspaces (Node could only load their `lib/`, a second copy) and leaves the
published, lib-only packages to Node, which loads each once; installed packages that import
a workspace are bundled too, so they import the Vite-loaded copy. Standalone bundles every
framework package except core (its registries are on `globalThis`, and it imports nothing
bundled) and the CLI. Mixing the two for one package — some of its importers bundled, some
external — gives two instances in the backend runtime ("No query dispatch configured").
`linked start`'s dual-copy guard reports any file Node loads from a bundled package.

## `@_linked/cli` is loaded by Node only

The `linked` bin is the CLI: the dev server process already runs `@_linked/cli` from
`lib/esm`. Vite-loaded code imports it too (`@_linked/server`'s `LinkedServer` uses
`@_linked/cli/lifecycle` and `@_linked/cli/utils`; an app's providers may use other subpaths).
If the SSR runner bundled those imports from the CLI's `src/` (it is a source workspace when
it is localized), the process would hold two CLIs whose module state is not shared.

So `SSR_NODE_PACKAGES = ['@_linked/cli']` is never bundled, in any mode:

- `ssrNoExternal` and `ssrBundledWorkspaces` leave it out, and so does the input to
  `workspaceDependents` (the CLI depends on workspace packages, so it would otherwise be listed
  as a dependent).
- In dev, `ssrExternal(true)` adds it to `ssr.external`. Vite externalizes a package whose
  realpath is outside `node_modules` (a workspace checkout) only when `ssr.external` names it.
  Externalized, a bare `@_linked/cli/<subpath>` goes to Node, whose `./*` export maps it to
  the same `lib/esm/*.js` URL the running CLI already loaded: one instance.
- An id handed to `vite.ssrLoadModule` itself is always transformed, never externalized.
  `LinkedServer` loads every linked package's root that way so its shapes register. For an
  SSR `@_linked/cli…` specifier `linked:resolve-workspace-ts` returns a virtual module
  (`ssrNodeShim`): for a subpath it re-exports Node's copy (`export * from '<id>'`, an
  external import); for the package root it is `export {}`. The CLI has no shapes, and Node's
  copy of the root would load the release tooling, whose `@_linked/core` import is a second
  core in an app where core is a source workspace.

The browser path is unchanged. A consequence: an edit to the CLI's `src/` takes effect after
`npx linked build` in the CLI and a restart, as it already did for the CLI process itself.

## What Node loads natively in dev

Under `linked start`, Node itself (not the SSR runner) loads:

- `@_linked/cli` from its `lib/esm` (the bin, and every import of it from Vite-loaded code);
- the app's `vite.config.*` and every `@_linked/*` package it imports, at Vite start-up;
- `linked.config.js` and env loading, which hold no `@_linked` state;
- in standalone mode, `@_linked/core` and the packages left external;
- packages a provider imports natively from a registry install
  (`LinkedServer.indexPackageBackendProviders` uses `ssrLoadModule` for a bundled package).

Only these can produce a second copy of a bundled package. `linked doctor resolve` uses the
first two as its "loaded by Node" set: a package in it that Vite bundles from a different
directory than Node resolves is flagged `two-copies`.

## Git worktrees

A git worktree of an app (`linked worktree add`) symlinks `node_modules` to the main
checkout's, so it shares one install.

**Per-worktree `cacheDir`.** Vite's default cache is `node_modules/.vite`, which through the
symlink is the main checkout's: a worktree's dev server would re-optimize it from under the
main one's ("Re-optimizing dependencies because lockfile has changed"). `viteCacheDir(appRoot)`
returns `<app>/.vite-cache` when `<app>/node_modules` is a symlink, so each worktree has its
own cache (gitignored), and leaves the default otherwise. `appRoot` is the directory
`linked start` runs Vite in (`process.cwd()`), used throughout `createViteConfig`.

**How an overlay resolves.** `discoverWorkspaces` builds one table, package name → one
realpathed `src/` directory, from (1) the app's `workspaces` globs, then (2) linked packages
found through `node_modules`. Glob entries win on a name clash. In a worktree:

- a package worktree at `<wt>/packages-local/<dir>` is found by (1) and wins for that one
  name: Vite loads that package from the worktree;
- every other package is found by (2) through the symlinked `node_modules`, i.e. the main
  checkout's copy (its branch as landed so far);
- the app's own `packages/*` come from the worktree too, through (1).

Third-party dependencies of the overlaid package resolve by walking up to the worktree's
`node_modules`, the same files as the main checkout's. npm nests a package's
version-conflicting dependencies in that checkout's own `node_modules`, so
`linked worktree add` symlinks `<wt>/packages-local/<dir>/node_modules` to the checkout's;
without it the worktree's imports fall through to the root's versions. The `linked start`
watch set uses the same table, so HMR follows the worktree's copy.

Node does not see the overlay: it resolves through `node_modules` to the main checkout. That
is harmless for a package nothing loads natively, and is reported as `overlay` by
`linked doctor resolve`. It is why the CLI (and a package the app's `vite.config` imports)
cannot be overlaid this way: run the worktree's own built bin
(`node <wt>/packages-local/_linked-cli/lib/esm/launch.js start`) for a CLI change.

## Adding a framework package

Add its scope to `FRAMEWORK_PKG_PATTERNS`. That one edit covers every lever above.
