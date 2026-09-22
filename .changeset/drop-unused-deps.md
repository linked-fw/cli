---
'@_linked/cli': patch
---

Drop four declared-but-unused dependencies: `child-process-promise`, `css-parse`, `postcss-comment` and `postcss-strip-inline-comments`.

None of them is referenced anywhere outside `package.json`. The only trace of
any is a commented-out `// import parseCSS from 'css-parse';` at the top of
`src/loaders/css-loader.mts`.

They are worth removing rather than leaving because this package is a runtime
dependency of `@_linked/server`, not just a build tool: `lib/esm/cli.js`
statically imports `cli-methods.js`, so the whole dependency graph is loaded in
the serving process. Carrying advisories for code nothing calls is pure cost to
every consumer.

Together they account for 7 advisories — `cross-spawn` (ReDoS) via
`child-process-promise`, six `postcss` 5/6 advisories via the two postcss
wrappers, and `decode-uri-component` via `css-parse` → `css` →
`source-map-resolve`. None of the removed packages is the *current* postcss:
the real one is 8.5.28 and is unaffected.

Typecheck clean, `test:unit` 303/303, build clean, and the audit total drops
from 27 to 20 in this repo.
