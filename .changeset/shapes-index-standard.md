---
'@_linked/cli': minor
---

`linked build` now enforces the shape-registration standard: every package registers its whole
shape set through `src/shapes/index.ts`, and apps load it with `import '<pkg>/shapes/index'`.

Two new build steps, after "Checking shape references":

- **Checking shapes/index** loads `lib/esm/shapes/index.js` on its own in a fresh process and fails
  when it misses any of the package's shapes that its shape modules register when each is loaded
  alone (the per-module loads are shared with the shape-references check, not repeated). It also
  fails when the package has shapes but no `shapes/index`, or when the index throws on load. The
  error lists the missing shapes and the exact `import './X.js';` lines to add. A package without
  shapes passes.
- **Checking sideEffects** fails when `package.json` `sideEffects` is `false`, or is a list that
  does not match every `lib/esm/shapes/**/*.js`: a bundler drops a side-effect-only import of a
  module declared side-effect-free, so the index would register nothing in production. The error
  names the uncovered modules and what to write instead (omit the field, or
  `["lib/esm/shapes/index.js", "lib/esm/shapes/*.js"]`).

`linked create-shape` now writes to the `src/shapes/index.ts` next to the source folder it created
the shape in, rather than the one under the current directory. The package template's
`shapes/index.ts` states the side-effect-imports-only rule, and the React Native template's shapes
package gains a `src/shapes/index.ts` that its entry imports.

The shape-references check no longer tolerates `@_linked/core`'s `PropertyShape.in -> List`: core
now registers `List` wherever `PropertyShape` is registered, so the known-unresolved list is empty
and that reference fails the build like any other.
