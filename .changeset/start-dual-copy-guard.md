---
"@_linked/cli": minor
---

`linked start` warns when Node loads a file of a `@_linked/*` package the Vite SSR runner bundles, which leaves the app with two copies of that module (classes fail `instanceof`, module state exists twice). It prints one status line per boot (`[linked] dual-copy guard: on`, or `off` with the reason) and one `[linked] TWO COPIES: Node loaded <package>/<file> (imported as "<specifier>" from <importer>) …` line per file, once per process. Files in `node_modules` and in localized checkouts or workspaces (matched by their `package.json` name) both count; `@_linked/cli` is never reported. It only warns. `LINKED_DUAL_COPY_GUARD=0` turns it off; on a Node without `module.registerHooks` (before 22.15 / 23.5) it is off and says so.
