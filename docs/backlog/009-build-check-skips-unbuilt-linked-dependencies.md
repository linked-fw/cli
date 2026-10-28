---
summary: >
  The post-build shape check now loads a linked dependency's `src/ontologies/*.register.ts` when
  its `lib/` has no register modules (report 035). Left: a dependency whose `lib/` has some register
  modules but predates a newer one in `src/` still registers only the built ones, because core's
  `registerInstalledOntologies` falls back to `src/` per package, not per module; and the check
  still says nothing when a linked dependency registers nothing at all.
status: Open -- the partly stale lib case; the main case is fixed (report 035)
---

# 009 — The build check skips a dependency's register modules its `lib/` lacks

Source: CN plan 070, independent review of `store-inference` (report 025). The unbuilt-dependency
case is fixed in report 035: `collectShapeCheckInputs` sets `tsLoader` when a dependency has register
modules only in `src/`, and the check's child passes core an `importModule` through the cli's TS
loader.

## What is left

- **A partly stale `lib/`.** Core's `registerInstalledOntologies` imports `lib/esm/ontologies/*.register.js`
  and falls back to `options.importModule` over `src/ontologies/*.register.ts` only when `lib/` has
  none. A dependency built before it gained a second ontology registers the first only, and a shape
  extending a class of the second can still get a false `extends-without-subclass`. A fix belongs in
  core (fall back per module, or prefer `src/` when `importModule` is given and `src/` is newer).
- **A silent skip.** A linked dependency that registers nothing (no register modules anywhere, or
  no TS loader found beside the cli's build) is not mentioned. A warning naming it would make a
  false finding explainable.

## First questions

- Per-module fallback in core, or compare `src/` and `lib/` modification times?
- Warn in the build step's output, or only when the check reports an `extends-without-subclass`?
