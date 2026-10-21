---
summary: >
  Sub-plan of CN plan 070 (the store infers; ontology data in every app dataset) for
  `linked-fw/cli`: L1, the package build ships Turtle (`src/**/*.ttl` copied to `lib/esm/`, the app
  backend build copies the app's own `src/**/*.ttl` next to its compiled modules, the ontology
  scaffold in Turtle, the CLI e2e on the inferring Fuseki image); L2 (post-build shape check) is
  detailed when its wave starts. Work lands on `store-inference`.
status: Plan
---

# 001 — Store inference: Turtle in the build

Sub-plan of CN's master plan
[070](https://github.com/Semantu/create-now/blob/store-inference/docs/plans/070-store-inference-and-ontology-data.md)
(local: `~/web/wt/070/docs/plans/070-store-inference-and-ontology-data.md`). The master plan's
§Decisions, §How to use, §Rules and §Contracts govern; this file repeats the contracts this
repository provides or consumes and adds the plan-mode detail (Files, Pitfalls, Tests) of the
cli steps. Step agents start at tasks mode, seed their own plan doc from their section here, and
do not redesign: when the code contradicts this file, stop and report.

Integration branch: `store-inference` (worktree `~/web/wt/070/packages-local/_linked-cli`).
Records: L1 → report 024, L2 → report 025. Every step adds a **minor**
changeset (`npx changeset`) at landing.

**Shared files.** L1 runs in wave 1; L2 runs in wave 4. Plan 067's commands (G1) left this plan on
2026-10-21: another agent runs plan 067; the work started here is on the pushed branch
`store-inference--G1` (tip 7e68bea, P0-P6 committed, not landed).

| File | L1 | L2 |
|---|---|---|
| `src/cli-methods.ts` | copy step in `planBuildSteps` (3165-3198), `createOntology` (1396-1483), `buildBackend` (2200-2241) | `planBuildSteps` (a new step after 'Checking shapes/index', ~3290) |
| `src/app-release/build-backend.ts` | a Turtle copy next to `copyBackendStylesheets` (525-540) | — |
| `src/cli.ts` | — | `--skip-shape-check` on `build` (349) |
| `src/vite-config.ts` | only if the dev-SSR measurement fails (see L1 Pitfalls) | — |
| `README.md`, `CHANGELOG` | build section | build section |

Each step rebases onto `store-inference` before landing (master §How to use, 2).

## Contracts

Verbatim from the master plan's §Contracts; the master plan holds the rest
(`@_linked/fuseki`, hierarchy reader, ontology sync, control route, tighten-only, validate by
class, bulk access, graph rule). A step that changes one of these updates both copies in its
landing.

### The image (provider F1; consumers C1, W1, W2, T1, K1's test store, L1's e2e)

- `ghcr.io/linked-fw/fuseki:<jena>-<n>` (first: `6.2.0-1`), `FROM secoresearch/fuseki:6.2.0`;
  until the release, built locally from `linked-fw/fuseki`'s `server/Dockerfile` (compose
  `build:` pointing at `~/web/wt/070/packages-local/_linked-fuseki/server`, tag
  `linked-fuseki:dev`). Same env as the base image (`ADMIN_PASSWORD`, `ENABLE_DATA_WRITE`,
  `ENABLE_UPDATE`, `ENABLE_SHACL`, `QUERY_TIMEOUT`), `FUSEKI_BASE=/fuseki-base`, uid 9008.
- Dataset type `lf:DatasetRDFSLive` (`PREFIX lf: <https://linked.cm/ont/fuseki#>`), declared in an
  assembler as:
  ```turtle
  :ds a lf:DatasetRDFSLive ; ja:dataset :tdb .
  :tdb a tdb2:DatasetTDB2 ; tdb2:location "/fuseki-base/databases/<name>" .
  ```
  It infers over every graph; its hierarchy is the closure of the stored `rdfs:subClassOf`
  triples in the default graph. A commit that adds or removes one marks the hierarchy stale and
  bumps a generation counter; the first transaction to begin afterwards rebuilds it once (other
  starting readers wait), and each transaction keeps the hierarchy it began with. A burst of sync
  commits costs one rebuild; a writer sees its own `subClassOf` change from its next transaction.
