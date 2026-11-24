---
date: 2026-11-10
summary: >
  A `linkedOntologies` entry may name its module (`"module"`, default the name) and keep its
  modules written by hand (`"generated": false`): nothing generated or compared, vann data still
  required. A pure `readOntologyConfigs` gives any tool `{name, namespace, module, generated,
  data}` per ontology. Minor.
packages: [cli]
---

# 051 — Ontology module names and hand-written modules

## PR

### Summary

`"linkedOntologies"` is the one declaration of a package's ontologies, including those whose
modules hold more than the generator writes (grouping objects, extra exports, terms kept out of
module scope). Two optional keys per entry:

- `"module"`: the modules' file name in `src/ontologies/` without extension, so the public import
  path `<package>/ontologies/<module>` follows from the declaration. Default: the name. Same
  pattern as a name. A generated entry may set it too; its files are then `<module>.ts`,
  `.data.ts`, `.register.ts`, and the registration still uses the name.
- `"generated": false` (default `true`): `linked generate-ontology` writes nothing for the entry
  and the build's staleness check skips it, but its data must carry the vann triples (same message
  as a generated ontology), and two entries with one module are refused.

```json
"linkedOntologies": {
  "core": {"namespace": "https://example.org/core/", "module": "linked-core", "generated": false}
}
```

### Changes

- `src/utils/ontologyConfig.ts` (new, pure: no `fs`, no `n3`): `OntologyConfig` `{name,
  namespace, data, module, generated}`, `ONTOLOGIES_KEY`, `ONTOLOGY_NAMESPACE`,
  `readOntologyConfigs(pkgJson)` (validates `module` and `generated`, refuses one module for two
  entries). Moved from `generateOntology.ts`; `cli.ts`, `packageFiles.ts` and the tests import it
  from here.
- `src/utils/ontologyModules.ts`: `OntologyModuleSpec.module?`; file names and the modules'
  imports use it, `linkedOntology(…, '<name>', …)` the name.
- `src/utils/generateOntology.ts`: passes `module`; an entry with `generated: false` yields no
  files but its vann data is read and checked; the staleness error names the `"generated": false`
  option.
- `src/cli.ts`: `generate-ontology` help names the module and the option; a hand-written entry
  prints `(modules written by hand: vann data checked, nothing generated)`; the `--check` error
  names the option.
- README "Ontology accessor modules": the two keys, an example, `readOntologyConfigs`.
- Tests (`tests/unit/ontologyGenerator.test.ts`): config defaults and values; refusals of a bad
  `module`, `../x`, a non-boolean `generated`, two entries with one module; a hand-written entry
  (edited module, missing module and an extra export pass; no files; nothing written; without vann
  data the build fails with the generated ontology's message); the staleness message names the
  option; a `module` other than the name (files renamed, imports follow, registration by name).
- Changeset `.changeset/ontology-module-and-hand-written.md` (minor).

### Verification

- `linked build` → `✔ Build successful`.
- `npm test`: unit `Test Suites: 104 passed, 104 total`, `Tests: 1297 passed, 1297 total`; e2e
  `7 passed (1.3m)`.
- `generate-ontology --check` in `_linked-schema` (master tree), unchanged:
  `schema: 3023 terms from src/data/schema.ttl, src/data/schema-added.ttl` /
  `Every ontology module is current.` (exit 0); `git status --short` empty.
- A copy of the test fixture with `"ex": {…, "generated": false, "module": "linked-ex"}` and
  `ex.register.ts` deleted, `generate-ontology --check`:
  - with vann data (exit 0): `ex: 8 terms from src/data/ex.ttl, src/data/ex-extra.ttl (modules
    written by hand: vann data checked, nothing generated) …` / `Every ontology module is current.`
  - vann triples removed (exit 1): `ontology-generator-fixture: the ontology "ex" (src/data/ex.ttl,
    src/data/ex-extra.ttl) has no suggested prefix: <https://example.test/ex/> has no
    vann:preferredNamespacePrefix. Its owl:Ontology node must carry its suggested prefix and its
    namespace, for example: …`

### Deviations

- The plan's `"modules": "manual"` became `"module"` plus `"generated": false`, as the master
  changed the scope during the step (an ontology's module path must follow from its declaration).
- "Duplicate name": JSON keys are unique and names lowercase, so two equal names cannot occur; the
  check that can fire is two entries with one module, which is refused.
- The config reader moved to a module of its own so it carries no `fs`/`n3` import; consumers of
  `readOntologyConfigs`, `OntologyConfig`, `ONTOLOGIES_KEY` or `ONTOLOGY_NAMESPACE` from
  `utils/generateOntology` import them from `utils/ontologyConfig` (stated in the changeset).

### Follow-ups

- The packages whose ontology modules are written by hand declare them with `"generated": false`
  and their `module`, and get their vann data: the plan that changes those packages (its step on
  the linked vocabularies).
- A host app reading ontology declarations uses `readOntologyConfigs`: tracked in the host app's
  own plan.

## Details

- `module` defaults to the name in `readOntologyConfigs`, so every reader gets the module without
  re-deriving it; `OntologyModuleSpec.module` stays optional so the scaffold and existing callers of
  the pure generator are unchanged.
- A hand-written entry's data files must exist and are parsed in full (terms are counted), so a
  wrong `data` list fails the build the same way as for a generated one.
- The stale old files of an entry whose `module` changes are not deleted by `generate-ontology`;
  the build does not compare them, and the author removes them with the rename.
