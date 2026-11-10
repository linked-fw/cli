---
"@_linked/cli": major
---

One ontology index per package, and an app's own prefix map in `linked.app.json`.

**Ontology modules (breaking).** `linked generate-ontology` writes, per package:

- `src/ontologies/<module>.ts` for each generated ontology: only its terms, each `export const Term = {id: '<namespace>Term'};` (the value `createNameSpace(namespace)('Term')` returns). It imports nothing; use `createNameSpace` from `@_linked/core/utils/NameSpace` where code needs a namespace function.
- `src/ontologies/index.ts`: imports every ontology module of the package (those with `"generated": false` too) and registers them all with one `registerOntologies([{name, namespace, terms, data, suggestedPrefix}], import.meta.url)` call. `registerOntologies` comes from the package's `src/package.ts` (`linkedPackage(...)`), so it needs the `@_linked/core` major that provides it.
- The package entry (`src/index.ts[x]`) imports `./ontologies/index.js`; side-effect imports of a removed `<module>.register.js` become an import of the index.
- `<module>.data.ts` and `<module>.register.ts` are no longer generated: the command removes the ones it wrote before. Their exports (`ns`, `dataFiles`, `loadData`, `_ontologyResource`) are gone; import `createNameSpace` from core instead of `ns`.
- `linked build`'s ontology check also fails when the entry does not import the index or such a file is left. Run `linked generate-ontology` and commit the result.
- A module written by hand (`"generated": false`) no longer registers itself: the index does.
- `create-package --kind ontology` and `create-ontology` write this layout; the package template's `src/package.ts` exports `registerOntologies` instead of `linkedOntology`.
- The build's shape check expects a package's ontologies to register through `ontologies/index.js` (or `src/ontologies/index.ts` before it is built).
- `@_linked/cli/utils/ontologyModules`: `generateOntologyModules(specs, handWritten?)` returns every module of a package (terms modules and `src/ontologies/index.ts`); new `generateOntologyIndexModule`; `generateOntologyDataModule` and `generateOntologyRegisterModule` are removed; `OntologyModuleSpec.ontology` is removed. `generatePackageOntologies` returns `{ontologies, files, edits, remove}`.

**`linked.app.json` (new).** An app's declarative settings at its root: `{"$schema": "https://linked.cm/schema/app/1.json", "schemaVersion": 1, "prefixes": {"<prefix>": "<namespace>"}}`. The schema ships as `schema/app/1.json`; an unknown `schemaVersion` or key is refused; a prefix is `^[A-Za-z][A-Za-z0-9_]*$`.

- `linked prefixes` adds a prefix for every installed ontology whose namespace the map lacks: its suggested prefix (from its vann data), or `<prefix>_2`, `_3`, … when taken. It never changes or removes an entry, and creates the file when the app has none. `linked generate-ontology` runs it for the app the package belongs to (same git repository).
- The map is loaded into core (`Prefix.load`) at server start (`linked start` and a compiled server) and in the browser bundle (the `linked:app-prefixes` Vite plugin of `createViteConfig`; the client entry imports it first). An app with no `linked.app.json` loads nothing; a core without `Prefix.load` is warned about and left as it is.
- `linked create-app` writes `linked.app.json` and fills it after the install; the React Native template's API service has one.
