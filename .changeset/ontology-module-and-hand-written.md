---
"@_linked/cli": minor
---

A `linkedOntologies` entry names its module and may keep its modules written by hand.

- `"module"` (optional, the same pattern as a name, default the name) is the modules' file name in `src/ontologies/`: a generated ontology's files are `<module>.ts`, `<module>.data.ts` and `<module>.register.ts`, imported as `<package>/ontologies/<module>`. The registration still uses the name: `linkedOntology(terms, ns, '<name>', …)`. Two entries with one module are refused.
- `"generated": false` (default `true`) declares an ontology whose modules hold more than the generator writes. `linked generate-ontology` writes nothing for it and `linked build` skips its staleness check, but its data must carry the same vann triples, and the build refuses it without them:

  ```json
  "linkedOntologies": {
    "core": {"namespace": "https://example.org/core/", "module": "linked-core", "generated": false}
  }
  ```

- New pure module `@_linked/cli/utils/ontologyConfig`: `readOntologyConfigs(pkgJson)` returns `{name, namespace, module, generated, data}` per ontology, sorted by name. `OntologyConfig`, `ONTOLOGIES_KEY`, `ONTOLOGY_NAMESPACE` and `readOntologyConfigs` move there from `@_linked/cli/utils/generateOntology`.
- `OntologyModuleSpec.module` (optional) names the generated files.
