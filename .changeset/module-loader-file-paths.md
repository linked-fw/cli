---
'@_linked/cli': minor
---

The `linked start` module loader also loads package files by absolute path, so ontology registration (core's `registerInstalledOntologies`) and any future module discovery through core's `importPackageModule` uses one copy of each package. A file of a package the Vite SSR runner bundles goes through the runner (for a source workspace, `lib/esm/<p>.js` is replaced by its `src/<p>.ts`); a file of an external package is imported by Node. Package specifiers (stores) load as before. The dual-copy e2e installs the core under test (`E2E_CORE`, default `@_linked/core@latest`) and checks that the ontology phase loads no second copy.
