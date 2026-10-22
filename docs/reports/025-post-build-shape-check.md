---
date: 2026-10-21
summary: >
  `linked build` checks the package's shapes against the class hierarchy after compiling
  (**Checking shape hierarchy**): one child `node` loads the built package's `package.js` and
  `shapes/index.js`, registers the ontology data of the package and its linked dependencies through
  core's `registerInstalledOntologies`, and runs `checkShapeHierarchy({dependencies})`. Every finding
  is printed; an `error` fails the build; `--skip-shape-check "<reason>"` skips it. The build's
  dependency check no longer drops the last missing entry when `react` is not missing. All thirteen
  framework packages of CN plan 070 build clean with it. Part of CN plan 070 (sub-plan 001, step L2).
---

# 025 — The post-build shape check

## Why

Under CN plan 070 the store infers `rdf:type` through `rdfs:subClassOf` and SHACL targeting
follows it, so shape `extends` and the class hierarchy must agree (plan decisions 13-16). Core's
`checkShapeHierarchy` (`@_linked/core/shapes/checkShapeHierarchy`) reports where they do not. An
app only logs its findings; a published package must be clean, so `linked build` fails on its
errors.

## What changed

- **Build step 'Checking shape hierarchy'** (`src/utils/shapeHierarchy.ts`, in `planBuildSteps`
  right after 'Checking shapes/index'). In one child `node` (cwd the package, the shape-reference
  check's asset hook registered) it imports `lib/esm/package.js` and `lib/esm/shapes/index.js`
  (every shape module when there is no index), then calls core's
  `registerInstalledOntologies(packageDirs)` with the package's directory and each linked
  dependency's, then `checkShapeHierarchy({dependencies})`. Dependencies are `dependencies` +
  `peerDependencies`, followed transitively, each resolved from the package that depends on it by
  Node's `node_modules` walk (a package's export map need not expose `package.json`) and passed by
  real path. `dependencies` maps the package and each dependency visited to its direct names, which
  sets direction I's error scope.
- **Result:** no findings passes; warnings only warn (the build passes with warnings); any error
  fails the step. Every finding is printed as `<severity> <kind> <shape>: <message>` under a count.
