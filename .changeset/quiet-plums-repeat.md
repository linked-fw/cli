---
'@_linked/cli': minor
---

Stop building CommonJS for packages that do not publish it.

`linked build` ran a second full `tsc` pass, copied assets into `lib/cjs` and
wrote a dual-package marker for every package — including the many that are
`"type": "module"` with an import-only `exports` map, where nothing could ever
resolve that output.

Whether to build CJS is now read from the manifest: a package opts in by
pointing `main` at a CJS build or declaring a `require` condition in `exports`.
Packages that publish CJS are unaffected; the rest build faster and stop
shipping a `lib/cjs` no consumer can reach.

`packagePublishesCjs` is exported from `@_linked/cli/package-manifest` for
tooling that needs the same answer.
