---
'@_linked/cli': patch
---

`linked create-package` now scaffolds `"build": "linked build"`, so a new package builds with the CLI's own pipeline (ESM compile, asset copy, import specifier rewrite and shape checks) instead of a hand-written `tsc` and copy chain. The template drops the `build-esm` and `copy-to-lib` scripts and the `rimraf` and `copyfiles` devDependencies, and requires `@_linked/cli` `^1.45.0`. Existing packages are not changed.
