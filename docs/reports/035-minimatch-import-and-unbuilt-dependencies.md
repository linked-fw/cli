---
date: 2026-10-27
summary: >
  `minimatch` is read through a namespace import (`src/utils/minimatch.ts`), so `linked build` loads
  when the install resolves a CommonJS 3.x copy; the shape hierarchy check loads a linked
  dependency's `src/ontologies/*.register.ts` through the cli's TS loader when its `lib/` has no
  register modules, so building packages out of order no longer gives a false
  `extends-without-subclass`. Backlog 005 removed, 009 trimmed. Patch.
---

# 035 — `minimatch` from any copy; the shape check loads unbuilt dependencies

## PR

### Summary

Two `linked build` failures. A fresh scaffold whose install resolved a CommonJS `minimatch` (3.x is
hoisted at a react-native scaffold's root) died with a `SyntaxError` before compiling anything,
because `import {minimatch} from 'minimatch'` is checked at link time. And the post-build shape
check registered a linked dependency's ontology data only from its `lib/`, so a dependency not
built yet contributed no `rdfs:subClassOf` and a shape extending its shape was reported
`extends-without-subclass`.

### Changes

- `src/utils/minimatch.ts` (new): `minimatch` from a namespace import, taking the named export
  (9.x, 10.x) or the CommonJS module itself (`default`, 3.x; `default.minimatch` otherwise).
  `src/utils/shapesIndex.ts` and `src/workspace-globs.ts` import it instead of `minimatch`.
- `src/utils/shapeHierarchy.ts`: `collectShapeCheckInputs` finds the dependencies with register
  modules only in `src/ontologies/*.register.ts`; for them it sets `tsLoader` (the cli's
  `loaders/ts-loader.mjs`) and expects them registered. The check's child registers that loader
  and passes core's `registerInstalledOntologies` an `importModule`, which core uses for a
  package whose `lib/` has no register modules.
- `tests/unit/shapeHierarchy.test.ts`: a dependency with its ontology only in `src/` (TypeScript)
  backs the package's `extends`.

### Verification

Reproduction of 005 before the fix, in a scaffold made with `create-app --template react-native`
(cli 1.57.2 installed, this repo's `lib` and `hooks` copied over it, its nested
`minimatch@9.0.9` moved aside so the root `minimatch@3.1.5` resolves), `linked build` in
`packages/demo-shapes`:

```
.../node_modules/@_linked/cli/lib/esm/utils/shapesIndex.js:12
import { minimatch } from 'minimatch';
         ^^^^^^^^^
SyntaxError: The requested module 'minimatch' does not provide an export named 'minimatch'
```

After, the same scaffold, root 3.1.5 only and then with the nested 9.0.9 back:

```
--- root minimatch 3.1.5 only:
✔ Checking dependencies
✔ Build successful
--- nested minimatch 9.0.9:
✔ Checking dependencies
✔ Build successful
```

The resolution, against each copy in that install: `3.1.5 function true`, `7.4.9 function true`,
`9.0.9 function true`, `10.2.6 function true`.

`npm run test:template -- -t react-native` (the test the backlog item names), before and after:

```
Tests:       10 passed, 10 total
```

It passed before the fix too: today the published cli's own `minimatch@9` is nested under it in a
fresh scaffold, so the test only fails when the cli resolves the hoisted root copy (as with the
1.33.2 the backlog item measured). The scaffold reproduction above is the check that fails.

Reproduction of 009 before the fix (the new test, run against the old `shapeHierarchy.ts`):

```
+   Object {
+     "iri": "http://example.org/fx#Hound",
+     "kind": "extends-without-subclass",
...
```

After: `shapeHierarchy.test.ts` 18 passed. Unit suite:

```
Test Suites: 97 passed, 97 total
Tests:       1127 passed, 1127 total
```

`linked build` of the cli: `✔ Build successful` (every check step green). `tsc --noEmit`: clean.

CN `npm run test:regular` in a CN worktree whose `node_modules/@_linked/cli` links this cli at
`0e228d8` (`CN_TEST_PORT=4166`, under the shared lock), timed 104 s: **red, and not from this change**.

```
 Test Files  5 failed | 328 passed (333)
      Tests  4 failed | 3051 passed | 6 skipped (3061)
...
Error: Invalid override for PackageOntology.preferredPrefix: the path http://purl.org/vocab/vann/preferredNamespacePrefix is already declared as the inherited property 'preferredNamespacePrefix'; redeclare it under that label.
...
  1 failed
    [setup] › tests/auth.setup.ts:13:1 › authenticate via dev iframe
  364 did not run

test:regular
  typecheck:gate                                   PASS   14s
  unit (vitest)                                    FAIL   42s
  packages                                         PASS    8s
  playwright (integration + sign-in e2e)           FAIL   40s
  total                                            FAIL  104s
```

Every failure is that one error, thrown at shape registration: `@_linked/owl` `6a2669d` (ontology
metadata accessors, landed on `dev` the same evening) declares `preferredNamespacePrefix` on
`Ontology`, and CN's `src/shapes/ontologies/PackageOntology.ts` still declares the same path as
`preferredPrefix`. The CN backend does not boot, so sign-in setup fails and nothing else runs. No
cli code is on that path. An earlier quote of a green run in this report was another session's log
written to the same file name; it is withdrawn.

### Deviations

- The step asked for a default `minimatch` import. `minimatch@9`'s ESM build has no default export,
  so a default import fails with the cli's own declared range. A namespace import works with every
  copy (3.x, 7.x, 9.x, 10.x). `src/workspace-globs.ts` had the same named import and is in the same
  load graph, so it uses the helper too.
- The source fallback covers a dependency whose `lib/` has no register modules (core falls back per
  package). A partly stale `lib/` is left, in backlog 009.

### Follow-ups

- Backlog 009 (trimmed): a partly stale `lib/` (fix in core, per module), and a warning when a
  linked dependency registers nothing.

## Details

- The TS loader is registered in the check's child only when a dependency needs it, and only after
  the package's own modules are imported, so the usual path is unchanged.
- Run from `src/` (Jest), the check finds the loader in the package's built `lib/esm/loaders/`;
  without a build it does not load source register modules (as before).
- A dependency loaded from `src/` registers through its `src/package.ts`; registration is keyed by
  package and prefix, so it is the same registration an app makes.
