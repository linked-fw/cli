---
date: 2026-10-30
summary: >
  Closes backlog 002 (the unit suite could not resolve `@_linked/*`). Fixed by commit e8cd54d
  (2026-09-25): the jest config walks the `node_modules` chain upward and derives core's layout
  from its `exports` map, instead of a `<rootDir>/node_modules` mapper.
---

# 045 — The unit suite resolves `@_linked/*`

Was backlog 002. Six suites (`buildApp`, `publisher`, `appAssetsStore`, `createApp.reactNative`,
`esmSpecifiers`, …) died at collection with `Could not locate module
@_linked/core/utils/LinkedFileStorage`: `moduleNameMapper` hard-coded
`<rootDir>/node_modules/@_linked/core/lib/esm/…`, which does not exist when the workspace hoists
the dependency.

Commit e8cd54d (`fix(test): resolve @_linked/core from the node_modules chain, not <rootDir>`, on
`dev`) resolves `@_linked/core` the way Node does, walking `node_modules` upward, and takes the
on-disk layout from core's `exports` map. `require.resolve()` was not usable: core is ESM-only and
its export map has no `require` condition. The same commit gives the first
`resolveViteServerConfig` test 60 s for its cold Vite load. This is backlog 002's fix direction 2
(resolve through Node rather than a hand-written map).
