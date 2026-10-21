---
'@_linked/cli': minor
---

`linked build` ships a package's Turtle ontology data: `src/**/*.ttl` is copied into `lib/esm/` (and `lib/cjs/` when CommonJS is published) at the same relative path, so `src/data/x.ttl` becomes `lib/esm/data/x.ttl`. `linked build-app` copies the app's own `src/**/*.ttl` into `lib/` beside the compiled backend, and fails the build when that copy fails.

New ontology packages are scaffolded in Turtle (`create-package --kind ontology`, `create-ontology`, `buildPackageFiles`): `src/data/<name>.ttl` replaces the `.json` and `.json.d.ts` files, `loadData` calls `@_linked/core/ontology/loadOntologyFiles(import.meta.url, ['../data/<name>.ttl'])`, and the register module passes `['../data/<name>.ttl']` to `linkedOntology`. The scaffold needs a `@_linked/core` that exports `ontology/loadOntologyFiles`.