- The image keeps the base image's `ds` dataset and its `shacl` endpoint under
  `ENABLE_SHACL=true`, as `lf:DatasetRDFSLive` over TDB2 at `/fuseki-base/databases/ds` (the base
  image's `ds` is TDB1 with a union default graph; its Lucene index and `ENABLE_*` handling are
  kept). Core's SHACL tests validate through it.
- The module rewrites `$FUSEKI_BASE/templates/config-tdb2` at start when it is missing or
  different, with a warning (Fuseki copies its stock template only when the file is missing, so a
  persisted volume would otherwise create plain datasets silently).
- `templates/config-tdb2` (baked in) declares the service with the endpoints CN uses today
  (`""`/`sparql`/`query`, `""`/`update`, `""`/`data` GSP read-write, `upload`, `get`) over
  `lf:DatasetRDFSLive`, plus `stored` and `shacl` (store validation, decision 23). A form-created dataset (`POST $/datasets`,
  `dbName`, `dbType=tdb2`) gets it. **Only `dbType=tdb2` datasets infer**; `mem` (`config-mem`)
  stays plain.
- `/<ds>/stored`: one module operation (`lf:stored`) over the stored triples only (every graph),
  run by TDB2's own query engine: a SPARQL query or a GSP read, chosen from the request; writes
  answer 405.
- **Backups and copies stream `GET /<ds>/stored` as N-Quads.** `POST $/backup` and `GET /<ds>`
  dump the service's dataset, inferred triples included, so they are never used for these
  datasets.
- `DELETE $/datasets/<ds>` removes the TDB2 files too (a module filter finishes what Fuseki skips
  for a wrapped dataset); a re-created name starts empty.
- `arq:httpServiceAllowed=false` set by the module for every dataset.
- *pending F1:* whether `text:TextDataset` (pg-test) works over `lf:DatasetRDFSLive`.

### Ontology data files and loader (provider K1 + L1; consumers N1, N2, P1, C2, C3, T1, every package)

- A package's ontology data is Turtle, `src/data/<file>.ttl`, the whole vocabulary (labels,
  comments and the rest stay in the file; the sync keeps only the hierarchy). One file per former
  JSON file, same base name.
  ```ts
  // @_linked/core/ontology/loadOntologyFiles  (server only; imports node:fs/promises dynamically)
  export function loadOntologyFiles(moduleUrl: string, files: string[]): Promise<string[]>;
  // a package's src/ontologies/schema.ts
  export const loadData = () => loadOntologyFiles(import.meta.url, ['../data/schema.ttl', '../data/schema-added.ttl']);
  // src/ontologies/schema.register.ts
  linkedOntology(terms, ns, 'schema', loadData, ['../data/schema.ttl', '../data/schema-added.ttl']);
  ```
  A package without data passes no `loadData`. A `loadData` that resolves to anything but strings
  (an unconverted JSON package) is skipped with one warning naming the package.
- `npx linked build` copies `src/**/*.ttl` into `lib/esm/`, keeping `src`'s layout. A release
  app build keeps every `@_linked/*` package external (it fails if one is compiled in), so their
  data is read from the installed package; `build-app` copies the app's own `src/**/*.ttl` into
  `lib/` the way it copies CSS. L1 verifies (its checks M1-M5, incl. `import.meta.url` under dev
  SSR).

### Shape check (provider K1; consumers V1, L2, C3, every package)

