---
date: 2026-10-23
summary: >
  `linked build` writes the package's shapes as Turtle to `lib/esm/data/shapes.ttl` (build step
  **Writing shapes.ttl**, after the shape hierarchy check): one child `node` loads the built
  `package.js` and `shapes/index.js` and calls `packageShapesTurtle(<package name>)` from the core
  the package resolves, so the file is byte-identical to what an app's server generates in process.
  A package without shapes gets no file (a stale one is removed); a core without
  `shapes/shapesToTurtle` warns and writes none. `npm pack --dry-run` lists the file only for a
  package with shapes; two builds give the same bytes; core's file equals its golden (`fbe7639d…`).
  Part of CN plan 071 (step L1).
---

# 026 — `shapes.ttl` in the build

## Plan-mode detail

CN plan 071 §L1 is the sub-plan; §Contracts "Shape graphs" (as landed in core report 052) is the
contract: L1 writes `lib/esm/data/shapes.ttl` with `packageShapesTurtle(pkg)` and no options, so a
built file and the server's in-process generation are the same bytes. Open question 6 (owner,
2026-10-23): a package without shapes gets no file, and nothing falls back.

- **Files.** New `src/utils/shapesTurtle.ts` (inputs, child run, build step); `src/cli-methods.ts`
  (`planBuildSteps` gains **Writing shapes.ttl** right after **Checking shape hierarchy**, so it
  runs on the final `lib/esm` and only for shapes that passed the checks); README §Building;
  `tests/unit/shapesTurtle.test.ts`; `tests/unit/esmSpecifiers.test.ts` (step list).
- **Which core.** The package's own, resolved by the `node_modules` walk the hierarchy check uses
  (`resolvePackageDir`); core itself uses its own `lib`. Not the cli's dependency: the bytes must be
  what that package's core writes, and the cli's core range stays as it is.
