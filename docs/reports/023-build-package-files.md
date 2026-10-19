---
date: 2026-10-19
summary: >
  `buildPackageFiles(packageName, kind, options)` in `@_linked/cli/utils/packageFiles` returns the
  files `linked create-package --kind ontology|assets` produces as package-relative path → content,
  with no writes, prompts or install (cli 1.48.0, minor). `create-package` now writes exactly what
  it returns; its output was verified byte-identical before and after. Create Now's
  `appProjectPackages.ts` calls it instead of re-implementing the assembly to commit a project's
  packages through the GitHub API.
---

# 023 — `buildPackageFiles`: a new package's files as data

## Why

Create Now commits a project's ontology and assets packages through the GitHub API, not to a local
disk, and had re-implemented the CLI's package assembly (`src/backend/provisioners/appProjectPackages.ts`)
with two deliberate differences: a literal `baseUri` and an added dependency. Two copies of the
template logic drift. The CLI now exposes the assembly as a pure function, with options covering
both differences.

## API (cli 1.48.0)

```ts
import {buildPackageFiles} from '@_linked/cli/utils/packageFiles';

buildPackageFiles(
  packageName: string,       // used as given; packageNameFor(name, kind) adds the -ont/-assets suffix
  kind: ScaffoldKind,        // 'ontology' | 'assets'
  options?: {
    uriBase?: string;        // ontology namespace, as `create-package <name> <uriBase>`
    baseUri?: string;        // literal root in src/package.ts: linkedPackage(name, {baseUri})
    dependencies?: Record<string, string>; // merged into the template package.json
    templatesDir?: string;   // defaults to the CLI's own defaults/
  },
): Record<string, string>;   // package-relative path → content, sorted by path
```

```ts
Object.keys(buildPackageFiles('planning-ont', 'ontology', {baseUri: 'https://acme.example/'}));
// .gitignore, .npmignore, package.json, src/data/planning.json, src/data/planning.json.d.ts,
// src/index.ts, src/ontologies/planning.register.ts, src/ontologies/planning.ts,
// src/package.ts, tsconfig-esm.json, tsconfig.json
```

It reads only the CLI's `defaults/`. Dotfiles come back under their real names
(`gitignore.template` → `.gitignore`). `baseUri` is taken as given; pass a user value through
`normalizeBaseUri` first. The module also exports `cliTemplatesDir()` and `nameVariants(name)`.
It is reached through the existing `./*` subpath export, like `utils/createPackageLocation`.

## Files

- `src/utils/packageFiles.ts`: `buildPackageFiles`, `PackageFilesOptions`, `PackageFiles`,
  `cliTemplatesDir`, `nameVariants` (the one `camelCase` and name forms; `setNameVariables` uses it).
- `src/utils/shippedDotfiles.ts`: `shippedDotfileName(name)`, the shipped-name → real-name map
  `renameShippedDotfiles` also uses.
- `src/cli-methods.ts`: `scaffoldPackage` writes what `buildPackageFiles` returns; `--kind both`
  passes the `-ont` dependency through `dependencies` instead of rewriting the written
  `package.json`.
- `README.md`: a paragraph under `create-package`.

## Verification and tests

- Before the refactor, a throwaway test dumped every file `createPackage` wrote for six cases
  (ontology, assets, both, explicit uriBase, scoped `@acme/lego-elevated-planning` both, in-app
  `--location packages` with `--base-uri` and the pair's dependency). The dump after the refactor:
  `cmp ../baseline.json ../after.json` → `IDENTICAL`. The built binary's `create-package planning
  --kind both --skip-install` matched the baseline too.
- `tests/unit/packageFiles.test.ts` compares `buildPackageFiles` with what `createPackage` writes
  (each kind, explicit uriBase, in-app pair with `baseUri` + `dependencies`) and checks dotfile
  names, slug renames, the `baseUri` literal, the dependency merge, and that nothing is written.

## Limits and follow-ups

- Only the `ontology` and `assets` kinds; `both` is two calls.
- Create Now's switch to `buildPackageFiles` is done (`appProjectPackages.ts` imports it). No open
  follow-ups.

## PRs

- https://github.com/linked-fw/cli/pull/275
