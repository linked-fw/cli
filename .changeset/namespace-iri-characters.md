---
"@_linked/cli": patch
---

`linkedOntologies` namespaces and the namespaces of `linked.app.json` prefixes refuse the characters that cannot appear in a SPARQL or Turtle IRI (`<`, `>`, `"`, `{`, `}`, `|`, `^`, backtick, backslash, whitespace and control characters). `NAMESPACE_IRI` is exported from `utils/ontologyConfig`.
