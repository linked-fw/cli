---
'@_linked/cli': minor
---

Honour negated `workspaces` patterns, the way npm does

`package.json` `workspaces` entries may be negated (`"!packages/core"`) to
exclude a directory from the workspace. npm honours those; three walkers in this
CLI did not, and each hand-rolled the same walk:

- `discoverWorkspaces` (the Vite source resolver, `vite-config.ts`)
- `getLincdPackages` / `checkWorkspaces` (`lifecycle.ts`)
- `discoverWorkspacePackages` (the dev HMR watcher, `commands/start.ts`)

A negation was simply inert, so `packages/*` still matched every directory. In a
monorepo whose `packages/` holds untracked sibling checkouts — excluded from the
workspace precisely so the package manager ignores them — dev resolved those
packages to `packages/<name>/src` instead of the installed copy. Those checkouts
have no dependencies installed, so the dev server failed to boot on a missing
transitive dependency, and unit tests failed to resolve imports.

All three now share one helper, `src/workspace-globs.ts`, which reproduces npm's
semantics (a direct port of `@npmcli/map-workspaces`): `!` prefixes (an even
number is not a negation), a leading `./` or `/` stripped, a later exact pattern
re-including what an earlier negation excluded, and a `/**` negation covering the
directory itself. Exact, non-glob entries are subject to negations too. Positive
patterns are still expanded by directory listing, so only a trailing `/*` is
honoured there — unchanged.

Discovery results change for any app whose `workspaces` field contains
negations; apps without them are unaffected.
