---
'@_linked/cli': minor
---

`linked create-package` scaffolds an ontology package, an asset package or both; a new app is not a package.

- **Two kinds of package.** An ontology package `<name>-ont` holds exactly one ontology (`src/ontologies/<name>.ts` and its register sibling) and no shapes, components or backend. Its ontology slug is `<name>`, without `-ont`, so its terms mint `https://linked.cm/ont/<name>/{Term}` (or `<uri_base>{Term}` when a namespace is given). An asset package `<name>-assets` holds shapes, components and a backend (`src/shapes`, `src/backend.ts`, the barrels) and no ontology. Both are ordinary linked packages (`linkedPackage: true`).
- **`linked create-ont-package <name>`** and **`linked create-asset-package <name>`** create one kind each. **`linked create-package <name>`** asks which on a terminal; `--kind ontology|assets|both` answers it, and `both` creates the pair. Without a terminal and without `--kind` it exits 1 and names the flag, as `--location` does. `--kind both` refuses `--remote`: one repository cannot hold two packages. `--location`, `--remote` and `--push` work for all three commands, and `--skip-install` writes the files only.
- **The suffix is never doubled:** `create-ont-package foo-ont` creates `foo-ont`, and `@acme/foo` becomes `@acme/foo-ont`.
- **`linked create-app` no longer rewrites `src/package.ts`.** A new app is a `linkedApp`, not a linked package: its root registers no package, so `create-app` stamps `package.json`, the env files and the process names and leaves `src/` alone.
- **`create-shape`, `create-component`, `create-set-component` and `create-ontology` refuse at an app root** (no `src/package.ts`) with `run this inside a package (packages/<name>)`, instead of writing a file whose `../package.js` import cannot resolve.
- The templates moved with the kinds: `defaults/package/` is the asset package, whose manifest, tsconfigs, dotfiles and `src/package.ts` every kind shares, and `defaults/package-ontology/` holds the example ontology. The template files create-now reads from `defaults/package/` (`package.json`, the tsconfigs, `src/shapes/index.ts`, `src/backend.ts`) are where they were.
- `create-component` and `create-set-component` resolve their templates from the built CLI again (they looked one directory too high).