```ts
// @_linked/core/shapes/checkShapeHierarchy
export type ShapeCheckKind =
  | 'extends-without-subclass'   // decision 13, direction II
  | 'subclass-without-extends'   // decision 13, direction I (in scope; out of scope → severity 'warning')
  | 'borrowed-target-class'      // decision 15
  | 'mirror-undefined-term'      // decision 16
  | 'override-not-tightened';    // decision 14: a narrower class/value shape (needs the hierarchy) and every data-only shape
export interface ShapeCheckFinding { kind: ShapeCheckKind; severity: 'error' | 'warning'; shape?: string; iri?: string; message: string }
export function checkShapeHierarchy(options?: {
  hierarchy?: HierarchyTriple[];
  dependencies?: Record<string, string[]>;   // package → its dependencies, from package.json (L2, V1);
}): Promise<ShapeCheckFinding[]>;            // without it, direction I's scope is the shape's own package
```
Reads registered shapes, registered ontologies (parsed through the reader unless `hierarchy` is
given) and `linkedPackage(..., {mirrors})`. `@linkedShape({sharedTargetClass: true})` exempts a
shape from `borrowed-target-class`; shape sync stores it as `core:sharedTargetClass` so data-only
shapes keep it. Boot and sync log findings; `npx linked build` fails on any
`error` (L2); CN's builder refuses or offers the fix (C3).

### CLI build check (provider L2; consumers every package)

After compiling, `npx linked build` imports the built package's shape and ontology modules (its
`package.js` registration, `shapes/index.js`, `ontologies/*.register.js`; not its UI index), runs
`checkShapeHierarchy()`, prints every finding, and exits non-zero on an `error`.
`--skip-shape-check "<reason>"` prints the reason and skips.

## Which CLI runs in the layout

Every `npx linked …` in plan 070's layout runs the **main checkout's** CLI:
`~/web/wt/070/node_modules` is a symlink to `~/web/create_now/node_modules`, whose `.bin/linked`
resolves to `~/web/create_now/packages-local/_linked-cli/lib/esm/launch.js` (on `main`). A
step's own CLI changes run only through its worktree's built bin:

```sh
# in the step's cli worktree, after building it (main's CLI builds the cli source fine)
npx linked build
LINKED="node $PWD/lib/esm/launch.js"     # then: (cd <fixture package> && $LINKED build)
```

So L1's Verify exercises fixtures with `$LINKED`, never `npx linked`; and until the release,
packages that need L1's Turtle copy (N1, N2, P1, C2, T1) must be built with the integration CLI,
`node ~/web/wt/070/packages-local/_linked-cli/lib/esm/launch.js build` (reported to the master as
a contradiction with §How to use, 2).

## L1 — the package build ships Turtle

**Depends on:** nothing for phase 1; K1 landed for phase 2 (`@_linked/core/ontology/loadOntologyFiles`
exists on core's `store-inference`); F1 landed for phase 3 (the image builds as
`linked-fuseki:dev`).

**Goal:** a package's Turtle ontology data reaches `lib/` and its consumers in every mode (package
build, release backend build, dev SSR, workspace and standalone), and new ontology packages are
scaffolded in Turtle.

**Scope:**
1. `npx linked build` copies `src/**/*.ttl` into `lib/esm/` (and `lib/cjs/` when the package
   publishes CJS), next to the JSON, CSS and declarations it copies today.
2. As the master's contract says, verified by measurement (below): `linked build-app` copies the app's own
   `src/**/*.ttl` into `lib/` next to the compiled backend; framework and workspace packages stay
   external in the backend build (already enforced) and read their own `lib/esm/data/`.
3. The ontology scaffold (`create-ontology`, `create-package --kind ontology`,
   `buildPackageFiles`) writes `src/data/<slug>.ttl` and the contract's `loadData`/register form;
   the `.json` and `.json.d.ts` example files go.
4. `tests/e2e/create-app.spec.ts` runs its Fuseki on the image with a `tdb2` dataset and asserts
   the dataset infers.
