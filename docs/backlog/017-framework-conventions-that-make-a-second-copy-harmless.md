---
summary: >
  Two package conventions that make a second copy of a framework module harmless instead of
  wrong: module state lives on `globalThis` under `Symbol.for('@_linked/<pkg>:<name>')`, and
  errors are matched across packages by a brand check in core (`isLinkedError(err, Cls)`), not
  `instanceof`. Two pieces of `server-utils` module state are left (`Server`'s `proxy`,
  `LincdServerProxy.defaultHeaders`). Estimate 1 to 2 days across server-utils, server and core.
  Option D of backlog 015; not scheduled.
status: Open -- not scheduled
---

# 017 — Framework conventions that make a second copy harmless

## Why

Under `linked start` (dev) a framework module can be evaluated twice, once by Vite's SSR module
runner and once by Node ([backlog 014](014-dev-loads-a-second-copy-of-datasets-file-stores.md),
[backlog 015](015-one-copy-of-each-framework-package.md)). CN plan 068 phase 4 removes the copies
it knows of: core's `loadStores` imports through the loader `linked start` installs, a guard warns
on every file Node loads from a bundled package, and standalone apps bundle every `@_linked/*`
but core and the CLI. Each of those removes a copy. None of them makes a copy that still happens
harmless, and a new native `import()` or a new bundling exception can bring one back.

Core already survives a second copy: its registries (`ShapeClass`, `LinkedStorage`, query
dispatch, the live-query registry) are on `globalThis`, so two copies share them. This item asks
the other framework packages to follow the same rule, and adds the one thing `globalThis` cannot
give: error identity across copies. This is option D in backlog 015.

## The two conventions

**1. Module state on `globalThis`, keyed by package.** A module-level variable that more than one
caller writes or reads (a registry, a configured singleton, a static that callers mutate) is
stored at `globalThis[Symbol.for('@_linked/<pkg>:<name>')]`, created on first use. Two copies of
the module then read and write the same value. What is left today, in `@_linked/server-utils`:

- `src/utils/Server.ts:16`, the module-level `proxy`, whose `localServer` `Server.setLocalServer`
  writes (`:28-33`). `LinkedServer` sets it on one copy; a `RemoteDataset` without a `url` calls
  `Server.call` on whichever copy it was loaded with.
- `src/utils/LincdServerProxy.ts:92`, the static `LincdServerProxy.defaultHeaders`, which
  `addDefaultHeaders` replaces (`:118-119`). Headers the app adds reach one copy only.

Classes stay per copy; only the state moves.

**2. Error brand checks instead of `instanceof` across packages.** Core exports
`isLinkedError(err, Cls)`: every framework error class sets a brand, a `Symbol.for` key naming
the class (`Symbol.for('@_linked/<pkg>:<ClassName>')`), and the check reads the brand along
`err`'s prototype chain, so a subclass matches its base as `instanceof` does. An error thrown by
one copy of `@_linked/server` then matches the class the app imported from the other. Code that
catches an error from another package (the app template's `storageErrors.ts` matching
`RemoteDatasetUnreachableError`, CN catching store errors) uses `isLinkedError` instead of
`instanceof`. The app template's `name` plus `url` fallback (app-template#26) is the hand-written
form of this check.

## Scope and estimate

1 to 2 days across `@_linked/server-utils` (the two pieces of state, unit tests that load the
module twice), `@_linked/core` (`isLinkedError` and the brand helper, unit tests) and
`@_linked/server` (brand its error classes, starting with `RemoteDatasetError` and its
subclasses). Each package releases a minor on its own; consumers switch to `isLinkedError` as
they are touched. A short section in each package's README states the conventions for new code.

## Status

Not scheduled. CN plan 068 phase 4 removes the known second copies first; this item is the
follow-up that keeps a future one from failing silently.
