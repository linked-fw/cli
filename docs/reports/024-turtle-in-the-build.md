---
date: 2026-10-21
summary: >
  A package's Turtle ontology data ships with it: `linked build` copies `src/**/*.ttl` into
  `lib/esm/` (and `lib/cjs/` when CommonJS is published), and `linked build-app` copies the app's
  own `src/**/*.ttl` into `lib/` beside the compiled backend (`copyBackendOntologyData`; a failed
  copy fails the build). Measured in every mode an app runs in (release backend, dev SSR standalone
  and workspace, client build, tarball): each module reads the Turtle beside its own file through
  `import.meta.url`. Part of CN plan 070 (sub-plan 001, step L1); the scaffold in Turtle and the
  e2e on the inferring Fuseki image follow.
---

# 024 — Turtle in the build

## Why

Under CN plan 070 a package's ontology data becomes Turtle, `src/data/<file>.ttl`, read at runtime
by `@_linked/core/ontology/loadOntologyFiles(import.meta.url, ['../data/<file>.ttl'])` relative to
the compiled module. That only works if the file sits at the same relative path in every place the
module runs from.

## What changed

- **Package build** (`planBuildSteps`, 'Copying files to lib folder'): the asset glob
  `**/*.{json,d.ts,css,scss}` gains `ttl`. `src/data/x.ttl` → `lib/esm/data/x.ttl`, mirrored into
  `lib/cjs/` only when the package publishes CJS. `fs.copy` keeps fresh mtimes, so
  `removeOldFiles` leaves the copies alone.
- **App backend build** (`buildBackend`, used by `build-app`): a new step after the CSS copy,
  `copyBackendOntologyData(appRoot, lister)` in `src/app-release/build-backend.ts`, copies
  `src/**/*.ttl` to `lib/` at the same relative paths (the backend is compiled with
  `preserveModules` rooted at `src`, so `src/ontologies/x.ts` → `lib/ontologies/x.js` reads
  `lib/data/x.ttl`). Unlike the CSS copy, a failure fails the build.
- **Installed and workspace packages:** no change. The release backend build already keeps every
  `@_linked/*` and workspace package external (`assertNoInlinedWorkspaces`), so they read their own
  `lib/esm/data/`.
- README build section; minor changeset `.changeset/turtle-in-the-build.md`.

## Measurements (M1-M5 of sub-plan 001)

The fixture is `tests/fixtures/ontology-app/`: an app whose `src/ontologies/probe.ts` reads
`../data/probe.ttl` through a stand-in for `loadOntologyFiles` (`src/loadFiles.ts`), a fake
installed `@_linked/probe-ont` (`lib/esm/ontologies/p.js` + `lib/esm/data/p.ttl`) and a workspace
package `ws-ont` (`src/ontologies/w.ts` + `src/data/w.ttl`). `measure.mjs` runs one mode on a copy
of it, against the CLI's built `lib/esm`, and prints JSON; `tests/unit/ontologyDataReachable.test.ts`
asserts M1-M4 on it. Manual runs below (tmp prefix shortened to `<tmp>`).

**M1, M2 — release backend** (`buildBackendWithVite` + `copyBackendOntologyData`):

```
copied: 1   probeJsImportMetaUrl: 2
libFiles: ["backend.js","data","data/probe.ttl","loadFiles.js","ontologies","ontologies/probe.js"]
app.url: file://<tmp>/rel/lib/ontologies/probe.js
pkg.url: file://<tmp>/rel/node_modules/@_linked/probe-ont/lib/esm/ontologies/p.js
```

```
$ node -e "import('<tmp>/rel/lib/ontologies/probe.js').then(m=>m.loadData()).then(t=>console.log(t[0].length))"
234
$ wc -c src/data/probe.ttl
     234 src/data/probe.ttl
$ grep -c 'import.meta.url' lib/ontologies/probe.js
2
```

`lib/` holds no `probe-ont` copy (the build passed `assertNoInlinedWorkspaces`); the installed
package's `loadData`, called from the compiled `lib/backend.js`, returned its 96-byte `p.ttl`.

**M3 — dev SSR** (`createServer` with the fixture's `createViteConfig`, `ssrLoadModule`):

```
standalone  app: {"len":234,"url":"file://<tmp>/dev/src/ontologies/probe.ts"}
            pkg: {"len":96,"url":"file://<tmp>/dev/node_modules/@_linked/probe-ont/lib/esm/ontologies/p.js"}
workspace   app: {"len":234,"url":"file://<tmp>/ws/src/ontologies/probe.ts"}
            pkg: {"len":96,"url":"file://<tmp>/ws/node_modules/@_linked/probe-ont/lib/esm/ontologies/p.js"}
            ws:  {"len":96,"url":"file://<tmp>/ws/packages/ws-ont/src/ontologies/w.ts"}
```

Vite's SSR transform leaves each module its real file URL, so no `vite-config.ts` change is needed.

**M4 — client build** (`vite build` with the client entry importing both register modules): exit 0,
no `.ttl` content in `public/bundles` (`ttlContent: []`), warnings exactly:

```
[plugin vite:resolve] Module "node:fs/promises" has been externalized for browser compatibility, imported by "<tmp>/client/node_modules/@_linked/probe-ont/lib/esm/ontologies/p.js". …
[plugin vite:resolve] Module "node:fs/promises" has been externalized for browser compatibility, imported by "<tmp>/client/src/loadFiles.ts". …
Generated an empty chunk: "__vite-browser-external".
```

The loader's dynamic `import('node:fs/promises')` is never called in the browser; Vite notes the
externalized builtin once per importing module.

**M5 — the tarball** (a minimal package with `src/index.ts` and `src/data/x.ttl`, built with the
worktree's CLI, `node <cli>/lib/esm/launch.js build`):

```
exit 0
✔ Build successful
$ npm pack --dry-run
npm notice Tarball Contents
npm notice 96B lib/esm/data/x.ttl
npm notice 28B lib/esm/index.d.ts
npm notice 20B lib/esm/index.js
npm notice total files: 4
```

M1-M5 confirm the master plan's contract text (§Ontology data files and loader) as written.

## Gate

Quick gate after the phase (cli worktree):

```
$ time npx linked build
✔ Build successful
npx linked build  10.91s user 1.40s system 172% cpu 7.138 total

$ time npx jest --config jest.config.cjs tests/unit/copyAssetsStep.test.ts tests/unit/buildBackend.test.ts \
    tests/unit/esmSpecifiers.test.ts tests/unit/createPackageScaffold.test.ts tests/unit/createInsidePackage.test.ts \
    tests/unit/packageFiles.test.ts tests/unit/ssrExternal.test.ts tests/unit/ontologyDataReachable.test.ts
Test Suites: 8 passed, 8 total
Tests:       129 passed, 129 total
Time:        18.482 s
… 23.474 total
```

New cases: `copyAssetsStep.test.ts` (`.ttl` lands in `lib/esm/data/`, and in `lib/cjs/data/` when
CJS is published), `buildBackend.test.ts` (`copyBackendOntologyData`: same relative paths, Turtle
only, nothing for an app without Turtle, fails on a copy error), `ontologyDataReachable.test.ts`
(M1-M4, needs the built CLI; CI builds before it tests).

## Follow-ups

- The ontology scaffold in Turtle (`create-ontology`, `create-package --kind ontology`,
  `buildPackageFiles`) and CN's `appProjectPackages.test.ts` line: sub-plan 001, L1 phase 2
  (after core's `loadOntologyFiles`).
- `tests/e2e/create-app.spec.ts` on the inferring Fuseki image: sub-plan 001, L1 phase 3.
