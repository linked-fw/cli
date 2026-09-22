---
'@_linked/cli': patch
---

Keep registry-installed framework packages in the `linked` chunk.

`manualChunks` grouped `@_linked/*` into `linked` only when the module resolved
to a workspace path. An app can hold both at once — a published
`@_linked/server` in `node_modules` alongside a workspace `@_linked/core` — and
the published copy fell through to the catch-all `vendor` chunk. The two then
imported each other, and Rollup's chosen order left a binding in its temporal
dead zone: `Cannot access 'Wo' before initialization`, thrown before the app
rendered anything.

`node_modules/@_linked/*` and `node_modules/lincd-*` now join the workspace
copies in `linked`.
