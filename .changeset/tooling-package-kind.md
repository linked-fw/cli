---
'@_linked/cli': minor
---

A package kind `tooling`, for a build or dev tool with no shapes, ontology or components. `linked build` (and the editor-hook `build-package`) builds it like a `library`, but it is not a linked package: `isLinkedPackageJson` is now true only for `ontology`, `assets` and `library`, so boot loading, the dev resolver, Vite's dependency exclusion, `discoverInstalledLinkedPackages` and any host that imports or lists linked packages leave it out. `isLinkedPackageKind(kind)` is the same test for a caller that holds the kind, and `isBuiltByLinkedBuild(json)` answers "does `linked build` build this". The CLI's own `package.json` now declares `"kind": "tooling"`.
