---
'@_linked/cli': minor
---

`linked build` checks the package's shapes against the class hierarchy after compiling: it loads the built package's `package.js`, `shapes/index.js` and ontology data, registers the ontology data of the package and its linked dependencies through `@_linked/core/ontology/registerInstalled`, and runs `@_linked/core/shapes/checkShapeHierarchy`. Every finding is printed and an `error` (an `extends` its data does not back, a subclass whose shape does not extend its superclass's shape, a borrowed target class, an undefined term in a mirrored namespace) fails the build. `--skip-shape-check "<reason>"` skips the check and prints the reason. A package without shapes or without a `@_linked/core` dependency is not checked; a core without `shapes/checkShapeHierarchy` or `ontology/registerInstalled` warns and skips.

The build's dependency check no longer drops the last missing dependency from its warning when `react` is not among them.
