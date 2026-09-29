---
"@_linked/cli": minor
---

`createViteConfig` now applies its `process.env.*` defines (`NODE_ENV`, `SITE_ROOT`, `APP_NAME`, and anything passed as its `define` option) to the **client environment only** (`environments.client.define`), no longer to the top-level `define` that the SSR environment inherits.

A top-level define reached the server in two harmful ways. Vite's define pass runs `esbuild.transform` without `keepNames` over every SSR module containing a key, which renamed tsc-emitted decorated classes — `@_linked/server`'s `LinkedServer` and `LincdAPI` registered as `LinkedServer2` / `LincdAPI2` in dev, so their shape IRIs no longer matched. And in a release backend build it inlined the build machine's `SITE_ROOT` instead of reading the deployment's.

Behaviour change: server-side code loaded through Vite now reads `process.env.SITE_ROOT`, `APP_NAME` and `NODE_ENV` at runtime in dev as well, so those must be set in the server's environment (they already had to be for any externalised package). Apps that add their own top-level `define` in `vite.config` should move it to `environments.client.define`.
