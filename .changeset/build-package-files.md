---
'@_linked/cli': minor
---

New `buildPackageFiles(packageName, kind, {uriBase?, baseUri?, dependencies?})` in `@_linked/cli/utils/packageFiles`: the files `linked create-package --kind ontology|assets` produces, as package-relative path → content, without writing, prompting or installing. Dotfiles come under their real names (`.gitignore`, `.npmignore`), `baseUri` is declared as a literal in `src/package.ts`, and `dependencies` are merged into the template's `package.json`. `create-package` now writes exactly what it returns, so its output is unchanged.
