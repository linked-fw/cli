---
summary: >
  The post-build shape check calls core's `registerInstalledOntologies` without `importModule`,
  so a linked dependency that is not built yet registers no ontology data. When packages build
  out of order, a shape extending a dependency's shape can be reported `extends-without-subclass`
  although the dependency's data declares the subclass.
status: Open -- a low from the review of the shape check (CN plan 070); not fixed
---

# 009 — The build check skips unbuilt linked dependencies

Source: CN plan 070, independent review of `store-inference` (report 025).

## Problem

`src/utils/shapeHierarchy.ts` runs the shape check in a child process that registers the
ontology data of the package and of every linked dependency through
`registerInstalledOntologies(packageDirs)` (line 202), with no `options.importModule`. Core then
reads only `lib/esm/ontologies/*.register.js`; a dependency without a built `lib/` (a workspace
package not built yet) is skipped silently. Its `rdfs:subClassOf` triples are missing from the
hierarchy, so a shape of the package that extends one of that dependency's shapes can get a false
`extends-without-subclass` error, depending on the order in which `build-all` (or the developer)
builds packages.

## First questions

- Pass an `importModule` that can load `src/ontologies/*.register.ts` (tsx, or a Vite SSR loader)
  in the check's child process, or make the check build order explicit (dependencies first, which
  `build-all` already does) and report a skipped dependency instead of staying silent?
- At least: warn when a linked dependency registered nothing, so a false finding is explainable.
- A test: a package whose dependency has only `src/` gets no false `extends-without-subclass`.

## Fixed: the unit test that expected a widening override to warn

`tests/unit/shapeHierarchy.test.ts` expected `override-not-tightened` with `severity: 'warning'`
and a passing build. Core reports it as an error for a decorated shape (core report 044), so the
test failed. It now asserts the error and that `checkShapeHierarchyStep` fails the build
("override-not-tightened: a widening override of a decorated shape fails the build"), and passes.
