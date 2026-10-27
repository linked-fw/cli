---
"@_linked/cli": patch
---

A directory counts as a workspace root only when one of its `workspaces` globs matches a package that exists. An app that lists `packages-local/*` with no checkout of its own, run inside a parent workspace, no longer stops the `node_modules` walk: the dev resolver, `linked start`'s HMR watch list and `linked doctor resolve` find the parent's localized `@_linked/*` checkouts instead of letting Node load a second copy of `@_linked/core`.
