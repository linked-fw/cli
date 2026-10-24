---
'@_linked/cli': patch
---

- **`_ontologyResource` is the ontology's own IRI.** The generated data module takes it from the
  subject the data types `owl:Ontology`: the namespace, else the namespace without its trailing
  `#` or `/`, else the only declaration the namespace starts with; otherwise the namespace, as
  before. `@_linked/owl`
  and `@_linked/dcat` get `http://www.w3.org/2002/07/owl` and `http://www.w3.org/ns/dcat`
  instead of `…/owl#` and `…/dcat#`; their committed modules need regenerating.
- **The ontology scaffold is the generator's output.** `create-package --kind ontology` and
  `create-ontology` write `src/ontologies/<slug>.ts`, `.data.ts` and `.register.ts` through the
  same generator as `linked generate-ontology`, and add `"linkedOntologies": {"<slug>":
  {"namespace": …}}` to `package.json`, so the first `linked build` checks them against the
  Turtle. The hand-written `example-ontology.ts` template with its aggregated object and `_self`
  is gone. An existing `linkedOntologies` entry is kept, and a slug that is not a valid Turtle
  prefix or a namespace that is not an IRI is refused before anything is written. The package
  template's ranges are `@_linked/core` ^2.41.0 and `@_linked/cli` ^1.57.0.
- **A terms module without terms is still a module** (`export {};`), so the register module's
  `import * as terms` compiles (it failed with TS2306 for a new, empty ontology).
- The shape template's example names the namespace import
  (`import * as schema from '@_linked/schema/ontologies/schema'`).
