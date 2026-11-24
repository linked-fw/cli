---
"@_linked/cli": minor
---

Ontologies are keyed by their name within the package, and their suggested prefix is data.

- `package.json` `"linkedOntologies"` is keyed by the ontology's **name** (lowercase letters and digits, single `-` or `_` between them). The name names the modules (`src/ontologies/<name>.ts`, `.data.ts`, `.register.ts`) and is the third argument of the generated `linkedOntology(terms, ns, '<name>', loadData, dataFiles)`. It is no longer a prefix.
- `linked generate-ontology` reads the suggested prefix from the `vann:preferredNamespacePrefix` of the ontology's `owl:Ontology` node and writes `Prefix.add('<that prefix>', '<namespace>')` in `<name>.data.ts`.
- **A package without vann data now fails its build** (and `linked generate-ontology`): every ontology's `owl:Ontology` node must carry exactly one `vann:preferredNamespacePrefix` and one `vann:preferredNamespaceUri` equal to its configured `namespace`. The message names the package, the ontology and its files, and shows the triples to add. To fix it, add to one of the ontology's data files (for a published vocabulary shipped unedited, a `src/data/<name>-added.ttl` listed in its `data`):

  ```turtle
  @prefix owl: <http://www.w3.org/2002/07/owl#> .
  @prefix vann: <http://purl.org/vocab/vann/> .

  <http://example.org/ont/> a owl:Ontology ;
      vann:preferredNamespacePrefix "ex" ;
      vann:preferredNamespaceUri "http://example.org/ont/" .
  ```

  Write the prefix the package registers today, so its Turtle output does not change, then run `linked generate-ontology`.
- `create-package --kind ontology` and `create-ontology <name>` write both triples (the name as the prefix).
- API of `@_linked/cli/utils/ontologyModules` and `ontologyTerms`: `OntologyModuleSpec.prefix` is replaced by `name` and `suggestedPrefix`; `ONTOLOGY_PREFIX` by `ONTOLOGY_NAME` (lowercase only) and `SUGGESTED_PREFIX`; `OntologyConfig.prefix` by `name`; `OntologyNameCollisionError.prefix` by `ontologyName`. `ontologyTermsFromQuads` also returns `preferredPrefixes` and `preferredNamespaces`; new `ontologySuggestedPrefix(result, namespace)` and `OntologyVannError`.
