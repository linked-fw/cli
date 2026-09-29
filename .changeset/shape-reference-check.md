---
'@_linked/cli': minor
---

`linked build` now checks that loading a shape module registers every shape its properties point at.

A property that names its value shape by `[package, name]` (`shape: ['@_linked/schema', 'ImageObject']`)
does not load that shape, and consumers deep-import single shape modules. So a package could ship a
module whose query `workspace.image.contentUrl` threw `Shape class not found for …/ImageObject` in a
production bundle where nothing else happened to load ImageObject — which is how Create Now came to
show "No organizations found". `@_linked/sioc` also named shapes under its old package name
(`lincd-sioc`), which could never resolve.

The new step, **Checking shape references**, runs after the ESM output is final. It loads every module
under `lib/esm/shapes/` (and any other module that declares a `@linkedShape`) in a `node` process of
its own, with nothing imported first, and then **fails the build** for:

- a module that throws when loaded on its own (e.g. `Cannot access 'X' before initialization`);
- a property of one of the package's shapes whose value shape is not registered — naming the
  property, the missing shape's IRI and the modules that showed it, and whether the target package's
  entry registers it (a missing import), does not (a wrong name), or the IRI belongs to no dependency
  (an old package name).

`*.class.js` modules are skipped: they are the class half of a split shape module and are checked
through the public module that re-exports them. Asset imports (`.css`, images, fonts) load as stubs.
`@_linked/core`'s `PropertyShape.in → List` is a known, tracked gap and warns instead of failing.
