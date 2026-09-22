---
'@_linked/cli': patch
---

The TypeScript loader resolves a relative `./x.js` onto `./x.ts`.

This is the NodeNext convention — TypeScript requires the `.js` spelling in
source that emits ESM and rewrites nothing — so a module written that way could
previously only be loaded from a built `lib/`, never from source. The loader
now falls back to the TypeScript file when the `.js` does not exist on disk,
matching what `tsc` itself does.

It matters most for a self-referential ontology namespace import
(`import * as _this from './vocab.js'`), which is exactly the shape the
framework's own ontology files use.