- **Which name.** The one the shapes register under (`linkedPackage('<name>')` in `package.js`,
  else `package.json`'s name; core has no such call and is `@_linked/core`), as the sync's
  `packagesWithShapes()` names them.
- **Pitfalls.** `removeOldFiles` deletes `lib` files older than 120 s, so a stale file usually goes,
  but a package that loses its shapes within two minutes of a build would keep one: the step removes
  it itself. A core older than the generator (npm's before R2) must not fail every build: it warns,
  as the hierarchy check does for its module. CN backlog 130 (the SSR shim empties `@_linked/cli/*`
  under Vitest) does not apply: nothing in CN imports this module; CN code that needs the Turtle
  calls core.
- **Tests.** Fixture packages in tmp dirs with a real child against the repository's core: file
  written in core's form, bytes stable across runs, no index, `npm pack --dry-run` with and without
  shapes, no shapes (stale file removed), shape modules registering nothing, no core dependency, an
  old core (warning), a throwing module; core's own output against its golden file.

## What changed

- **Build step 'Writing shapes.ttl'** (`src/utils/shapesTurtle.ts`). `collectShapesTurtleInputs`
  skips quietly with no shape modules (`findShapeModules`) or no `@_linked/core` dependency, and
  skips with a reason when the resolved core has no `lib/esm/shapes/shapesToTurtle.js`.
  `generateShapesTurtle` runs one child `node` (cwd the package, the shape-reference check's asset
  hook registered) that imports `package.js`, then `shapes/index.js` (every shape module without an
  index), then `packageShapesTurtle(name)` from that core, and reports through a marker line.
  `writeShapesTurtleStep` writes the text to `lib/esm/data/shapes.ttl` (`✔ Writing shapes.ttl -
  lib/esm/data/shapes.ttl`), or removes the file when there is no Turtle; a skip with a reason is a
  warning; a load error fails the build and names the module.
- ESM only: the contract names `lib/esm/data/shapes.ttl`; nothing is written to `lib/cjs`.
- README §Building describes the step. Changeset `shapes-ttl-in-the-build.md` (minor, no breaking
  changes).

## Deviations from the plan

None. §L1 says "with core's `shapesToTurtle`"; the call is `packageShapesTurtle(pkg)` as the
contract's as-landed paragraph says (it is `shapesToTurtle(packageShapes(pkg))`).

## Release order (for R2)

The shared publish workflow (`linked-fw/.github/.github/workflows/publish.yml@v1`) builds with the
**latest published cli**. A package's tarball gets `data/shapes.ttl` only when it is released after
this cli is on npm **and** against a core that has `shapes/shapesToTurtle` (the shape-graph core
release). So at R2: core first, then this cli, then every package with shapes re-published (a
minor each), each tarball checked with `curl -s $(npm view <pkg>@<v> dist.tarball) | tar tz | grep
shapes.ttl`. A package built before that ships no file, and V2 gives it no shape graph (no
fallback).

## Gate

Worktree `named-graphs--l1` (`~/web/wt/l1/packages-local/_linked-cli`), core from the main
checkout's `named-graphs` at `200037d` (built; `shapes/shapesToTurtle` not yet on npm). No Fuseki
of my own was needed: the e2e's testcontainer takes a random port.

| Gate | Command | Result |
|---|---|---|
| Quick, phase 1 | `npm run test:unit -- tests/unit/shapesTurtle.test.ts tests/unit/esmSpecifiers.test.ts` | `Test Suites: 2 passed, 2 total` / `Tests: 74 passed, 74 total`, 5.6 s; `tsc -p tsconfig-esm.json --noEmit` clean |
| Full | `npm run build` | exit 0, real 4.27 s |
| Full | `npm run test:unit` | `Test Suites: 89 passed, 89 total` / `Tests: 982 passed, 982 total`, real 87.10 s |
| Full | `FUSEKI_IMAGE=ghcr.io/linked-fw/fuseki:6.2.0-2 npm run test:e2e` | `6 passed (1.8m)`, real 106.51 s (the `fetch failed` lines are `build-app.spec.ts`'s RemoteDataset answering nowhere, by design) |

## Verify

Fixture packages (`tests/unit/shapesTurtle.test.ts`, 10 tests, all passing):

```
✓ a package with shapes gets lib/esm/data/shapes.ttl, in core's fixed form
✓ the same package gives the same bytes on every run
✓ without shapes/index, every shape module is loaded
✓ npm pack lists data/shapes.ttl for a package with shapes and omits it without
✓ a package with no shapes gets no file, and an earlier one is removed
✓ shape modules that register nothing for the package give no file
✓ a package without a @_linked/core dependency is skipped quietly
✓ a core without shapes/shapesToTurtle warns and writes nothing
✓ a shape module that throws fails the step and names it
✓ is byte-identical to core's in-process generation (its golden file)
```

Real packages, built with this cli (`node ~/web/wt/l1/packages-local/_linked-cli/lib/esm/launch.js
build`):

- **`packages/documents`** (CN worktree copy): `✔ Writing shapes.ttl - lib/esm/data/shapes.ttl`,
  `✔ Build successful with warnings` (the existing `@jest/globals`, `ajv` dependency warning),
  22.2 s. 1365 lines, `sha256 1b520bceca8aab2fdccc5a905281218372b78f557b0258eb19fe9e7f3b60812b`;
  a second build gave the same hash, and a separate `node` importing `package.js`,
  `shapes/index.js` and `packageShapesTurtle('@_linked/documents')` from
  `@_linked/core/shapes/shapesToTurtle` printed `in-process 1b520bce…812b`. `npm pack --dry-run`:
  `npm notice 53.2kB lib/esm/data/shapes.ttl`. Head:

  ```
  @prefix core: <https://linked.cm/ont/core/> .
  @prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
  @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
  @prefix sh: <http://www.w3.org/ns/shacl#> .
  @prefix xsd: <http://www.w3.org/2001/XMLSchema#> .

  <https://linked.cm/shape/documents/DocumentFact>
    a sh:NodeShape ;
    sh:property <https://linked.cm/shape/documents/DocumentFact/anchors> ;
    ...
    sh:targetClass <https://linked.cm/ont/documents/DocumentFact> .
  ```

- **core** (a copy of the main checkout's `named-graphs` source, built in place, then deleted):
  every step `✔`, `✔ Writing shapes.ttl - lib/esm/data/shapes.ttl`, `✔ Build successful`, 7.5 s.
  814 lines, `sha256 fbe7639dff18268dff3dc282333c4e16396013bd8daaa0e54f2cd97cd3a1a7f8`, the hash
  core report 052 gives for its golden and for `packageShapesTurtle('@_linked/core')` in process.
  Head: the same prefix block, then `<https://linked.cm/shape/core/DraftGraph>  a sh:NodeShape ;
  rdfs:comment "The registry record of a graph of ontology-editor drafts. …" ; sh:targetClass
  core:DraftGraph ; core:isExtending <https://linked.cm/shape/core/NamedGraph> .`

## Follow-ups

None. One note for the master (core's, not a cli change): `npm pack --dry-run` in core lists
`lib/esm/tests/fixtures/core-shapes.ttl` (27.6 kB) beside `lib/esm/data/shapes.ttl`, because the
copy step copies every `src/**/*.ttl`; R2's `grep '\.ttl'` tarball check will show both.

## Review fixes

- `--skip-shape-check` now skips **Writing shapes.ttl** too. It removes any earlier
  `lib/esm/data/shapes.ttl` and warns `skipped with --skip-shape-check (<reason>): no shapes.ttl written`.
- A failed generation removes the earlier `shapes.ttl` before it fails the step, so a stale file never
  ships. Both cases are tested in `shapesTurtle.test.ts` (the skip through `planBuildSteps`). The
  README, the `--skip-shape-check` help text and the changeset are updated.

Gate (worktree `named-graphs--fixsc`): `npm run build` exit 0, `5.37s user 0.62s system 90% cpu
6.629 total`. `npm run test:unit` → `Test Suites: 89 passed, 89 total` / `Tests: 984 passed, 984
total`, `1:10.05 total`. `FUSEKI_IMAGE=ghcr.io/linked-fw/fuseki:6.2.0-2 npm run test:e2e` →
`6 passed (1.4m)`, `1:22.68 total`.
