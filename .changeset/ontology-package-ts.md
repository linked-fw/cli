---
'@_linked/cli': minor
---

A new ontology package's `src/package.ts` takes only what an ontology package uses from `linkedPackage(...)`: `registerOntologies` (its generated modules import it) and `packageName`; no `linkedShape`, `linkedUtil`, `getPackageShape`, `registerPackageExport` or `packageExports`. Its scaffold also has a `README.md` naming the package, its data file and how its modules are generated.
