---
summary: >
  One terms file per ontology (terms as `{id}` literals) and one generated `ontologies/index.ts`
  per package that registers every ontology with core's `registerOntologies`; the package
  template produces that layout. An app's prefix map lives in `linked.app.json` (schema v1,
  shipped with the cli), grown add-only by `linked prefixes` and loaded into core at server start
  and into the browser bundle.
status: Implementation
---

# 004 — Ontology modules in one register file; the app's prefix map

## Goal

1. **Module layout.** `linked generate-ontology` writes, per package:
   - `src/ontologies/<module>.ts` per generated ontology: only its terms, each
     `export const T = {id: '<namespace>T'};` (the value core's `createNameSpace(ns)('T')` returns),
     with its doc line; imports nothing;
   - `src/ontologies/index.ts`: imports every ontology module (generated or written by hand) and
     registers them all with one `registerOntologies([...])` call; `suggestedPrefix` from the vann
     data;
   - removes stale generated `<module>.data.ts` / `<module>.register.ts`, rewrites side-effect
     imports of a removed register module to the index, and makes the package entry
     (`src/index.ts[x]`) import `./ontologies/index.js`.
   `linked build`'s check refuses anything of this that is missing or stale.
2. **Package template.** `create-package --kind ontology` and `create-ontology` produce that
   layout; the template's `src/package.ts` exports `registerOntologies`.
3. **`linked.app.json`.** Schema v1 in the cli (`schema/app/1.json`, `$schema`
   `https://linked.cm/schema/app/1.json`), a reader refusing an unknown `schemaVersion`, prefix
   names `^[A-Za-z][A-Za-z0-9_]*$`; the add-only builder (`linked prefixes`, and run by
   `generate-ontology` for the app the package belongs to); the map loaded at server start (dev
   and compiled) and into the client bundle (Vite plugin). The app template gets the file.

Out of scope: regenerating other packages (a later step), `linked.config.js` (a later step).

## Contracts (from the master plan, K8–K11)

- Core (built in parallel): `registerOntologies(entries)` and a map-loading call. The master plan
  does not name the latter; assumed `Prefix.load(map: Record<string, string>)` (decision 1).
- `registerOntologies` is assumed to come from the package object, like `linkedOntology` today
  (`import {registerOntologies} from '../package.js'`), since registrations are keyed by package
  and name (decision 2).
- Each entry: `{name, namespace, terms, data, suggestedPrefix}`; `terms` is the module's whole
  namespace object; `data` is `{files, load}` (decision 3).

## Architecture

- `ontologyModules.ts` (pure): `generateOntologyTermsModule(spec)` (literals),
  `generateOntologyIndexModule(entries)`, `generateOntologyModules(specs)` → every file of a
  package (terms per generated ontology + index). The data/register generators go.
- `generateOntology.ts`: `generatePackageOntologies(dir)` returns `{ontologies, files, remove,
  entry}` — files to write, stale generated files to delete, and the entry file edit;
  `writePackageOntologies` applies it (and rewrites side-effect register imports);
  `staleOntologyModules` lists every difference; `checkOntologyModulesStep` refuses them.
- `appConfig.ts` (new): `APP_CONFIG_FILE`, `APP_SCHEMA_URL`, `PREFIX_NAME`,
  `parseAppConfig(text)`, `readAppConfig(appRoot)`, `serializeAppConfig`, `prefixCandidate`,
  `addMissingPrefixes(map, ontologies)` (pure, add-only), `appOntologies(appRoot)` (installed
  ontologies with namespace + suggested prefix, from each installed package's `linkedOntologies`
  and data), `refreshAppPrefixes(appRoot)`, `findAppRoot(dir)` (stops at a repo boundary),
  `appPrefixesModuleCode(map)` and `loadAppPrefixes(appRoot, importModule)`.
- `plugins/app-prefixes.ts`: the Vite plugin: a virtual module that loads the map; the client
  entry imports it first (prepended on line 1, so no line shifts).
- `commands/start.ts` and `startServer`: `loadAppPrefixes` before the storage config loads.
- `schema/app/1.json` shipped (`files`).

## Pitfalls

- Generated output is byte-deterministic; CRLF checkouts read as LF.
- Only files carrying the generator's header are deleted; a hand-written `.data.ts` stays.
- A suggested prefix that is a valid Turtle prefix but not a map name (`server-utils`) becomes
  `server_utils` in the map (decision 5).
- `generate-ontology` in a framework checkout nested in an app's folder must not write that app's
  map: the app root search stops at a git repo boundary.
- Index import names must not collide with each other or its own locals.

## Phases

### Phase 1 — generator and build check (K9)

- Terms literals, index module, `generateOntologyModules(specs)`; `generatePackageOntologies`
  package result; removal of stale generated files; entry import; side-effect import rewrite;
  build check; `generate-ontology` command text; fixture regenerated; unit tests updated and
  added (index golden, generated:false in index, stale `.data.ts` refused and removed, entry
  missing import refused and fixed, deterministic, tree-shaking).
- Validation: `npx jest tests/unit/ontologyGenerator.test.ts`; `npx tsc -p tsconfig-esm.json
  --noEmit`.

### Phase 2 — package template and create-ontology

- `ontologyScaffoldModules` → terms + index; template `src/index.ts` of the ontology kind
  imports `./ontologies/index.js`; `src/package.ts` exports `registerOntologies`;
  `create-ontology` writes the data and the entry, then regenerates the package.
- Validation: `packageFiles`, `createInsidePackage` tests pass (updated).

### Phase 3 — `linked.app.json`, builder, `linked prefixes`

- `appConfig.ts`, schema file, `linked prefixes` command, `generate-ontology` runs the builder
  for its app; create-app writes the file (web clone and react-native template).
- Validation: new `appConfig.test.ts` (reader refusals, add-only, `_2`, normalisation, app
  ontologies from a fixture, repo boundary); `npx tsc --noEmit`.

### Phase 4 — loading the map

- Server start (dev + compiled), Vite plugin in `createViteConfig`.
- Validation: unit tests of the plugin (virtual module text, entry prepend, ssr untouched) and
  of `loadAppPrefixes` with a fake importer.

### Phase 5 — docs and gate

- README sections; `npx linked build`; `npm test` (unit + e2e).

Dependencies: 1 → 2; 3 → 4; 3 is independent of 1–2 except the shared `generate-ontology`
command. One agent, sequential.

## Autonomous decisions

| # | Where | Problem | Choice | Alternative | Rationale |
|---|---|---|---|---|---|
| 1 | contract | The master plan does not name core's map-loading call | `Prefix.load(map)` as instructed; no fallback to `Prefix.add` | Fall back to `Prefix.add` when `load` is missing | One explicit way; no app has a `linked.app.json` before the packages move together, so nothing loads a map earlier |
| 2 | contract | Where `registerOntologies` is imported from | The package object (`../package.js`), like `linkedOntology` | A free function from `@_linked/core/utils/Package` taking the package name | Registrations are keyed by package; matches the existing pattern |
| 3 | contract | Shape of `data` | `{files, load}` (`load` reads the files relative to the index) | A list of files only | Maps 1:1 onto core's registration (`files`, `load`); loading needs the module URL |
| 4 | K9 | `_ontologyResource` (the ontology IRI) had a home in the data module | Dropped; nothing reads it | Keep it as a registration field | No consumer in any package (checked); the IRI stays in the data |
| 5 | K10 | A suggested prefix legal in Turtle but not as a map name (`server-utils`) | Characters outside `[A-Za-z0-9_]` become `_` before the `_2` rule | Refuse the package | Add-only builder never fails on a valid package; the result is still a legal prefix |
| 6 | K10 | Unknown top-level keys in `linked.app.json` | Refused, naming the key | Ignored | A misspelt key would otherwise be silently ignored |
| 7 | K10 | "Inside an app" for `generate-ontology` | The package is the app, or lies under it in the same git repo | Any app found walking up | A framework checkout nested in an app's folder must not write that app's map |
| 8 | K10 | The web app template is cloned from its own repo | `create-app` writes `linked.app.json` when the clone has none; the react-native template ships one | Change the template repo now | That repo is not in this step; the file reaches every new app either way |

## Progress

- Phase 1 done: generator, index, removal of stale files, entry and import rewrite, build check.
  `npx jest tests/unit/ontologyGenerator.test.ts`: 78 passed; `tsc --noEmit` clean.
- Phase 2 done: template, `create-package`, `create-ontology`. Unit suite after `npm run build`:
  1301 tests, all pass (the four scaffold tests updated to the layout).
