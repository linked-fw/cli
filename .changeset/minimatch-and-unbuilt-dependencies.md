---
'@_linked/cli': patch
---

`linked build` loads when the install resolves a CommonJS `minimatch` (3.x, as a fresh scaffold may hoist): the cli reads it through a namespace import instead of a named one. The build's shape hierarchy check loads a linked dependency's ontology register modules from `src/` when its `lib/` has none, so a dependency not built yet no longer causes a false `extends-without-subclass`.
