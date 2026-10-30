---
summary: >
  A CN worktree made with `linked worktree add ct --with @_linked/core` loads core from the
  worktree's checkout, while installed `@_linked/*` packages still resolve the main checkout's
  core. CN runs two copies, and `typecheck:gate` reports 118 errors between the two `IDataset`
  types, although both `lib` .d.ts trees are identical. May overlap backlog 013 ("Refusing a
  second copy").
source: CN master side-225 (step ct), 30 Oct 2026
status: open
---

# 017 — The worktree link farm loads two core copies

## Observed

A CN worktree `wt/ct`, made with `npx linked worktree add ct --with @_linked/core`, during
`npm run test:regular` (log: `ct-regular.log` in the side-225 master's scratchpad):

```
[CN-err] [localize] drift: second copy of localized @_linked/core@2.45.0 at node_modules/@_linked/core
[CN-err] [linked] @_linked/core is installed 2 times (2.45.0 at /Users/rene/web/create_now/packages-local/_linked-core, 2.45.0 at /Users/rene/web/wt/ct/packages-local/_linked-core); loaded /Users/rene/web/wt/ct/packages-local/_linked-core.
```

`typecheck:gate` then failed:

```
NEW type error(s) not in the baseline: 118
  src/backend/people/displayNames.ts: TS2345: Argument of type 'import("/Users/rene/web/wt/ct/packages-local/_linked-core/lib/esm/interfaces/IDataset").IDataset' is not assignable to parameter of type 'import("/Users/rene/web/create_now/packages-local/_linked-core/lib/esm/interfaces/IDataset").…
  src/backend/shapes/BranchProvider.ts: TS2416: Property 'shape' in type 'BranchProvider' is not assignable to the same property in base type 'ShapeProvider'.
  src/backend/shapes/OntologyTermSearchProvider.ts: TS2322: Type 'FusekiStore' is not assignable to type 'IDataset'.
```

The two `lib` .d.ts trees were identical, so the errors come from type identity (two module
paths), not from a change in core.

## Likely cause (unverified)

The farm links `@_linked/core` to the worktree's checkout, but the other installed `@_linked/*`
packages (`server-utils`, `server`, …) are links to their real paths in the main checkout's
`node_modules`. Node and `tsc` resolve their own `import '@_linked/core'` from that real path, so
they climb to `create_now/node_modules/@_linked/core`, the main checkout's core. Every package
that depends on a `--with` package, and is not itself in the worktree, keeps the main copy.

## First questions

- Should the farm also give each dependent installed package its own farm entry (a directory whose
  `node_modules/@_linked/core` points at the worktree's copy), or should `tsc` / Vite / Node be
  told to dedupe (`paths`, `resolve.dedupe`, a loader hook)?
- Or refuse/warn at `worktree add`, as backlog 013 proposes for a master step ("Refusing a second
  copy"), and list the dependents to add with `--with`? If this is the same mechanism, fold one
  item into the other.
