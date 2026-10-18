---
summary: >
  Under `linked start` (dev, standalone app) a store named in `linked.backend.datasets.json` comes
  from a different copy of its package than the app's own import of it. The CLI bundles
  `@_linked/server` (and, standalone, `@_linked/server-utils`) for the Vite SSR runner, while core's
  `loadStores` is external and imports the store through Node. `instanceof RemoteDataset` /
  `RemoteDatasetUnreachableError` fail across the boundary (app-template#26 matches errors by
  `name` + `url` as a workaround), and `server-utils`' module state (`Server`'s local server, the
  proxy's default headers) exists twice. Core itself is one copy. A built app has one copy of each.
status: Open -- fix in progress, CN plan 068 phase 4
---

# 014 — Dev loads a second copy of datasets-file stores

## The problem

[app-template#26](https://github.com/linked-fw/app-template/pull/26) switched `appData` to be
whatever store `linked.backend.datasets.json` names, including
`@_linked/server/shapes/quadstores/RemoteDataset`. Under `linked start` its first e2e run printed
the raw `RemoteDatasetUnreachableError` stack instead of the boot message: the error thrown by the
store was not `instanceof` the `RemoteDatasetUnreachableError` the app imported. The template now
matches by class, then by `err.name === cls.name` plus a string `url`
(`src/utils/storageErrors.ts:21-31` in app-template), and its `[storage]` log reads the store's
`url` property instead of checking `instanceof RemoteDataset`. A built app has one copy and
matches by class.

The workaround is local to two error classes. The cause is in this repo and affects any class or
module state reachable both ways.

## Where each copy comes from

Standalone app (no source workspaces), which is what the template is.

**Copy 1, Vite's module runner.**

- `src/vite-config.ts:596` — `export const SSR_ENTRY_PACKAGES = ['@_linked/server'];`
- `src/vite-config.ts:612-613` — standalone `ssrNoExternal` returns
  `[/^@_linked\/server-utils$/, /^@_linked\/react$/, ...SSR_ENTRY_PACKAGES]`; workspace mode
  (`:615`) adds `SSR_ENTRY_PACKAGES` to the workspaces and their dependents.
- `src/vite-config.ts:975` — `noExternal: isDev ? ssrNoExternal(...) : []`.
- `src/commands/start.ts:401-413` — the storage config (`linked.backend.storage.ts`) is loaded with
  `vite.ssrLoadModule`, so its bare imports of `@_linked/server/...` (in the template:
  `LocalFileStore`, and through `src/utils/storageErrors.ts` the `RemoteDataset*Error` classes) and
  of `@_linked/server-utils/...` (`withAccess`) are bundled.
- `src/commands/start.ts:426-428` — `LinkedServer` itself is loaded through
  `vite.ssrLoadModule('@_linked/server/shapes/LinkedServer')`.

**Copy 2, Node.**

- `@_linked/core` is not in the list above, so the storage file's
  `import { loadStores } from '@_linked/core/utils/loadStores'` is externalized: Node evaluates
  core's `lib/esm`.
- core `src/utils/loadStores.ts:51` — `const mod = await import(entry.store);` is a native dynamic
  import inside a Node-loaded module, so `@_linked/server/shapes/quadstores/RemoteDataset`
  resolves through Node to `@_linked/server`'s `lib/esm`, a second evaluation of
  `RemoteDataset.js` and of its relative imports (`../../package.js`).
- server `src/shapes/quadstores/RemoteDataset.ts:2` — that copy imports
  `{ Server } from '@_linked/server-utils/utils/Server'`, also through Node: a second copy of
  `server-utils` as well.

`vite-config.ts:955-966` already describes the same mechanism for `@_linked/core` in workspace
mode ("`loadStores` (core) loaded a store such as `@_linked/fuseki/shapes/FusekiStore` through
native `import()`, which pulled a SECOND Node-loaded core"), which was fixed by leaving published
packages external. `SSR_ENTRY_PACKAGES` is the published exception, and so is `server-utils`
standalone, and those are the packages that now split.

## What else is exposed

**Classes.** Any class exported by a package in `ssrNoExternal` that a datasets file can name
*and* the app also imports. Today in `@_linked/server`: `RemoteDataset` and its three error classes
(`RemoteDataset.ts:42,63,66`), and `LocalFileStore`, `filestores/*` and every other store under
`shapes/quadstores/` if a datasets file names one. In workspace mode, any store class from a source
workspace or a workspace dependent, if core is not itself bundled (see below). `FusekiStore`
(`@_linked/fuseki`) is not exposed standalone: fuseki is external both ways.

**Module state in `@_linked/server-utils`** (standalone; it is bundled for Vite and reached by Node
from the Node copy of `RemoteDataset`):

- `Server.setLocalServer` (`server-utils src/utils/Server.ts:28-33`) writes `proxy.localServer`
  on the module-level `proxy` (`Server.ts:16`). `LinkedServer` sets it on the Vite copy. A
  `RemoteDataset` without a `url` calls `Server.call` (`RemoteDataset.ts:185`) on the Node copy,
  which never had a local server set.
- `LincdServerProxy.defaultHeaders` (`server-utils src/utils/LincdServerProxy.ts:92`,
  `addDefaultHeaders` at `:118-119`) is a static on the class, so headers the app adds reach one
  copy only.
- `@_linked/server`'s `package.js` evaluates once per loader (the comment at
  `vite-config.ts:581-594` measured the same for CN).

**Core is not split.** It is external in both modes unless it is a source workspace, so the
storage file, the Vite copy of `@_linked/server` and the Node copy all import Node's single core.
Its state is also `globalThis`-backed, so a second copy would share it: the shape registries (core
`src/utils/ShapeClass.ts:24-48`), `LinkedStorage` (`LinkedStorage.ts:19`), query dispatch
(`queries/queryDispatch.ts:148`), live-query registry (`live/registry.ts:18`), and
`server-utils`' access rules (`QueryAccess.ts:92`, a `WeakMap` on `globalThis`). These need no fix.
`Server` and `LincdServerProxy` are not `globalThis`-backed, and neither is class identity.

When core *is* a source workspace (CN with `_linked-core` localized), core is bundled and Vite's
SSR transform rewrites `loadStores`' `import(entry.store)` to the runner's dynamic import, so the
store should come from Vite's copy. Not measured.

## Options

1. **Import `loadStores`' stores through the SSR runner in dev.** `linked start` installs a loader
   hook that core's `loadStores` uses when present (for example a `globalThis` import function the
   CLI sets to `vite.ssrLoadModule`), falling back to `import()`. One loader in dev; no change to
   apps or to the datasets file. Needs a core change and a CLI change, and it only covers
   `loadStores`, not other native `import()`s.
