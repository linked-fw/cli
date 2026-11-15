---
'@_linked/cli': minor
---

A new ontology package's template carries the ontology's metadata. `buildPackageFiles(name, 'ontology', {ontology, author})` and `linked create-package` / `create-ont-package` (`--title`, `--description`, `--prefix`, `--creator`, `--maintainer`, `--status`, `--author`) write them into `src/data/<name>.ttl`: `dcterms:title` (default: the name in words), `dcterms:description`, `vann:preferredNamespacePrefix` (default: the name; also the generated modules' `suggestedPrefix`), `dcterms:creator`, `schema:maintainer` (default: the creator) and `adms:status` (default: `core:Draft`). On a terminal the title, description and prefix no flag gave are asked. `author` sets `package.json` `author` (default: the creator as its url). The template's empty `author` placeholder and the data file's unused `dc:` prefix are gone, and `.npmignore` ends in a newline. `create-ontology` writes the same data file with the defaults.
