---
date: 2026-11-10
summary: >
  `linked generate-ontology` writes one terms module per ontology (terms as `{id}` literals) and
  one `src/ontologies/index.ts` per package that registers every ontology with core's
  `registerOntologies(…, import.meta.url)`; the entry imports it, the old `.data.ts` /
  `.register.ts` go, and the build checks all of it. An app's prefix map lives in
  `linked.app.json` (schema v1 shipped), grown add-only by `linked prefixes`, and is loaded at
  server start and into the browser bundle. Major.
packages: [cli]
---

# 052 — The ontology index and the app's prefix map

## PR

### Summary

**Ontology modules.** Per package, `linked generate-ontology` now writes:

- `src/ontologies/<module>.ts` per generated ontology: only its terms, each
  `export const Term = {id: '<namespace>Term'};` with its doc line. It imports nothing.
- `src/ontologies/index.ts`: imports every ontology module (hand-written ones too) and registers
  them with one call:

  ```ts
  import {registerOntologies} from '../package.js';
  import * as dc from './dc.js';
  …
  registerOntologies(
    [
      {
        name: 'dc',
        namespace: 'http://purl.org/dc/elements/1.1/',
        terms: dc,
        data: ['../data/dcelems.ttl', '../data/dc-added.ttl'],
        suggestedPrefix: 'dc',
      },
      …
    ],
    import.meta.url,
  );
  ```

- the entry (`src/index.ts[x]`) imports `./ontologies/index.js`; side-effect imports of a removed
  `<module>.register.js` anywhere in `src/` become an import of the index; the `.data.ts` /
  `.register.ts` files it generated before are removed (only files carrying its header).

`linked build`'s ontology check refuses a stale or missing module, an entry without the index
import, and a leftover generated file. `create-package --kind ontology` and `create-ontology`
produce this layout; the template's `src/package.ts` exports `registerOntologies`. The shape check
expects registration through `ontologies/index.js` (as core's `registerInstalledOntologies` now
imports).

**`linked.app.json`.** Schema v1 ships as `schema/app/1.json` (`$id`
`https://linked.cm/schema/app/1.json`). The reader refuses an unknown or missing `schemaVersion`,
an unknown key, a prefix outside `^[A-Za-z][A-Za-z0-9_]*$` and a non-IRI namespace. `linked
prefixes` adds, for every installed ontology (the app's and every linked dependency's, recursively)
whose namespace the map lacks, its suggested prefix or `<p>_2`, `_3`, …; it never changes or
removes an entry and creates the file when missing. `generate-ontology` runs it for the app the
package belongs to (same git repository). The map is loaded with `Prefix.load` at `linked start`
(through the SSR runner), by a compiled server (the app's copy of core) and in the browser (Vite
plugin `linked:app-prefixes`: the client entry imports `virtual:linked-app-prefixes` first, on its
first line). `create-app` writes the file and fills it after the install; the React Native
template's API service has one.

### Changes

- `src/utils/ontologyModules.ts`: terms as literals; `generateOntologyIndexModule`;
  `generateOntologyModules(specs, handWritten?)` gives a package's files; data and register
  generators removed; `GENERATED_HEADER`, `ONTOLOGY_INDEX`; `_data`/`_load`/`_ns`/`_prefix` no
  longer reserved.
- `src/utils/generateOntology.ts`: `generatePackageOntologies` → `{ontologies, files, edits,
  remove}`; entry and import edits; stale file removal; check covers them.
- `src/utils/appConfig.ts` (new), `src/plugins/app-prefixes.ts` (new), `schema/app/1.json` (new,
  in `files`).
- `src/cli.ts`: `linked prefixes`; `generate-ontology` text, output (`Wrote` / `Removed`) and the
  app's map. `src/cli-methods.ts`: `create-ontology`, `create-app`, `startServer` loading.
  `src/commands/start.ts`: loading. `src/vite-config.ts`: the plugin. `src/utils/shapeHierarchy.ts`:
  index detection. `src/utils/packageFiles.ts`: scaffold docs.
- Templates: `defaults/package/src/package.ts`, `defaults/package-ontology/src/index.ts`,
  `defaults/app-react-native/services/api/linked.app.json`.
- README: "Ontology modules", "`linked.app.json`", template lines.
- Tests: `appConfig.test.ts` (new, 12); `ontologyGenerator.test.ts` (golden index, literals,
  import names, stale files refused and removed, entry import, hand-written in the index, module
  rename); scaffold, package-file, create-inside-package, template-full, shape-check and
  shapes-Turtle fixtures moved to the layout; the generator fixture regenerated.
- Changeset `.changeset/ontology-index-and-app-prefixes.md` (major).

### Verification

