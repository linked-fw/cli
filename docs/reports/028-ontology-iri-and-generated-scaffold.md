---
date: 2026-10-24
summary: >
  The generated data module's `_ontologyResource` is the IRI the data declares with
  `owl:Ontology` (owl → `http://www.w3.org/2002/07/owl`, dcat → `http://www.w3.org/ns/dcat`, the
  rest unchanged). `create-package --kind ontology` and `create-ontology` write the three accessor
  modules through the generator and add the `linkedOntologies` entry, so a new ontology package
  passes the build's module check. An empty terms module is now a module (`export {};`). Patch.
---

# 028 — The ontology IRI, and the scaffold from the generator

## Why

- Report 027's data module set `_ontologyResource = ns('')`, the namespace IRI. For owl and dcat
  that is `…/owl#` and `…/dcat#`; their official ontology IRIs, which their own Turtle declares
  with `a owl:Ontology`, have no `#`.
- Report 027 left the `create-ontology` / `create-package --kind ontology` scaffold on the old
  hand-written module (aggregated object, `_self`) without a `linkedOntologies` entry, so a new
  ontology package had a different module shape than every vocabulary package.

## What changed

- `ontologyTerms.ts`: `ontologyTermsFromQuads` also collects the named subjects typed
  `owl:Ontology` and returns `ontology`, chosen by the new `ontologyIriOf(declared, namespace)`:
  the namespace itself, else the namespace without its trailing `#` or `/`, else the only
  declaration the namespace starts with, else none (an unrelated declaration, another
  vocabulary's copied in, is never taken; nor is a blank node).
- `ontologyModules.ts`: `OntologyModuleSpec.ontology` (optional). The data module writes
  `_ontologyResource = ns('')` when it is absent or equals the namespace, else
  `_ontologyResource = {id: '<IRI>'}`. A terms module without terms ends with `export {};`:
  without it the file is not a module and the register module's `import * as terms` fails with
  TS2306, which is what a freshly scaffolded ontology (no terms yet) hit.
- `generateOntology.ts` passes the IRI through.
- `packageFiles.ts`: `ontologyScaffoldModules(prefix, namespace)` (the generator with no terms and
  the data file `../data/<prefix>.ttl`) and `withOntologyEntry(packageJson, prefix, namespace)`.
  `buildPackageFiles(…, 'ontology')` uses both; `createOntology` writes the same modules and
  entry into an existing package. `withOntologyEntry` keeps an existing entry (and its `data`
  list) and the file's indentation and line endings. `checkScaffoldOntology` refuses, before
  anything is written, a slug that is not a valid Turtle prefix or module name (`3d`, `foo.bar`)
  and a namespace `linkedOntologies` would reject (`ex.test/x/`); both used to be written and
  fail only at the first build. In an app without a `package.json` beside its `src/`,
  `create-ontology` says the modules are not declared and so not checked. `defaults/package-ontology/src/ontologies/example-ontology.ts`
  and `.register.ts` are deleted; only the Turtle template remains.
- `defaults/package/package.json`: `@_linked/core` ^2.41.0 (the generated data module imports
  `loadOntologyFiles` and the generated register shape), `@_linked/cli` ^1.57.0.
- `defaults/shape.ts`: the example names `import * as schema from '@_linked/schema/ontologies/schema'`.
- README: §ontology package and §Ontology accessor modules.

On the vocabulary packages' current data (dry run, `linked generate-ontology --check` with this
build):

```
xsd: Every ontology module is current.
rdfs: Every ontology module is current.
dcmi: Every ontology module is current.
owl: Out of date: src/ontologies/owl.data.ts. Run `linked generate-ontology`.
schema: Every ontology module is current.
dcat: Out of date: src/ontologies/dcat.data.ts. Run `linked generate-ontology`.
org: Every ontology module is current.
sioc: Every ontology module is current.
```

owl and dcat are regenerated and released as patches once this cli is published (their CI build
installs the latest cli and would otherwise fail the module check). sioc's data declares `sioc:`
and `sioct:`; the namespace match picks `sioc:`.

## Gate

