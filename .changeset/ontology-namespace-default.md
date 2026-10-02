---
'@_linked/cli': minor
---

`create-package` and `create-ontology` scaffold new ontologies at `https://linked.cm/ont/{slug}/` instead of the legacy `http://lincd.org/ont/{name}/`, matching the first-party packages (arch-02). The slug is derived the way core derives a package's publicSlug: the npm scope is dropped and the rest kebab-cased, so `linked create-package @_linked/foo` now gets `https://linked.cm/ont/foo/` (it used to get `http://lincd.org/ont/@_linked/foo/`). An explicit `uri_base` argument still wins, which is how a private package gets its workspace-scoped root (`https://{workspaceSlug}.id.create.now/ont/{slug}/`); a `uri_base` that already ends in `/` or `#` is no longer given a second `/`.
