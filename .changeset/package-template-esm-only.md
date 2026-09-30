---
'@_linked/cli': patch
---

`create-package` now scaffolds an ESM-only, lib-only package: `"type": "module"`, `main` and every `exports` entry point at `lib/esm`, no `require` condition, no CJS build, no `tsconfig-cjs.json` and no `tsconfig-to-dual-package`. A CJS build of a package that imports `@_linked/core` could never load, because core is ESM-only.
