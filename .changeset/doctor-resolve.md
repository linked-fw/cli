---
"@_linked/cli": minor
---

`linked doctor resolve [--json]` shows where Vite and Node resolve each `@_linked` package. A package Vite takes from another directory than Node is flagged `overlay`, or `two-copies` when Node also loads it during `linked start` (`@_linked/cli` and the `@_linked/*` packages the app's `vite.config` imports); it exits 1 on `two-copies`.
