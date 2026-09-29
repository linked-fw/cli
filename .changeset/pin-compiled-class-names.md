---
'@_linked/cli': patch
---

`createViteConfig` now keeps compiled decorated classes named as written. Vite re-prints any published module that mentions `process.env` or `import.meta.env` (client build) or `process.env.NODE_ENV` (dev client) with esbuild, which renamed tsc's `let Foo = class Foo` to `class Foo2` — and an unnamed shape's IRI is its class name. A new `linked:pin-compiled-class-names` plugin pins each such class's name right after its declaration, before its decorators run.
