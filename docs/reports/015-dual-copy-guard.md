---
date: 2026-10-18
summary: >
  `linked start` warns when Node loads a file of a `@_linked/*` package the dev Vite SSR runner
  bundles (backlog 015 option A). One status line per boot, one `TWO COPIES` line per file naming
  the package, file, specifier and importer. Files under `node_modules` and in localized checkouts
  or workspaces (by `package.json` name) both count; the CLI never does. Measured: a fresh template
  app flags 8 files with a `RemoteDataset` datasets file and 13 with FusekiStore, as on the spike;
  CN (worktree, installed packages only) flags none. Minor release.
---

# 015 — The two-copies guard in `linked start`

## What changed

- `src/utils/dual-copy-guard.ts`: `installDualCopyGuard({noExternal})` registers a resolve hook
  with Node's in-thread `module.registerHooks`. The hook calls `next` first, ignores results that
  are not `file:` URLs, and reports a file when its package is a `@_linked/*` name the dev
  `ssr.noExternal` matches (`isBundled` from `ssrBundled.ts`; `noExternal === true` means every
  package). `@_linked/cli` is never reported. Each `<package>/<file>` is reported once.
- `createLinkedFileMatcher`: a file under `/node_modules/@_linked/<name>/` (innermost
  `node_modules`) is matched by its path; any other file belongs to the nearest `package.json`
  above it that has a `name` (a nameless `lib/esm/package.json` is skipped), cached per directory.
  That covers a localized checkout, whose realpath is under `packages-local/`, and source
  workspaces. A file under a `node_modules` package that is not `@_linked/*` costs no lookup.
- `src/commands/start.ts`: installed right after the store loader, before the storage file
  loads, with the dev server's `vite.config.ssr.noExternal`.
- Output, exactly one status line per boot:
  ```
  [linked] dual-copy guard: on
  [linked] dual-copy guard: off (LINKED_DUAL_COPY_GUARD=0)
  [linked] dual-copy guard: off (Node <version> has no module.registerHooks)
  [linked] TWO COPIES: Node loaded <package>/<file> (imported as "<specifier>" from <importer URL>), but <package> is bundled for the Vite SSR runner. Classes from it will fail `instanceof` and its module state exists twice.
  ```
  The status line goes to stdout, `TWO COPIES` lines to stderr. The guard never fails a boot.
- Node 22.23.3 prints no `ExperimentalWarning` for `module.registerHooks` (none in either
  template boot log below).
- Unit tests `tests/unit/dualCopyGuard.test.ts` (17): the matcher on `node_modules`, nested
  `node_modules`, non-file URLs and a `packages-local/_linked-server-utils` realpath fixture with a
  nameless `lib/esm/package.json`; one directory read per directory; the contract line; external
  packages and the CLI not reported; `noExternal` `true`, a single string or RegExp, and unset; one
  report per file across importers; the three status lines, with `registerHooks` and the reporters
  injected.
- README section "Two copies of a framework package"; backlog 015's status.

## Measured

### Template app

App-template `main`, created with this build (`node lib/esm/launch.js create-app probe …
--skip-install`), `npm install`, `npm install` of this build's `npm pack` tarball and of
`@_linked/core@2.35.0` (the template's lockfile still has 2.33.0, which ignores D1b's loader).
`linked start` on its own port with Node v22.23.3; `grep -c "TWO COPIES"` on the boot log.

| Datasets file | Status line | `TWO COPIES` | Boot |
|---|---|---|---|
| RemoteDataset at `http://127.0.0.1:9` | `[linked] dual-copy guard: on` | 8 | stops with `Could not reach the data server at http://127.0.0.1:9` |
| FusekiStore (committed default, own dataset) | `[linked] dual-copy guard: on` | 13 | `[storage] appData: FusekiStore`, `GET /` 200 |

Both counts are the spike's (backlog 015 §Measured). The files, importers shortened to
`…/node_modules/`:

