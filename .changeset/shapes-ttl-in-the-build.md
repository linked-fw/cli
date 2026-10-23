---
'@_linked/cli': minor
---

`linked build` writes the package's shapes as Turtle to `lib/esm/data/shapes.ttl` (build step
**Writing shapes.ttl**), with `packageShapesTurtle(<package name>)` from the
`@_linked/core/shapes/shapesToTurtle` the package resolves, so the file is byte-identical to what
an app's server generates in process for its shape graph. A package that registers no shapes gets
no file, and a file left by an earlier build is removed. A package built against a core without
`shapes/shapesToTurtle` (before the shape-graph release) gets a warning and no file.

Breaking: none. Packages released with this cli ship `lib/esm/data/shapes.ttl` in their tarball.
