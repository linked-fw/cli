---
date: 2026-11-10
summary: >
  `linkedOntologies` is keyed by the ontology's name within the package; the generator reads the
  suggested prefix from the ontology's vann data and writes it in the data module; `linked build`
  and `generate-ontology` refuse an ontology without that data, saying what to add. Minor.
packages: [cli]
---

# 050 — Ontology names and the vann prefix

## PR

### Summary

An ontology is found by its package and its name within the package, never by a prefix. The
`package.json` `"linkedOntologies"` key is now that name: it names the three generated modules and
is the name `linkedOntology` registers. The suggested prefix is data: the ontology's
`owl:Ontology` node carries `vann:preferredNamespacePrefix` and `vann:preferredNamespaceUri`, and
the generator writes `Prefix.add('<prefix>', '<namespace>')` from it. A package whose data lacks
those triples, or whose vann namespace is not the configured one, now fails its build with a
message naming the package, the ontology, its files and the triples to add.

### Changes

- `src/utils/ontologyModules.ts`: `OntologyModuleSpec` is `{name, suggestedPrefix, namespace,
  dataFiles, terms, ontology?}`; `ONTOLOGY_NAME` (lowercase `^[a-z0-9]+(?:[-_][a-z0-9]+)*$`)
  replaces `ONTOLOGY_PREFIX`; `SUGGESTED_PREFIX` (a Turtle prefix); the data module adds the
  suggested prefix, the register module passes the name; `OntologyNameCollisionError.ontologyName`.
- `src/utils/ontologyTerms.ts`: `ontologyTermsFromQuads` also returns the vann values of the
  ontology node it finds (`preferredPrefixes`, `preferredNamespaces`; the namespace as a literal
  or an IRI); `ontologySuggestedPrefix(result, namespace)` returns the one prefix or throws
  `OntologyVannError` with the reason. Pure, so a browser caller applies the same rule.
- `src/utils/generateOntology.ts`: `OntologyConfig.name`; the entries keyed and sorted by name;
  `generatePackageOntologies` turns an `OntologyVannError` into the build's message. The case check
  is gone: the lowercase pattern refuses two names that differ only in case.
- Scaffold: `defaults/package-ontology/src/data/example-ontology.ttl` declares both vann triples
  (the name as the prefix); `ontologyScaffoldModules(name, namespace)`, `withOntologyEntry`,
  `checkScaffoldOntology` (now lowercase) take the name; `create-ontology <name>`.
- `src/cli.ts`: `create-ontology` and `generate-ontology` help and messages speak of names.
- README: "Ontology accessor modules" and the ontology package description.
- Tests: `tests/unit/ontologyGenerator.test.ts` (a "suggested prefix" block: prefix ≠ name in the
  fixture, an IRI vann namespace, vann on another node, no owl:Ontology, no prefix, no namespace,
  two prefixes, two namespaces, a wrong namespace, an invalid prefix; two build-step tests for the
  full message); the fixture's data carries vann (`ex` suggests `exa`); the scaffold tests expect
  the vann triples and the lowercase message.
- Changeset `.changeset/ontology-names-and-vann-prefix.md`: minor, stating that a package without
  vann data now fails its build and what to add.

### Verification

- `npx linked build` → `✔ Build successful`.
- `npm test`: unit `Test Suites: 104 passed, 104 total`, `Tests: 1290 passed, 1290 total`; e2e
  `7 passed (1.3m)`.
- `node <cli>/lib/esm/launch.js generate-ontology --check`, read-only, in the vocabulary packages:
  - `_linked-schema`: `schema: 3023 terms from src/data/schema.ttl, src/data/schema-added.ttl` /
    `Every ontology module is current.` (exit 0)
  - `_linked-dcmi`: `dc: 15 terms …`, `dcmitype: 12 terms …`, `dcterms: 98 terms …` /
    `Every ontology module is current.` (exit 0)
  - `_linked-org` (exit 1):

    ```
    @_linked/org: the ontology "org" (src/data/org.ttl) has no suggested prefix: <http://www.w3.org/ns/org#> has no vann:preferredNamespacePrefix. Its owl:Ontology node must carry its suggested prefix and its namespace, for example:

      @prefix owl: <http://www.w3.org/2002/07/owl#> .
      @prefix vann: <http://purl.org/vocab/vann/> .

      <http://www.w3.org/ns/org#>
        vann:preferredNamespacePrefix "org" ;
        vann:preferredNamespaceUri "http://www.w3.org/ns/org#" .

    Add it to one of its data files (a new file goes in "linkedOntologies".org.data). For a published vocabulary shipped unedited, put it in src/data/org-added.ttl, never in the published file.
    ```
  - `git status --short` in all three: empty.

### Deviations

- `Prefix.add` keeps the namespace as a string (`Prefix.add('<prefix>', '<namespace>')`), not
  `ns('')`: core's `Prefix.add` takes two strings, and the vann namespace equals the configured one
  by the check, so the output of every package that already has vann data is byte-identical
  (schema, dcmi, dcat pass `--check` unchanged).
- The case check of names was removed rather than kept: names are lowercase now, so it could not
  fire.

### Follow-ups

- Vocabulary packages without vann data fail their build with this version: owl, rdfs (rdf,
  rdfs), sioc, xsd, org, auth, npm, and the packages whose ontology modules are still
  hand-written. They get their vann triples in the plan that changes those packages, which runs
  after this one lands.
- A consumer of `@_linked/cli/utils/ontologyModules` that calls `generateOntologyModules` must
  pass `name` and `suggestedPrefix` (reading the prefix with `ontologySuggestedPrefix`), and an
  app that writes ontology data must write the vann triples. The known consumer is a host app,
  tracked in its own plan.

## Details

### Decisions

- **The prefix is required in the spec.** The pure generator writes what it is given; reading it
  from the data is the caller's job (`ontologySuggestedPrefix`), so the browser and the build share
  one rule.
- **Which node.** Only the vann values of the ontology node `ontologyIriOf` picks (the namespace,
  else the namespace without its trailing `#`/`/`, else the only declaration it starts with) count;
  vann data on another subject is ignored.
- **Values.** The prefix must be a literal; the namespace may be a literal or an IRI (both occur
  in published vocabularies). More than one distinct value of either is refused rather than
  picked. The prefix must be a Turtle prefix (`^[A-Za-z](?:[A-Za-z0-9_.-]*[A-Za-z0-9_-])?$`), so
  existing prefixes such as `lincd-server` and `linked_core` stay valid.
- **Where to add it.** The vann triples may sit in any file of the ontology's `data`; the message
  shows them on the ontology's node (declaring the node when the data has none) and points a
  mirror to `src/data/<name>-added.ttl`.

### State of the other vocabulary packages

`--check` with this version: dcat passes; owl, rdfs, sioc, xsd, auth, npm fail with the same
message for their ontology (each lacks `vann:preferredNamespacePrefix`).
