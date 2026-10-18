---
"@_linked/cli": minor
---

Dev SSR bundles every `@_linked` package but core and the CLI in a standalone app. `linked start` in an app without workspaces now sets `ssr.noExternal` to `/^@_linked\/(?!(core|cli)$)/` (exported as `STANDALONE_SSR_BUNDLED`), so Vite's SSR runner evaluates each framework package once. Before, only `server`, `server-utils` and `react` were bundled, and an external package (`schema`, `primitives`, `auth`, `fuseki`) importing one of them loaded a second Node copy: a fresh template app had 8 to 13 files flagged by the dual-copy guard, now none. Workspace mode and release builds keep their lists. An app needs `@_linked/core` 2.34.0 or later, whose `loadStores` imports stores through `linked start`'s loader; with an older core a store named in the datasets file (such as `FusekiStore`) is loaded by Node next to the runner's copy, and the guard reports it.
