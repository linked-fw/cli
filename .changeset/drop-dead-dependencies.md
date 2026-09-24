---
'@_linked/cli': patch
---

Drop ten declared-but-unreferenced dependencies.

None of them appears anywhere in `src/`, `tests/`, `defaults/`, any config file, or
any npm script — only in their own `dependencies` entry:

`@babel/cli`, `chokidar`, `cssnano`, `license-info-webpack-plugin`, `node-hook`,
`postcss-font-magician`, `postcss-modules`, `postcss-reporter`, `terminal-kit`,
`webpack-typings-for-css`.

**`webpack-typings-for-css` is the notable one.** It was the only thing in the tree
depending on `path` — the *browser shim* for Node's `path` module, which has no
business in a CLI and shadows the builtin for anything that resolves it by bare
specifier. That entry is gone from the lockfile with it.

The webpack dependencies that are still *used* are untouched. The webpack build path
is live — `cli-methods.ts` dynamically imports `config-webpack-app.js`, `index.ts`
imports `generateWebpackConfig`, and `build-app` still reports "this app still builds
with webpack" — so `webpack` itself and its loaders/plugins stay.

`copyfiles` also looked unreferenced by source but is used by the `copy-to-lib`
script, so it stays too. (It is arguably a devDependency rather than a dependency,
but that is a separate question.)
