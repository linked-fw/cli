---
summary: >
  In a worktree made by `linked worktree add --with <pkg>`, Vite loads the worktree's copy of
  `<pkg>` but `tsc` (and an app's typecheck gate) resolves it to the main checkout's `lib/`, so a
  change that alters a framework package's types fails the app's typecheck until it lands.
status: Open -- found in Create Now plan 080 step S1 (dcat report 002); not fixed
---

# 010 — Typecheck in a worktree reads the main checkout's packages

## Symptom

`linked worktree add` symlinks the worktree's `node_modules` to the main checkout's. There,
`node_modules/@_linked/<pkg>` is a relative link (`../../packages-local/_linked-<pkg>`) that the
OS resolves from the main checkout's `node_modules`, so it reaches the main checkout's
`packages-local/_linked-<pkg>/lib`. Vite (and `linked doctor resolve`) overlay the worktree's
`--with` packages; `tsc` has no overlay.

Seen in Create Now with `--with @_linked/dcat`, after `DataService.endpointURL` became an object
property. `npm run typecheck:gate` in the worktree, run before landing:

```
NEW type error(s) not in the baseline: 1
  src/backend/shapes/ApplicationProvider.ts: TS2353: Object literal may only specify known properties, and 'id' does not exist in type 'ExpressionNode'.
```

The same tree passes once dcat lands and is rebuilt in the main checkout. `test:regular` runs the
gate first, so in a worktree that set reports FAIL for a change that is correct.

## Workaround used

A `paths` entry for each `--with` package, added temporarily to the app's
`tsconfig.typecheck.json` (not committed). `paths` replaces the inherited map, so the app's own
entries are repeated:

```json
"paths": {
  "react": ["../node_modules/@types/react", "../../../node_modules/@types/react"],
  "@_linked/dcat/*": ["./packages-local/_linked-dcat/lib/esm/*"]
}
```

With it, `tsc --traceResolution` resolves `@_linked/dcat/shapes/DataService` to the worktree's
`lib/esm/shapes/DataService.d.ts`, and the gate prints `No new type errors.`

## Open questions

1. Where does `linked worktree add` put the overlay so `tsc` and the app's gate pick it up
   without editing a committed tsconfig: a generated, git-ignored tsconfig that the app's
   typecheck config extends when present, or a `paths` block merged into the existing one (which
   must keep the app's own `paths`, since `paths` does not merge across `extends`)?