2. **Externalize packages a datasets file can name.** Drop `@_linked/server` from
   `SSR_ENTRY_PACKAGES` and `server-utils` from the standalone list, so Node is the only loader for
   them. This undoes the reasons they are bundled: `start.ts:416-425` (`LinkedServer` must share
   module instances with the app's SSR tree) and `vite-config.ts:944-953` (two `AppContext`s
   standalone). Likely needs `LinkedServer` loaded by Node and the app's `App.tsx` to receive the
   same `server-utils` from Node, which is a larger change.
3. **Resolve datasets-file store paths through Vite's module graph.** The CLI reads
   `linked.backend.datasets.json` before loading the storage file, and for every `store` in a
   bundled package pre-loads it with `vite.ssrLoadModule` and hands `loadStores` the resolved
   classes (or a specifier → module map). Keeps the datasets-file format, needs `loadStores` to
   accept pre-resolved modules.

Option 1 or 3 keeps today's bundling decisions.

## Measured on a spike

Branch [`spike/dual-copies`](https://github.com/linked-fw/cli/tree/spike/dual-copies) (not for
merge). Test app: `linked create-app` from that branch's build, `npm install` from npm, then the
branch's `lib/` copied over `node_modules/@_linked/cli/lib` and the core half
(`spike/core-loadStores.patch`) applied to `node_modules/@_linked/core/lib/esm/utils/loadStores.js`.
The storage file prints `appData instanceof RemoteDataset` and, after `appData.init()` against
`http://127.0.0.1:9`, `err instanceof RemoteDatasetUnreachableError`, both against its own import.

