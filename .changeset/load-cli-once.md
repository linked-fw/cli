---
"@_linked/cli": patch
---

The dev server no longer loads a second copy of `@_linked/cli`. Vite's SSR runner hands the CLI's imports to Node, which resolves them to the `lib/` files the running CLI already loaded, even when the CLI is a source workspace.
