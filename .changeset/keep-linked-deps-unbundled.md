---
'@_linked/cli': patch
---

`createViteConfig` now keeps the app's installed linked packages out of Vite's dependency pre-bundler in every dev mode, not only in standalone apps. An app with source workspaces (its own `packages/*-ont`) still installs the framework from npm; pre-bundling it duplicated `@_linked/core` per chunk and renamed shape classes (`Person` → `Person3`), so the server rejected every query with "Cannot resolve shape". The optimizer also runs esbuild with `keepNames: true` as a second guard.
