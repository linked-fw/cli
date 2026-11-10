---
summary: linkedOntologies keyed by the ontology's name within its package; the suggested prefix is read from the ontology's vann data; the build refuses an ontology without it.
status: Implementation
---

# Ontology names and the vann prefix

## Goal

- `package.json` `"linkedOntologies"` is keyed by the ontology's **name within the package**
  (`^[a-z0-9]+(?:[-_][a-z0-9]+)*$`), which names the three modules (`src/ontologies/<name>.ts`,
  `.data.ts`, `.register.ts`) and is the third argument of the generated
  `linkedOntology(terms, ns, '<name>', loadData, dataFiles)`.
- The suggested prefix is data only: the `owl:Ontology` node of the ontology carries
  `vann:preferredNamespacePrefix` and `vann:preferredNamespaceUri`. The generator reads both and
  writes `Prefix.add('<prefix>', '<namespace>')` in `<name>.data.ts`.
- `linked build` (Checking ontology modules) and `linked generate-ontology` refuse an ontology
  whose data has no `owl:Ontology` for its namespace, no vann prefix, no vann namespace, more than
  one value of either, or a vann namespace different from the configured one. The message names
  the package, the ontology, the data files and the two triples to add.

## Decisions

1. **`OntologyModuleSpec`** becomes `{name, suggestedPrefix, namespace, dataFiles, terms,
   ontology?}`; `suggestedPrefix` is required (the pure generator writes what it is given; the
   caller reads it from the data). `ONTOLOGY_PREFIX` → `ONTOLOGY_NAME` with the lowercase pattern;
   `OntologyConfig.prefix` → `name`; `OntologyNameCollisionError.prefix` → `name`.
2. **Reading vann**: `ontologyTermsFromQuads` also returns `preferredPrefixes` and
   `preferredNamespaces` (distinct, sorted) of the ontology node it found; the namespace value may be
   a literal or an IRI. A pure `ontologySuggestedPrefix(result, namespace)` returns the prefix or
   throws `OntologyVannError` with the reason; `generateOntology.ts` adds package, ontology and
   files to the message. Pure, so a browser caller can apply the same rule.
3. **`Prefix.add`** keeps the namespace as a string literal (core's `Prefix.add(prefix: string,
   fullURI: string)`); it equals the vann namespace by the check, so existing output is unchanged.
4. **The case check** of names goes: the lowercase pattern already refuses two names equal but for
   case.
5. **Suggested prefix validity**: a Turtle prefix (`^[A-Za-z](?:[A-Za-z0-9_.-]*[A-Za-z0-9_-])?$`).
6. **Scaffold**: the example ontology template declares both vann triples with the ontology's name
   as prefix and its namespace, so a new package's first build passes.

## Files

`src/utils/ontologyModules.ts`, `src/utils/ontologyTerms.ts`, `src/utils/generateOntology.ts`,
`src/utils/packageFiles.ts`, `src/cli.ts`, `src/cli-methods.ts` (create-ontology),
`defaults/package-ontology/src/data/example-ontology.ttl`, the fixtures under
`tests/fixtures/ontology-generator/`, `tests/unit/ontologyGenerator.test.ts` and the scaffold
tests, README.

## Phases

### Phase 1: generator, configuration and build check

- Rename prefix → name in the spec, config, regexes, errors, comments.
- Read vann in `ontologyTermsFromQuads`; `ontologySuggestedPrefix`; `generatePackageOntologies`
  passes `suggestedPrefix`, throws the fix message.
- Fixtures: vann triples for `ex` (prefix `exa`, so prefix ≠ name is covered) and `other`;
  regenerated modules.
- Tests: missing vann, missing owl:Ontology, wrong namespace, two prefixes, prefix ≠ name, several
  ontologies in one package, the build step's message.
- **Validation**: `npx linked build`; `npm run test:unit -- ontologyGenerator` passes.

### Phase 2: scaffold, command text, README, verification on real packages

- Template vann triples; `ontologyScaffoldModules(name, namespace)`; create-ontology argument
  text; generate-ontology description and messages; README.
- **Validation**: `npx linked build`; `npm test`; `generate-ontology --check` passes in
  `_linked-schema` and `_linked-dcmi`, fails in `_linked-org` with the new message (read-only).

Dependencies: phase 2 needs phase 1. No parallel work.

## Follow-ups

- The host app's own call of `generateOntologyModules` passes `prefix`; it must pass `name` and
  `suggestedPrefix` (and write vann data for the ontologies it creates). Homed with the master.

## Progress

- Phase 1 done (f69a38a): generator, configuration, build check, scaffold template; unit suite
  104 suites / 1290 tests pass.
- Phase 2 done: README, stale comments; `npm test` passes (unit 1290, e2e 7);
  `generate-ontology --check` passes in schema and dcmi, fails in org with the new message.
