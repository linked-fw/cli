---
date: 2026-10-21
summary: >
  A package's Turtle ontology data ships with it: `linked build` copies `src/**/*.ttl` into
  `lib/esm/` (and `lib/cjs/` when CommonJS is published), and `linked build-app` copies the app's
  own `src/**/*.ttl` into `lib/` beside the compiled backend (`copyBackendOntologyData`; a failed
  copy fails the build). Measured in every mode an app runs in (release backend, dev SSR standalone
  and workspace, client build, tarball): each module reads the Turtle beside its own file through
  `import.meta.url`. New ontology packages are scaffolded in Turtle (`src/data/<name>.ttl`,
  `loadData` through core's `loadOntologyFiles`), which also changes Create Now's generated project
  packages. The CLI e2e runs its Fuseki on the inferring image with a `tdb2` dataset and asserts
  the dataset infers. Part of CN plan 070 (sub-plan 001, step L1).
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

## The scaffold in Turtle

`create-package --kind ontology` (through `buildPackageFiles`) and `create-ontology` write:

- `src/data/<name>.ttl`, replacing `<name>.json` and `<name>.json.d.ts`: a fixed prefix block
  (`dc`, `owl`, `rdf`, `rdfs` and the ontology's own prefix, as the JSON-LD context had) and
  `<namespace> a owl:Ontology .`, no blank nodes;
- `src/ontologies/<name>.ts`: `export var loadData = () => loadOntologyFiles(import.meta.url,
  ['../data/<name>.ttl']);` (`@_linked/core/ontology/loadOntologyFiles`);
- `src/ontologies/<name>.register.ts`: `linkedOntology(terms, ns, '<name>', loadData,
  ['../data/<name>.ttl']);`, the master plan's contract form. Core's `docs/ontologies.md` shows
  the same call with an exported `dataFiles` constant; the scaffold keeps the literal list so the
  ontology module exports nothing but terms, `ns` and `loadData`.

Create Now builds its project packages through `buildPackageFiles`, so they change with it; its
`appProjectPackages.test.ts` now expects the `.ttl` file and the array form, and arch-03's package
tree names `data/<name>.ttl`.

**Verify** (tmp dir, worktree CLI as `$LINKED`; core packed from `store-inference` 944b6d0):

```
$ $LINKED create-package probe --kind ontology
create exit 1   (expected: npm's core has no ontology/loadOntologyFiles yet)
TS2307: Cannot find module '@_linked/core/ontology/loadOntologyFiles' …
$ npm install <tmp>/_linked-core-2.36.4.tgz
$ (cd probe-ont && time $LINKED build)
✔ Build successful        build exit 0, 1.93 s
$ ls lib/esm/data
probe.ttl
$ npm pack --dry-run | grep data/
npm notice 311B lib/esm/data/probe.ttl
```

The built package registers and reads its data through core (importing `lib/esm/index.js`, then
`getRegisteredOntologies()` and the entry's `load()`):

```
{"prefix":"probe","files":["../data/probe.ttl"],"loaded":[311]}
```

Gate after the phase:

```
$ time npx linked build
✔ Build successful        9.34 s
$ time npx jest --config jest.config.cjs <the Verify line> tests/unit/ontologyDataReachable.test.ts
Test Suites: 8 passed, 8 total
Tests:       130 passed, 130 total        4.92 s
$ time npm run test:unit
Test Suites: 80 passed, 80 total
Tests:       870 passed, 870 total        21.8 s
CN (~/web/wt/070-L1): $ time npx vitest run src/backend/provisioners/appProjectPackages.test.ts
Test Files  1 passed (1)
Tests  25 passed | 1 skipped (26)        5.37 s
```

New and changed cases: `createPackageScaffold.test.ts` and `packageFiles.test.ts` (file list holds
`src/data/planning.ttl` and no `.json`, the register line, the `loadOntologyFiles` call, the
`owl:Ontology` line), `createInsidePackage.test.ts` (`create-ontology` in a package writes the three
files, fills every variable and adds the register import).

## The CLI e2e on the inferring image

`tests/e2e/create-app.spec.ts` starts its testcontainer from `FUSEKI_IMAGE` (default
`linked-fuseki:dev`, the image built from linked-fw/fuseki's `server/`; it was `stain/jena-fuseki`)
on a random host port, creates the app's dataset with `dbType=tdb2` (a `mem` dataset gets the plain
template and would not infer) and adds a test before the Person round-trip: insert
`<urn:linked-e2e:A> rdfs:subClassOf <urn:linked-e2e:B> . <urn:linked-e2e:a> a <urn:linked-e2e:A>`
through `/<ds>/update`, `ASK { <urn:linked-e2e:a> a <urn:linked-e2e:B> }` is true on `/<ds>/sparql`
and false on `/<ds>/stored`, then delete the triples (the ASK is false again). Fuseki 6 answers a
successful update with 204, so the check is `r.ok`.

The app is still cloned from app-template's GitHub `main` and installed from npm, so this spec
cannot show a template app reading its own Turtle; that assertion belongs to T1 and the release.

Verify (fuseki `store-inference` 112f09f):

```
$ time docker build -q -t linked-fuseki:dev ~/web/wt/070/packages-local/_linked-fuseki/server
sha256:93b22495b3ccc8866310597a39c741e53bbb38aa07f775357be1070d86411bc0        8.5 s
$ time npx playwright test --config playwright.config.ts tests/e2e/create-app.spec.ts
  ✓  1 tests/e2e/create-app.spec.ts:120:1 › the dataset infers over its stored rdfs:subClassOf hierarchy (5.2s)
  ✓  2 tests/e2e/create-app.spec.ts:154:1 › Person fixture: add → edit → delete round-trip (15.0s)
  2 passed (1.8m)        1:49.9 total
```

Full gate (cli worktree built with the integration CLI):

```
$ time npm run test:unit
Test Suites: 80 passed, 80 total
Tests:       870 passed, 870 total        51.6 s
$ time npx playwright test --config playwright.config.ts
  6 passed (2.4m)        2:23.8 total     (create-app 2, build-app, dual-copy 3)
```

## Follow-ups

- The scaffold's `@_linked/core` range (`defaults/package/package.json`, `^2.0`) must reach the
  core release that exports `ontology/loadOntologyFiles`, and `tests/template/package.full.test.ts`
  (installs from npm) passes only then: sub-plan 001, Release (R).
- `tests/e2e/create-app.spec.ts` on the inferring Fuseki image: sub-plan 001, L1 phase 3.
- The e2e's default image becomes the published `ghcr.io/linked-fw/fuseki:6.2.0-1` once F1's image
  is released: sub-plan 001, Release (R).