| Build | `instanceof RemoteDataset` | `instanceof RemoteDatasetUnreachableError` | FusekiStore datasets file: `instanceof FusekiStore`, `GET /` |
|---|---|---|---|
| CLI 1.48.1 and core as published | `false` | `false` | `true`, 200 |
| Spike (loader hook) | `true` | `true` | `true`, 200 |
| Spike, loader = `vite.ssrLoadModule` for every store | `true` | `true` | **`false`**, 200 |

The last row is why the loader has two branches. Vite transforms an entry handed to
`ssrLoadModule` even when its package is external (the `SSR_ENTRY_PACKAGES` comment says the same),
so `ssrLoadModule('@_linked/fuseki/shapes/FusekiStore')` made a Vite copy of FusekiStore next to the
app's Node copy.

Two other routes were tried and do not work:

- **Bundling only `@_linked/core/utils/loadStores`** through `ssr.noExternal`: Vite 6 tests
  `noExternal` against the package name (`getNpmPackageName(id)` in `createIsConfiguredAsExternal`),
  so a subpath pattern never matches and the file stays external.
- **An alias for that subpath** does get the file inlined (Vite skips externalization for an
  import that matches an alias), but the runner's dynamic import of a bare specifier is always
  externalized at run time (`fetchModule`), so `import(entry.store)` still reached Node's copy.

## Recommended fix

Option 1, in two small changes that can ship in either order (each is a no-op without the other):

- **core** (`src/utils/loadStores.ts`): import through
  `globalThis[Symbol.for('@_linked/core:importModule')]` when it is a function, else `import()`.
  The diff is `spike/core-loadStores.patch` on the spike branch. About 1 hour with a unit test.
- **cli** (`src/commands/start.ts`): before the storage file loads, set that symbol to a loader
  that calls `vite.ssrLoadModule(specifier)` when the specifier's package is in the dev
  `ssr.noExternal` list, and otherwise imports the file Vite's SSR resolver returns for it
  (`vite.environments.ssr.pluginContainer.resolveId`) through Node, which is the copy the app's own
  import of an external package gets. About half a day with the CLI test below.

This covers `loadStores` only. The guard in backlog 015 finds the other paths: on the same spike it
reported eight more files Node loads from bundled packages in a template app, for example
`@_linked/server-utils/utils/Server` imported by `@_linked/schema/shapes/ImageObject.class`.
Those are fixed by 015's bundling change, not here. Whichever is chosen, app-template's `name` + `url`
fallback in `storageErrors.ts` and its `[storage]` log can go back to `instanceof` afterwards.

## Done when

- A CLI test starts a standalone app with `linked start` (dev) whose datasets file names
  `@_linked/server/shapes/quadstores/RemoteDataset`, and asserts that the store `loadStores`
  returned is `instanceof` the `RemoteDataset` the app's storage file imports, and that an error it
  throws is `instanceof` the app's `RemoteDatasetUnreachableError`. It fails on today's `main`.
- The same test, or a second one, asserts one copy of `@_linked/server-utils/utils/Server` (the
  local server `LinkedServer` set is the one the store's `Server.call` sees).
- app-template's `isError` fallback is removed in a follow-up there.
- The `linked start` dual-copy warning (backlog 015) prints nothing for `@_linked/server` in that
  test.
