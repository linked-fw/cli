---
date: 2026-10-19
summary: >
  Backlog 017 done: the two conventions that make a second copy of a framework module harmless
  are written down (architecture doc "shared state and error brands"), core 2.36.0 ships
  `sharedState` and `brandLinkedError` / `isLinkedError`, and server-utils 1.13.0 and server 3.2.0
  share their caller-set state and brand their errors. A survey of every `@_linked/*` package found
  more than the backlog named (core 14, auth 13, server-utils 7, server 5, translation 3 plus a
  context, shape-ui 3 contexts, react, schema, primitives); the rest is filed in each repo's backlog.
---

# 020 — Shared state and error brands

Replaces backlog 017. The convention:
[shared state and error brands](../architecture/shared-state-and-error-brands.md).

## What shipped

| Package | Release | Change |
|---|---|---|
| `@_linked/core` | 2.36.0 ([core#349](https://github.com/linked-fw/core/pull/349)) | `sharedState(pkg, name, init)`, `sharedStateKey`; `brandLinkedError(Cls, pkg, name)`, `isLinkedError(err, Cls)`, `linkedErrorBrand`. `UnresolvedContextError` and `ShapeValidationError` branded. |
| `@_linked/server-utils` | 1.13.0 ([server-utils#98](https://github.com/linked-fw/server-utils/pull/98)) | `Server`'s proxy and local server, `LincdServerProxy`'s default headers, auth handler and action handlers, `LinkedEmail`'s provider, the live-update log, request data shared; `ServerCallError` branded. |
| `@_linked/server` | 3.2.0 ([server#187](https://github.com/linked-fw/server/pull/187)) | `server.rawQueries`, `server.rpcExposure` and the query catalog resolver shared; process setup (cookie-jar `fetch`, `process` listeners) once per process; `RemoteDataset*Error` and `FatalStartupError` branded. |

Each has a test that loads a second copy of the module (core and server: `jest.isolateModulesAsync`;
server-utils: the built file imported twice with a `?copy` query) and asserts the copies are
distinct, the state is shared, and an error from the other copy fails `instanceof` but matches
`isLinkedError`.

## Survey

Every `@_linked/*` package's `src/` was read for module-level mutable state, module-level React
contexts and `instanceof` on another package's classes. The per-package table is in the
architecture doc. Two things the backlog did not anticipate:

- **The size.** The backlog named two pieces of server-utils state; the survey found about 45
  values that must be shared across nine packages. Two of server's defaults are the permissive ones
  (`rawQueries: 'session'`, `rpcExposure: 'warn'`), so a second copy loosened access silently.
- **Class identity beyond errors.** About 75 sites in core and 9 in react check `instanceof Shape`,
  `ShapeSet`, `QueryBuilder`, `PendingQueryContext` and similar on values that can come from another
  copy. `isLinkedError` does not cover them; core backlog 057 proposes `isLinkedInstance`.

## Filed

Every item below is now done; the architecture doc's status table links each package's report
(cli#301).

| Repo | Backlog |
|---|---|
| core | 057 — 14 pieces of core state, cross-copy `instanceof` on core classes |
| auth | 009 — 13 pieces of state, 2 contexts, `FatalConfigError` |
| translation | 003 — 3 registries, `TranslationContext` |
| react | 001 — 9 `instanceof` sites, `shapeToComponents` |
| shape-ui | 002 — 3 contexts |
| schema | 002 — `MediaUploadPolicy` |
| primitives | 001 — toast store, 2 compound contexts |

Not filed: `@_linked/fuseki`'s `FusekiQueryError` is unbranded (brand when touched); `@_linked/sentry`
writes core's `LinkedErrorLogging`, covered by core 057; core's new `UnresolvedShapeError`
(core#350, merged the same hour) is unbranded and belongs with 057.

## PRs

- https://github.com/linked-fw/cli/pull/298 (the convention and this report)
- https://github.com/linked-fw/cli/pull/301 (the architecture doc's status table: every package's row done, linking its report)
