---
summary: >
  An app worktree made with `linked worktree add ct --with @_linked/core` loads core from the
  worktree's checkout, while installed `@_linked/*` packages still resolve the main checkout's
  core. The app runs two copies, and `typecheck:gate` reports 118 errors between the two `IDataset`
  types, although both `lib` .d.ts trees are identical. May overlap backlog 013 ("Refusing a
  second copy").
source: an app master (step ct), 30 Oct 2026
status: open
---

# 017 — The worktree link farm loads two core copies

## Observed

An app worktree `wt/ct`, made with `npx linked worktree add ct --with @_linked/core`, during
`npm run test:regular` (log: `ct-regular.log` in the master's scratchpad):

```
[app-err] [localize] drift: second copy of localized @_linked/core@2.45.0 at node_modules/@_linked/core
[app-err] [linked] @_linked/core is installed 2 times (2.45.0 at <main>/packages-local/_linked-core, 2.45.0 at /Users/rene/web/wt/ct/packages-local/_linked-core); loaded /Users/rene/web/wt/ct/packages-local/_linked-core.
```

`typecheck:gate` then failed:

```
NEW type error(s) not in the baseline: 118
  src/backend/people/displayNames.ts: TS2345: Argument of type 'import("/Users/rene/web/wt/ct/packages-local/_linked-core/lib/esm/interfaces/IDataset").IDataset' is not assignable to parameter of type 'import("<main>/packages-local/_linked-core/lib/esm/interfaces/IDataset").…
  src/backend/shapes/BranchProvider.ts: TS2416: Property 'shape' in type 'BranchProvider' is not assignable to the same property in base type 'ShapeProvider'.
  src/backend/shapes/OntologyTermSearchProvider.ts: TS2322: Type 'FusekiStore' is not assignable to type 'IDataset'.
```

The two `lib` .d.ts trees were identical, so the errors come from type identity (two module
paths), not from a change in core.

## Likely cause (unverified)

The farm links `@_linked/core` to the worktree's checkout, but the other installed `@_linked/*`
packages (`server-utils`, `server`, …) are links to their real paths in the main checkout's
`node_modules`. Node and `tsc` resolve their own `import '@_linked/core'` from that real path, so
they climb to `<main>/node_modules/@_linked/core`, the main checkout's core. Every package
that depends on a `--with` package, and is not itself in the worktree, keeps the main copy.

## First questions

- Should the farm also give each dependent installed package its own farm entry (a directory whose
  `node_modules/@_linked/core` points at the worktree's copy), or should `tsc` / Vite / Node be
  told to dedupe (`paths`, `resolve.dedupe`, a loader hook)?
- Or refuse/warn at `worktree add`, as backlog 013 proposes for a master step ("Refusing a second
  copy"), and list the dependents to add with `--with`? If this is the same mechanism, fold one
  item into the other.

## Seen again: master `one-read-method` (core plan 111), 1 Nov 2026

Here the second copy was not a
stale duplicate but an older core: the master changed `IDataset`, and the main checkout's core still
had the old read methods, so the failures looked like real bugs.

- Cause, narrower than above: the packages localized only in the main checkout and not nested in
  the worktree. Seventeen farm entries of the step worktree resolved into the main checkout's
  `packages-local/`: `@_linked/css`, `dcat`, `dcmi`, `icons`, `npm`, `org`, `owl`, `primitives`,
  `rdfs`, `s3`, `schema`, `sentry`, `sioc`, `translation`, `xsd`, `@linked.cm/zoho-cpaas` and
  `@semantu/webid-email`. Their own `import '@_linked/core'` climbs from their real path to
  `<main>/packages-local/_linked-core`.
- tsc: `NEW type error(s) not in the baseline: 63`, all of them `IDataset`/`Transaction`/
  `FusekiStore` identity errors between the two copies. `tsc --explainFiles` named the importers of
  the main copy: `_linked-schema` (3038 imports), `_linked-translation` (200), `_linked-dcmi` (113),
  `_linked-owl` (85), `_linked-dcat` (56). With `paths` mapping `@_linked/core` to the worktree's
  copy: 0 errors.
- Runtime: in-process Playwright specs (`named-graphs.spec.ts:320`, `:454`,
  `project-image-dsl.spec.ts:80`, `graph-content-dsl.spec.ts:264`, `hub-ontology-terms-dsl:182`)
  failed with "dispatch.selectQuery is not a function" and "[linked] 2 copies of @_linked/core's
  shape registry have loaded". Their shapes come from the main checkout's `@_linked/schema`/`owl`,
  which call the old core.
- Workaround used: in the step worktree's farm only, each of the 17 links replaced by an `rsync`
  copy of the package (without `.git` and `node_modules`). Typecheck then `No new type errors`, and
  the regular set green. Pitfall met: the farm's `@linked.cm` scope was itself a link into the main
  install, so replacing an entry inside it wrote into the main checkout; the scope must become a
  directory of the farm first.

A fix in `linked worktree add` / `relink`: give every main-only localized package that depends on a
`--with` package a farm entry of its own whose `@_linked/core` resolves to the worktree's copy (or
nest it), and make scope directories real directories of the farm.
