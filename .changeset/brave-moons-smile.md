---
'@_linked/cli': patch
---

Keep class names through minification.

A shape's IRI is built from its class name —
`getNodeShapeUri(packageName, constructor.name)` — so a minifier that renames
the class changes the shape's identity. In a production build the client asked
the server for `https://linked.cm/shape/server/za` while the server had
registered `.../BackendAPIStore`, so every `Server.call` on that shape 501'd,
and registration reported `Shape undefined does not extend base class`.

`esbuild.keepNames` fixes the mangling. Note it does not fix a *collision*: a
shape class and its `targetClass` ontology term deliberately share a name, and
when both land in one chunk the class still gets a numeric suffix. Identity not
derived from `constructor.name` is the durable answer.