```
@_linked/react/lib/esm/utils/LinkedComponent.js (imported as "@_linked/react/utils/LinkedComponent" from …/@_linked/schema/lib/esm/package.js)
@_linked/react/lib/esm/hooks/useLinkedQuery.js (imported as "../hooks/useLinkedQuery.js" from …/@_linked/react/lib/esm/utils/LinkedComponent.js)
@_linked/react/lib/esm/hooks/useLinkedSetQuery.js (imported as "../hooks/useLinkedSetQuery.js" from …/@_linked/react/lib/esm/utils/LinkedComponent.js)
@_linked/react/lib/esm/hooks/of.js (imported as "../hooks/of.js" from …/@_linked/react/lib/esm/utils/LinkedComponent.js)
@_linked/react/lib/esm/hooks/useLiveQuery.js (imported as "./useLiveQuery.js" from …/@_linked/react/lib/esm/hooks/useLinkedQuery.js)
@_linked/server-utils/lib/esm/utils/Server.js (imported as "@_linked/server-utils/utils/Server" from …/@_linked/schema/lib/esm/shapes/ImageObject.class.js)
@_linked/server-utils/lib/esm/utils/LincdServerProxy.js (imported as "./LincdServerProxy.js" from …/@_linked/server-utils/lib/esm/utils/Server.js)
@_linked/server-utils/lib/esm/utils/ServerCallError.js (imported as "./ServerCallError.js" from …/@_linked/server-utils/lib/esm/utils/Server.js)
```

The FusekiStore boot gets further (the server's providers load) and adds five:

```
@_linked/server-utils/lib/esm/utils/ShapeProvider.js (imported as "@_linked/server-utils/utils/ShapeProvider" from …/@_linked/schema/lib/esm/shapes/ImageObjectProvider.js)
@_linked/server-utils/lib/esm/utils/callable.js (imported as "@_linked/server-utils/utils/callable" from …/@_linked/schema/lib/esm/shapes/ImageObjectProvider.js)
@_linked/server-utils/lib/esm/utils/BackendProvider.js (imported as "./BackendProvider.js" from …/@_linked/server-utils/lib/esm/utils/ShapeProvider.js)
@_linked/server-utils/lib/esm/utils/CallContext.js (imported as "./CallContext.js" from …/@_linked/server-utils/lib/esm/utils/BackendProvider.js)
@_linked/react/lib/esm/utils/ClassNames.js (imported as "@_linked/react/utils/ClassNames" from …/@_linked/primitives/lib/esm/components/Button.js)
```

No `@_linked/server` file is flagged: D1b's loader gives `RemoteDataset` the runner's copy. All
13 come from the external `@_linked/schema` and `@_linked/primitives` importing the bundled
`@_linked/react` and `@_linked/server-utils`, which the standalone bundling change (backlog 015
option C) removes.

### CN boot proof

A CN worktree of `main` (`e4af26cbc`), `npm ci`, `npm install` of this build's tarball, then
`CN_TEST_PORT=4079 npx playwright test tests/e2e/signin.spec.ts`:

```
[globalSetup] CN is healthy on :4079 after 23.2 s
  5 passed (45.0s)
```

`grep -E "dual-copy guard|TWO COPIES"` on the log:

```
[CN] [linked] dual-copy guard: on
```

`grep -c "TWO COPIES"`: 0. A CN worktree has no `packages-local/`, so this measures CN with every
`@_linked/*` installed from npm: the dev `ssr.noExternal` is CN's workspace packages, their
installed dependents and `@_linked/server`. The owner's localized layout (every framework package
a `packages-local/` checkout, all bundled) was not measured: the owner's CN was listening on
:4040, and the lib overlay is never run under a running CN.

The log has `[CN-err] Fatal socket error Error: read ECONNRESET` lines during the sign-in
redirects (4 under `[CN-err]` with this build, and one unprefixed). The same proof with `@_linked/cli@1.48.2` from npm
in the same worktree logs 4 as well (`5 passed (34.9s)`, no guard line), so they predate 1.49.0
and are not the CLI's.

## Not done here

- Bundling every `@_linked/*` but core and the CLI in a standalone app (backlog 015 option C,
  CN plan 068 step D3), which is expected to take the template's counts to 0.
- The CLI e2e that fails on a `TWO COPIES` line or a guard that is not `on` (option B, step D4).
- CN's count in the localized layout, at D3's CN measurement.

## PRs

- https://github.com/linked-fw/cli/pull/286
