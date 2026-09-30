---
"@_linked/cli": patch
---

`build-app` now checks every file of the compiled backend for a compiled-in copy of a package, not only `backend.js`, `App.js` and `routes.js`. Each relative import in `lib/` is resolved and the module it reaches is traced back through its sourcemap to the source it was compiled from; if that source's real path is inside a workspace package, `packages-local/`, or an installed `@_linked/*` package, the build fails. This catches a copy reached from deep inside a feature folder, and a localized checkout whose real path has no `node_modules` in it. The build also fails if `lib/packages/`, `lib/packages-local/` or `lib/node_modules/` exists (unless the app has a `src/` directory of that name). The error names the importing file and the import, and points at the package's public export.