- **Skips:** a package with no shape modules, or without a `@_linked/core` dependency (and not core
  itself), passes quietly. A core without `shapes/checkShapeHierarchy` or
  `ontology/registerInstalled` (npm's, until the release) warns `skipped: …` and passes.
- **Failures besides findings:** a module that throws while loading fails the step and names it;
  a register module that throws (core only warns) fails it with that warning, since the check would
  otherwise run without that package's data.
- **`linked build --skip-shape-check "<reason>"`:** the step warns `skipped: <reason>` and does
  not run. `buildPackage` gained an options argument that it passes to `planBuildSteps`.
- **`depCheck`** (`src/cli-methods.ts`): `missing.splice(missing.indexOf('react'), 1)` removed the
  last entry when `react` was not missing; it now filters `react` out.

**Reuse of the shape-reference run:** not reused. `inspectShapeReferences` loads each shape module
alone, one child per module, by design; this check needs everything registered in one process. It
shares the child pattern, the asset hook (now exported) and `findShapeModules`.

## Deviations from the sub-plan

- Dependencies are followed when their name is `@_linked/*` **or** their `package.json` has
  `linkedPackage: true`: an app or CN package that depends on another linked package needs that
  package's data as much as a framework one's.
- The first implementation imported the register modules itself; the master's contract addition
  (§Installed packages' ontologies, CN 7f5267e55) moved that into core, and the check calls
  `registerInstalledOntologies` (core c3a5ef4) instead.

## Tests

`tests/unit/shapeHierarchy.test.ts`, compiled fixture packages in tmp dirs checked by a real child
against the repository's core: a clean package passes; one fixture per kind
(`extends-without-subclass`, `subclass-without-extends`, `borrowed-target-class` and its
`sharedTargetClass` exemption, `mirror-undefined-term`, `override-not-tightened` as a warning that
lets the build pass); a dependency's Turtle backs an `extends` only when its register module is
loaded; a superclass shape in a dependency is an error, outside the dependencies a warning; skips
(no shapes, no core dependency, a core without the check, `--skip-shape-check`); a throwing
module and a throwing register module fail the step. `tests/unit/depCheck.test.ts`: a package
importing `n3` and not `react` gets `n3` in the warning (failed before the fix: `Received:
"boolean"`); `react` alone passes. `esmSpecifiers.test.ts` lists the new step.

## Gate

| Command | Result |
|---|---|
| `npx linked build` (cli worktree) | `✔ Build successful with warnings` (the `rollup` warning below), real 12.52 s |
| `npx jest --config jest.config.cjs tests/unit/shapeHierarchy.test.ts tests/unit/depCheck.test.ts tests/unit/esmSpecifiers.test.ts tests/unit/shapeReferences.test.ts tests/unit/shapesIndex.test.ts` | `Test Suites: 5 passed, 5 total` / `Tests: 111 passed, 111 total`, real 14.53 s |
| `npm run test:unit` | `Test Suites: 82 passed, 82 total` / `Tests: 890 passed, 890 total`, real 65.76 s |

## Verify

Each package built in its `~/web/wt/070/packages-local/<dir>` integration copy with this branch's
CLI (`node ~/web/wt/070-L2/packages-local/_linked-cli/lib/esm/launch.js build`), core on c3a5ef4:

```
core c3a5ef4: exit 0, 10s, ✔ Checking shape hierarchy, ✔ Build successful, git status: 0 changed
xsd dc79ab3: exit 0, 4s, ✔ Checking shape hierarchy, ✔ Build successful, git status: 0 changed
rdfs 3d46494: exit 0, 3s, ✔ Checking shape hierarchy, ✔ Build successful, git status: 0 changed
owl a5f2c09: exit 0, 4s, ✔ Checking shape hierarchy, ✔ Build successful, git status: 0 changed
dcmi 7c587c0: exit 0, 3s, ✔ Checking shape hierarchy, ✔ Build successful with warnings, git status: 0 changed
sioc 460a0e2: exit 0, 4s, ✔ Checking shape hierarchy, ✔ Build successful, git status: 0 changed
schema 57fc01d: exit 0, 6s, ✔ Checking shape hierarchy, ✔ Build successful with warnings, git status: 0 changed
dcat e96407f: exit 0, 4s, ✔ Checking shape hierarchy, ✔ Build successful, git status: 0 changed
org faac046: exit 0, 4s, ✔ Checking shape hierarchy, ✔ Build successful, git status: 0 changed
auth 28ab729: exit 0, 9s, ✔ Checking shape hierarchy, ✔ Build successful with warnings, git status: 0 changed
fuseki 112f09f: exit 0, 3s, ✔ Checking shape hierarchy, ✔ Build successful, git status: 0 changed
server-utils 0105592: exit 0, 4s, ✔ Checking shape hierarchy, ✔ Build successful with warnings, git status: 0 changed
server 639fb2f: exit 0, 10s, ✔ Checking shape hierarchy, ✔ Build successful, git status: 0 changed
```

The check ran (it did not skip quietly) for each; for example, `runShapeHierarchyCheck` directly:

```
core dirs 1 expect [] {"findings":[]}
schema dirs 7 expect ["@_linked/schema","@_linked/primitives","@_linked/server-utils","@_linked/xsd"] {"findings":[]}
org dirs 8 expect ["@_linked/org","@_linked/schema","@_linked/primitives","@_linked/server-utils","@_linked/xsd"] {"findings":[]}
server dirs 4 expect ["@_linked/server","@_linked/server-utils"] {"findings":[]}
```

The "with warnings" builds are the dependency check, and each lists the one entry the old
`splice` dropped: dcmi `@types/react`, schema `@types/node`, auth `cookie`, server-utils
`react-dom`; the cli's own build lists `rollup` (a type import in
`tests/unit/pinCompiledClassNames.test.ts`). They were always missing, and are warnings only.

## Follow-ups

- The five newly visible missing dependencies above belong to their packages; each is a warning
  and does not block. Recorded here for the release step (R), where each repository's PR can
  declare them.
- `defaults/package/package.json`'s `@_linked/core` range is raised at R (sub-plan 001 Progress),
  after which a scaffolded package runs the check instead of warning `skipped`.