- `node lib/esm/launch.js build` → `✔ Build successful`.
- `npx jest tests/unit` → `Test Suites: 105 passed, 105 total`, `Tests: 1311 passed, 1311 total`.
- `npm run test:e2e` → `7 passed (1.2m)`.
- Against the master's core with F5 (3a64295, built): a package scaffolded by
  `buildPackageFiles('planning-ont', 'ontology')`, two terms added to its Turtle, `linked
  generate-ontology`, then `tsc -p tsconfig-esm.json --noEmit` → exit 0; emitted and imported in
  Node, `suggestedPrefixes()` →
  `[{"packageName":"planning-ont","name":"planning","namespace":"https://linked.cm/ont/planning/","prefix":"planning"}]`,
  and after `Prefix.load({planning: …})`, `Prefix.toPrefixed('…/planning/Task')` → `planning:Task`.
- On a copy of `_linked-dcmi` (master tree): `generate-ontology --check` →
  `Out of date: src/index.tsx, src/ontologies/dc.data.ts, … src/ontologies/index.ts, src/shapes/index.ts.`;
  `generate-ontology` → `Wrote src/index.tsx, src/ontologies/dc.ts, src/ontologies/dcmitype.ts,
  src/ontologies/dcterms.ts, src/ontologies/index.ts, src/shapes/index.ts` / `Removed
  src/ontologies/dc.data.ts, src/ontologies/dc.register.ts, …`; then `--check` → `Every ontology
  module is current.`
- The builder against an app with the master's packages installed (run by `generate-ontology` in a
  scratch package inside the step's app worktree; the file was then deleted) added 20 prefixes:
  `auth, core, dcat, dc, dcmitype, dcterms, fuseki, npm, org, owl, rdf, rdfs, s3, schema, sentry,
  server, server_utils, sioc, translation, xsd`.

### Deviations

- Core's API landed during the step; the index first passed `data: {files, load}`, then matched
  F5's `registerOntologies(ontologies, import.meta.url)` with `data: ['../data/x.ttl']`.
- Loading the map does not refuse a core without `Prefix.load`: it warns and loads nothing (that
  core's packages still register their own prefixes). The cli's e2e apps install the published
  core, and refusing broke their boot. Removing the tolerance is backlog 018.
- The web app template lives in its own repository; `create-app` writes `linked.app.json` when the
  clone has none instead of changing that repository here.

### Follow-ups

- Regenerate every ontology package with this layout, move consumers of `ns` / `loadData` /
  `_ontologyResource` to core's `createNameSpace`, and build each app's map with `linked prefixes`:
  the plan's next step on the packages (it owns the regeneration).
- A host app that writes ontology packages through `generateOntologyModules` gets the index from
  it now, and must make the package entry import `./ontologies/index.js` and `src/package.ts`
  export `registerOntologies`: the host app's own plan for its package writer.
- Schema URL, the app template repo's file, the core range and the warning, hyphenated suggested
  prefixes (`server-utils` → `server_utils` in a map): backlog 018.

## Details

### Decisions taken autonomously

| # | Where | Problem | Choice | Alternative | Rationale |
|---|---|---|---|---|---|
| 1 | contract | Core's map-loading call was not named when the step started | `Prefix.load(map)` (confirmed by core) | — | Contract assumption |
| 2 | contract | Where `registerOntologies` is imported from | The package object, `../package.js` (confirmed) | A free function taking the package name | Registrations are keyed by package |
| 3 | contract | Shape of `data` | Core's landed form: file list relative to `import.meta.url` | `{files, load}` | Match the landed API |
| 4 | layout | `_ontologyResource` lived in the data module | Dropped | A registration field | No reader anywhere; the IRI stays in the data |
| 5 | map | A suggested prefix legal in Turtle but not as a map name | Other characters become `_` (`server_utils`), then the `_2` rule | Refuse | The builder never fails on a valid package |
| 6 | schema | Unknown keys in `linked.app.json` | Refused, naming the key | Ignored | A misspelt key would be silently lost |
| 7 | map | What "inside an app" means for `generate-ontology` | The package is the app or lies under it in the same git repository | Any app found walking up | A framework checkout nested in an app folder must not write its map |
| 8 | template | The web template is another repository | `create-app` writes the file when missing; the RN template ships one | Change that repository now | Out of this step's repositories |
| 9 | shape check | Which modules mean "registers its ontologies" | `ontologies/index` only | Also `*.register.js` | Must match what core imports |
| 10 | identifiers | `_data`, `_load`, `_ns`, `_prefix` were reserved | No longer reserved | Keep | Core adds no keys to the terms now |
| 11 | loading | A core without `Prefix.load` | Warn, load nothing | Refuse to start | Apps on the published core keep booting; their packages still add prefixes |

### Notes

- Only files that start with the generator's header are removed; a hand-written module that still
  carries the header of the module it started as is kept when declared `"generated": false`.
- The entry import is added as the entry's first line; the client-bundle import is prepended on
  the entry's first line so no line moves (`map: null`).
- A compiled server imports `@_linked/core/utils/Prefix` from the app's own install
  (`<core>/lib/esm/utils/Prefix.js` via the `node_modules` walk), not the cli's copy.
