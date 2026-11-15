---
'@_linked/cli': minor
---

A new package's `package.json` keeps its empty `description` and `author` (`{name, email, url}`) for the user to fill in; `buildPackageFiles` fills what it is given (`description`, default the ontology's; `author` fields, default `url` the ontology's creator). `create-package`, `create-ont-package` and `create-asset-package` take `--author-name`, `--author-email` and `--author-url` (replacing `--author`) and `--yes` (`-y`), which asks nothing: flags and defaults only. `create-ontology` takes the ontology flags (`--title`, `--description`, `--prefix`, `--creator`, `--maintainer`, `--status`) and `--yes` too, and asks the title, description and prefix on a terminal.
