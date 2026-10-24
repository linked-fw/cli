---
'@_linked/cli': minor
---

Add `linked generate-ontology`, which writes a package's ontology accessor modules from its Turtle: for each prefix in `package.json` `"linkedOntologies"`, `src/ontologies/<prefix>.ts` (one pure `export const Term = ns('Term')` per subject in the namespace, with a JSDoc line), `<prefix>.data.ts` (`ns`, `dataFiles`, `loadData`, `_ontologyResource`, `Prefix.add`) and `<prefix>.register.ts`. `linked build` fails when a committed module is stale. The generator is importable as `@_linked/cli/utils/ontologyModules` (pure) and `@_linked/cli/utils/ontologyTerms`. The dev SSR shim no longer re-exports itself when Vitest inlines `@_linked/cli/*`, so a cli helper imported in an app's Vitest run is defined.
