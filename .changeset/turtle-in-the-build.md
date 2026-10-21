---
'@_linked/cli': minor
---

`linked build` ships a package's Turtle ontology data: `src/**/*.ttl` is copied into `lib/esm/` (and `lib/cjs/` when CommonJS is published) at the same relative path, so `src/data/x.ttl` becomes `lib/esm/data/x.ttl`. `linked build-app` copies the app's own `src/**/*.ttl` into `lib/` beside the compiled backend, and fails the build when that copy fails.