5. README (build section: `.ttl` files ship; the app build copies the app's own), report 024,
   minor changeset.

**Settling *pending L1*** (adopted in the master plan; M1-M5 verify it). What the code does today:

- The release backend build (`buildBackendWithVite`, `src/app-release/build-backend.ts:429-516`)
  keeps every installed `@_linked/*` and every workspace package external (`ssr.external` =
  workspaces at 449/480; installed ones are auto-externalized) and fails when one is compiled in
  (`assertNoInlinedWorkspaces`, 320, called at 516). A package's `loadData` therefore runs from
  `node_modules/<pkg>/lib/esm/ontologies/<x>.js`, and `../data/<x>.ttl` is the copied file:
  **ontology packages are already external; nothing to change for them.**
- The app's own modules are compiled into `lib/` with `preserveModules` and
  `preserveModulesRoot: src` (499-500), so `src/ontologies/x.ts` becomes `lib/ontologies/x.js`
  and `import.meta.url`-relative `../data/x.ttl` points at `lib/data/x.ttl`, which nothing writes
  today. **Emit the app's `.ttl` next to the compiled modules**, as `copyBackendStylesheets`
  (525-540, called from `buildBackend`, `src/cli-methods.ts:2224-2238`) does for CSS.
- Dev `linked start`: a workspace package resolves to `src/` (`linked:resolve-workspace-ts`,
  `vite-config.ts` ~813-847), so its `src/data/x.ttl` is beside it; a standalone app bundles every
  `@_linked/*` but core and the CLI for the SSR runner from `lib/esm`
  (`STANDALONE_SSR_BUNDLED`, `vite-config.ts:647`; report 016). Either way the module's own file
  is next to its data, *provided* Vite's SSR transform gives `import.meta.url` the module's real
  file URL. Measured, not assumed.

So the proposal is both halves: keep packages external (no change) and copy the app's own Turtle.
**Measure (phase 1), each quoted in report 024:**

| # | What | How | Pass |
|---|---|---|---|
| M1 | release backend reads an app's Turtle | fixture app `tests/fixtures/ontology-app` (`src/backend.ts` importing `src/ontologies/probe.ts`, whose `loadData` calls a local stand-in `loadFiles(import.meta.url, ['../data/probe.ttl'])` doing `readFile(new URL(f, moduleUrl))`), built with `buildBackendWithVite` + the new copy; then `node -e "import('<fixture>/lib/ontologies/probe.js').then(m=>m.loadData()).then(t=>console.log(t.length))"` | prints the file length; `grep -c 'import.meta.url' lib/ontologies/probe.js` ≥ 1 (not inlined to a build-machine path) |
| M2 | release backend reads an installed package's Turtle | the same fixture with a fake installed `@_linked/probe-ont` (`lib/esm/ontologies/p.js` + `lib/esm/data/p.ttl`, via `tests/fixtureNodeModules.ts`) imported by `src/backend.ts` | `lib/` holds no copy of `probe-ont` (the build passes `assertNoInlinedWorkspaces`); calling its `loadData` from the compiled backend returns the text |
| M3 | dev SSR, standalone and workspace | `createServer` with the fixture's `createViteConfig` (dev), `ssrLoadModule('/src/ontologies/probe.ts')` and the installed `probe-ont` (standalone: bundled from `lib/esm`), call each `loadData` | both return the text; log the `import.meta.url` each saw |
| M4 | client build is unharmed | `vite build` of the fixture's client with a page importing the register module | exit 0; no `.ttl` content in `public/bundles`; quote any `node:fs` externalization warning |
| M5 | the tarball carries the data | `$LINKED build` then `npm pack --dry-run` in a fixture package with `src/data/x.ttl` | lists `lib/esm/data/x.ttl` |

If M3 fails (Vite rewrites `import.meta.url` for bundled SSR modules), stop and report: the fix is
in `vite-config.ts`. Proposed contract text, **adopted in the
master plan** in its own wording (the last bullet of §Ontology data files and loader above):

> - `npx linked build` copies `src/**/*.ttl` into `lib/esm/` (so `src/data/x.ttl` →
>   `lib/esm/data/x.ttl`). `linked build-app` copies the app's own `src/**/*.ttl` into `lib/`
>   beside the compiled backend (`preserveModules` keeps `src`'s layout, so `import.meta.url`
>   paths hold); framework and workspace packages stay external there and read their own
>   `lib/esm/data/`. In dev, every module reads the data beside its own file (`src/` for a
>   workspace, `lib/esm/` for an installed package).

**Verify:**
- `npx linked build` in the cli worktree exits 0.
- `npx jest --config jest.config.cjs tests/unit/copyAssetsStep.test.ts tests/unit/buildBackend.test.ts tests/unit/esmSpecifiers.test.ts tests/unit/createPackageScaffold.test.ts tests/unit/createInsidePackage.test.ts tests/unit/packageFiles.test.ts tests/unit/ssrExternal.test.ts`
- M1-M5 above (commands and output quoted).
- Phase 2: in a tmp dir, `$LINKED create-package probe --kind ontology`, then
  `npm install <tarball of core's store-inference>` (`npm pack` in
  `~/web/wt/070-L1/packages-local/_linked-core`, built), then `(cd probe-ont && $LINKED build)`:
  exit 0 and `lib/esm/data/probe.ttl` present.
- Phase 3: `docker build -t linked-fuseki:dev ~/web/wt/070/packages-local/_linked-fuseki/server`,
  then `npx playwright test --config playwright.config.ts tests/e2e/create-app.spec.ts`.
- Full: `npm run test:unit`; `npx playwright test --config playwright.config.ts` (all three specs).

**Done when:** a built package's `lib/esm/data/` holds its `.ttl` files and `npm pack` ships them;
a release backend and a dev server both read an app's own and an installed package's Turtle
(M1-M3); the scaffold writes Turtle and builds against core's `loadOntologyFiles`; the CLI e2e
passes on the image; M1-M5 confirm the master's contract text; report 024 and a minor
changeset are in.

**Files:**
- `src/cli-methods.ts:3162-3198` the 'Copying files to lib folder' step: glob
  `'**/*.{json,d.ts,css,scss}'` (3169) gains `ttl`.
- `src/cli-methods.ts:3964-3994` `removeOldFiles` deletes `lib/` files whose mtime is over 120 s
  old; the copy must keep fresh mtimes (fs-extra's `copy` does unless `preserveTimestamps`).
- `src/cli-methods.ts:2200-2241` `buildBackend`: a Turtle copy step after the CSS one (2224-2238).
- `src/app-release/build-backend.ts:525-540` `copyBackendStylesheets`: the model for
  `copyBackendOntologyData` (a failure here fails the build, unlike the CSS copy's warning).
- `src/cli-methods.ts:1396-1483` `createOntology`: copies `example-ontology.json` and `.json.d.ts`
  (1433-1461) and fills them (`replaceVariablesInFiles`, 1456-1461).
- `src/utils/packageFiles.ts:60-68` `EXAMPLE_ONTOLOGY_FILES`, `FILLED_ONTOLOGY_FILES` (`slice(0, 3)`
  relies on the order), `outputPath` 199-210 (renames by keeping the extensions).
- `defaults/package-ontology/src/data/example-ontology.json`, `.json.d.ts` → `example-ontology.ttl`;
  `defaults/package-ontology/src/ontologies/example-ontology.ts` (`loadData` via a JSON
  `import()`), `example-ontology.register.ts` (`linkedOntology(..., '../data/${hyphen_name}.json')`).
- Tests: `tests/unit/copyAssetsStep.test.ts` (26-46), `tests/unit/esmSpecifiers.test.ts:245-280`
  (step order), `tests/unit/buildBackend.test.ts`, `tests/unit/createPackageScaffold.test.ts:61-102`
  (file list 68-76, register text 89-90, JSON parse 94), `tests/unit/createInsidePackage.test.ts:39`,
  `tests/unit/packageFiles.test.ts:66-110`, `tests/template/package.full.test.ts` (RUN_TEMPLATE_FULL).
- `tests/e2e/create-app.spec.ts:40` `new GenericContainer('stain/jena-fuseki')`; `:63`
  `dbType=mem`; the app is cloned from app-template's GitHub `main` (`src/cli-methods.ts:253`)
  and installed from npm (`tests/e2e/helpers/app.ts:55-66`).
- CN: `src/backend/provisioners/appProjectPackages.test.ts:63` expects
  `'../data/lego-elevated-planning.json'`; CN builds project packages through `buildPackageFiles`
  (cli report 023), so the scaffold change reaches CN's generated packages at once.

**Pitfalls:**
- `npx linked` runs main's CLI (above). Exercise every fixture with `$LINKED`.
- Do not write `new URL('../data/x.ttl', import.meta.url)` in fixtures: Vite's asset plugin
  rewrites that literal pattern. The contract's form passes `import.meta.url` to a function.
- The copy covers `src/**/*.ttl`, not only `src/data/`: the existing asset rule copies by
  extension across `src/`; a `.ttl` elsewhere is harmless and the paths stay relative.
- Unconverted packages keep `src/data/*.json` and their JSON `loadData`; the copy step still
  copies JSON. Nothing here may break them before N1/N2/P1 convert.
- The scaffold's `loadData` imports `@_linked/core/ontology/loadOntologyFiles`, which npm's core
  lacks until the release: `tests/template/package.full.test.ts` (installs from npm) fails until
  then. Run it at R; L1 verifies the scaffold with core's packed integration build instead.
- CN's `appProjectPackages.test.ts:63` turns red on CN's `store-inference` the moment L1 lands
  (Vitest resolves `@_linked/cli` to the nested checkout's source). L1 lands its one-line CN
  update right after the cli landing (CN last).
- The image's inferring template is `config-tdb2` only: a `dbType=mem` dataset would not infer.
- The e2e cannot show "a template app reads its Turtle" before T1 and the release: the template
  comes from GitHub `main` and npm. L1's e2e asserts inference on the image directly; the
  template-app assertion moves to T1 (reported to the master).
- The scaffold's starter `.ttl` follows decision 10's deterministic form (fixed prefix block,
  `<ns> a owl:Ontology .`, no blank nodes) so the first write by the generator or builder is a
  no-op diff.

**Architecture:** CN arch-04 §RDF file formats; arch-03 §Layering; arch-05 (the generator writes
package data); arch-10 (package layout); core `docs/architecture/ontologies.md`; cli reports 001
(Vite backend build), 016 (standalone SSR bundling), 020 (`build-app` needs no data server), 023
(`buildPackageFiles`).

**Tests:**
- New: `copyAssetsStep.test.ts` — `src/data/terms.ttl` lands in `lib/esm/data/terms.ttl` (and in
  `lib/cjs/data/` only when CJS is published); `buildBackend.test.ts` — `copyBackendOntologyData`
  copies `src/data/x.ttl` and `src/ontologies/y.ttl` to `lib/` with the same relative paths and
  fails on a copy error; M1-M3 as one test file `tests/unit/ontologyDataReachable.test.ts` over
  `tests/fixtures/ontology-app` (real Vite build and dev server, no network);
  `createPackageScaffold.test.ts` — the file list holds `src/data/planning.ttl`, no `.json`, the
  register line is `linkedOntology(terms, ns, 'planning', loadData, ['../data/planning.ttl'])`, the
  `.ttl` declares `<{uri}> a owl:Ontology`; `packageFiles.test.ts` the same for
  `buildPackageFiles`; `create-app.spec.ts` — after creating the dataset, an update inserts
  `ex:A rdfs:subClassOf ex:B . ex:a a ex:A`, `ASK {ex:a a ex:B}` is true on the dataset and false
  on `/<ds>/stored` (endpoint per F1's settled names), then the triples are deleted.
- Quick gate (1-2 min), after each phase: `npx linked build` in the cli worktree, then the jest
  line under Verify.
- Full gate, before landing: `npm run test:unit`; `npx playwright test --config playwright.config.ts`
  (create-app needs Docker and `linked-fuseki:dev`); CN's
  `npx vitest run src/backend/provisioners/appProjectPackages.test.ts` in `~/web/wt/070-L1/`.

**Size:** small, **3 phases** (the master says 2; phase 3 waits for F1 and phase 2 for K1):
1. Turtle in the package build and the app backend build; M1-M5 verify the contract text.
2. The scaffold in Turtle (needs K1's `loadOntologyFiles`); CN's test line.
3. The CLI e2e on the image (needs F1).

**Changeset:** minor. **Record:** report 024.

**Outcome (phase 1 of 3).** The package build copies `src/**/*.ttl` (glob gains `ttl`);
`buildBackend` copies the app's own Turtle through `copyBackendOntologyData`
(`src/app-release/build-backend.ts`), failing the build on a copy error. M1-M5 pass as planned, no
`vite-config.ts` change (dev SSR keeps each module's real `import.meta.url`); the contract text
stands. Quick gate: `npx linked build` 7.1 s; the Verify jest line plus
`ontologyDataReachable.test.ts`, 8 suites / 129 tests passed, 23.5 s. Deviation: the fake installed
`@_linked/probe-ont` is copied into the fixture app's `node_modules` (it needs no core), not built
through `tests/fixtureNodeModules.ts`. Measurements and output: report 024. Phase 3 (e2e, after F1) open.

**Outcome (phase 2 of 3).** The scaffold writes `src/data/<name>.ttl` (fixed prefix block,
`<ns> a owl:Ontology .`), `loadData` via `loadOntologyFiles(import.meta.url, [...])` and the
register form `linkedOntology(terms, ns, '<name>', loadData, ['../data/<name>.ttl'])`; the `.json`
and `.json.d.ts` example files are gone. Verify passed: `$LINKED create-package probe --kind
ontology`, core's packed `store-inference` (944b6d0) installed, `$LINKED build` exit 0 with
`lib/esm/data/probe.ttl`, and core's registry loads it. Gate: build 9.3 s; Verify jest line 130
tests, 4.9 s; `npm run test:unit` 870 tests, 21.8 s; CN's `appProjectPackages.test.ts` 25 passed,
5.4 s. CN's landing changes two assertions in that test (lines 56 and 63, not one) and arch-03's
package tree. Report 024.

**Outcome (phase 3 of 3).** `create-app.spec.ts` runs Fuseki from `FUSEKI_IMAGE` (default
`linked-fuseki:dev`) with a `tdb2` dataset; a new test inserts `A rdfs:subClassOf B . a a A`,
asserts `ASK {a a B}` true on `/<ds>/sparql` and false on `/<ds>/stored`, and deletes the triples.
Fuseki 6 answers updates with 204 (the check is `r.ok`). Verify: image rebuilt from fuseki
112f09f, the spec 2 passed in 1:50; full gate `npm run test:unit` 870 passed (51.6 s), all three
Playwright specs 6 passed (2:24). Report 024.


## L2 — the post-build shape check

Detail written when its wave starts (wave 4). Contract: §CLI build check above; it adds a step to
`planBuildSteps` (`src/cli-methods.ts:3141`, after 'Checking shapes/index') and a
`--skip-shape-check` option on `build` (`src/cli.ts:349`). The existing shape checks already load
each compiled shape module in a child process (`inspectShapeReferences`, shared by 'Checking shape
references' and 'Checking shapes/index'); L2's plan should say whether it reuses that run. Record:
report 025; changeset minor.

## Progress

- [ ] Sub-plan reviewed by the master; contradictions routed into the master's §Contracts
- [x] L1 phase 1 — Turtle in the package and app backend builds; the contract verified, M1-M5 (report 024)
- [x] L1 phase 2 — scaffold in Turtle; CN's `appProjectPackages.test.ts` updated
- [x] L1 phase 3 — CLI e2e on the image
- [ ] L1 landed on `store-inference` (commit: )
- [ ] L2 detail written (wave 4)
- [ ] L2 landed (report 025, commit: )
- [ ] Release PR (R): link
- [ ] R: `create-app.spec.ts`'s default `FUSEKI_IMAGE` becomes the published
  `ghcr.io/linked-fw/fuseki:6.2.0-1` (report 024)
- [ ] R: raise `defaults/package/package.json`'s `@_linked/core` range to the release exporting
  `ontology/loadOntologyFiles`; run `tests/template/package.full.test.ts` (report 024)