- `npx jest --config jest.config.cjs`: "Tests: 1 skipped, 1044 passed, 1045 total" (the skip is
  `shapesTurtle.test.ts`'s golden comparison, skipped without core's generator, as on `main`).
- `npm run test:e2e`: "6 passed (1.8m)".
- `npm run test:template`:
  - `package.full.test.ts`: the scaffolded package installs `@_linked/cli` from npm (1.57.0),
    whose module check expects no `export {};`, so its build reports the new module as stale
    until this release is published. With this build's `lib/` copied into the scaffolded
    package's `node_modules/@_linked/cli`: "✔ Checking ontology modules … ✔ Build successful",
    with `lib/esm/ontologies/tmplprobe{,.data,.register}.js`.
  - `react-native.full.test.ts`: "npm run typecheck passes" and "expo export bundles for iOS"
    fail, and fail the same way on a clean `main` ("Tests: 2 failed, 8 passed, 10 total"). The
    template pins `@_linked/core` 2.28.3 and `@_linked/schema` 1.5.0, which brings a second core
    (`Types have separate declarations of a private property '_shape'`). Not touched here.

## Review

An independent review found no generator bug. Fixed: the IRI rule's sole-declaration fallback
took an unrelated ontology (now only one the namespace starts with); `withOntologyEntry`
overwrote an existing entry and reformatted the file; invalid slugs and namespaces were written
before failing; the app-layout log line; two stale comments; tests for a hyphenated slug, a
blank node, `urn:` namespaces and the refusals. Left as decided:

- **Patch, not minor.** The release brief says patch. Nothing exported is removed or renamed;
  the additions are optional fields and new helpers. A package whose committed modules were
  generated by 1.57.0 sees `linked build` report them stale only when its data declares the
  ontology without the namespace's `#` (owl, dcat, both regenerated here) or it has a terms module
  without terms (none published).
- **Create Now.** CN scaffolds project ontology packages through `buildPackageFiles`, so on this
  cli they get `linkedOntologies` and the generated modules, while CN's ontology builder still
  writes the old module. CN's lockfile pins its cli, and CN switches its builder to
  `generateOntologyModules` in the same change that raises its cli range (CN's report for this
  work).

## Follow-ups

- The react-native template's pinned `@_linked/*` versions (core 2.28.3, schema 1.5.0, server
  3.0.0, cli 1.46.0) should move to current releases; its typecheck and iOS export fail on `main`.
- Report 027's "report the modules of a dropped prefix" stays open.

## PR

### Summary

The generated `_ontologyResource` is the ontology IRI the data declares, and new ontology
packages get the generator's modules and a `linkedOntologies` entry.

### Changes

- `_ontologyResource` comes from the data's `owl:Ontology` subject: the namespace, else the
  namespace without its trailing `#`/`/`, else the only declaration the namespace starts with. owl and dcat change
  (`http://www.w3.org/2002/07/owl`, `http://www.w3.org/ns/dcat`); the other vocabularies don't.
- `create-package --kind ontology` and `create-ontology` write `<slug>.ts`, `.data.ts` and
  `.register.ts` through the generator, and add `"linkedOntologies"` to `package.json`. The
  hand-written template is gone.
- An empty terms module ends in `export {};` so it compiles as a module.
- Package template ranges `@_linked/core` ^2.41.0, `@_linked/cli` ^1.57.0; the shape template's
  example uses the namespace import.

### Verification

- Unit: "Tests: 1 skipped, 1044 passed, 1045 total".
- e2e: "6 passed (1.8m)".
- A scaffolded ontology package built with this cli: "✔ Checking ontology modules … ✔ Build
  successful".
- `generate-ontology --check` on the vocabulary packages: only `owl.data.ts` and `dcat.data.ts`
  change.

### Deviations

- `test:template`'s package test can only pass once this release is on npm (the scaffold
  installs the cli from npm); verified with this build copied in. Its react-native test fails
  the same way on `main`.

### Follow-ups

- Regenerate and release owl and dcat.
- Update the react-native template's pinned versions (this report, §Follow-ups).
