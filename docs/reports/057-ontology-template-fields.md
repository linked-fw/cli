---
date: 2026-11-15
summary: >
  The ontology package template carries the ontology's metadata: buildPackageFiles takes
  `ontology` (title, description, prefix, creator, maintainer, status) and `author`, and
  create-package / create-ont-package take them as flags (asked on a terminal: title,
  description, prefix). The data file is generated (`ontologyScaffoldTurtle`), the modules
  suggest the prefix. Template leftovers removed. Minor.
packages: [cli]
---

# 057 — The ontology template's fields

## Summary

A new ontology states a title, a preferred prefix, its creator and maintainer and a status. The
template wrote only the prefix (always the name) and left the rest to the host, which had to
rewrite the data file and regenerate the modules after `buildPackageFiles`. The template now
carries every field, each with a default, so one place defines a new ontology's files and a
host only fills values in.

## PR

**What changed**

- `src/utils/ontologyScaffoldTurtle.ts` (new): `ontologyScaffoldTurtle(name, namespace, fields)`
  writes `src/data/<name>.ttl`: the own prefix first, then `rdf`, `rdfs`, `owl`, `xsd`, `dcterms`,
  `skos`, `schema`, `vann` (a prefix equal to one of these replaces it); one subject, `a
  owl:Ontology` then the predicates by IRI; literals `@en`, escaped; a full IRI where no prefix
  covers it. `resolveOntologyFields` fills the defaults and refuses a bad prefix, a creator or
  maintainer that is not an absolute IRI, an unknown status. `ONTOLOGY_STATUSES` are
  `core:OntologyStatus`'s instances (IRIs from `coreOntology`).

  | Field | Written as | Default |
  |---|---|---|
  | `title` | `dcterms:title` | the name in words (`lego-planning` → `Lego Planning`) |
  | `description` | `dcterms:description` | none |
  | `prefix` | `vann:preferredNamespacePrefix`, Turtle prefix, modules' `suggestedPrefix` | the name |
  | `creator` | `dcterms:creator` | none |
  | `maintainer` | `schema:maintainer` | the creator |
  | `status` | `adms:status` | `Draft` |

- `src/utils/packageFiles.ts`: `PackageFilesOptions.ontology` and `.author` (`PackagePerson`).
  The data file is generated, no longer a template; `ontologyScaffoldModules` takes the prefix.
  `author` goes right after `description`; without it an ontology package with a creator gets
  `{url: creator}`, any other package none.
- `src/utils/packageMetadata.ts` (new): `parsePackagePerson` (npm's `Name <email> (url)`, or a
  bare IRI as the url), `ontologyStatusFlag` (case-insensitive), `ontologyFieldsFromFlags`.
- `src/cli.ts`, `src/cli-methods.ts`: `--title`, `--description`, `--prefix`, `--creator`,
  `--maintainer`, `--status` on `create-package` and `create-ont-package`; `--author` on all three
  scaffolding commands. Flags are checked before anything is asked or written. On a terminal the
  title, description and prefix no flag gave are asked (Enter keeps the default); without one the
  defaults apply. `create-ontology` writes its data file with the same generator.
- Template leftovers: `defaults/package/package.json` loses its empty `author` placeholder;
  `defaults/package-ontology/src/data/example-ontology.ttl` (with its unused `dc:` prefix) is gone;
  `npmignore.template` ends in a newline.
- `README.md`: the fields table and `buildPackageFiles`' new options.
- Tests: `tests/unit/ontologyScaffoldTurtle.test.ts` (new: the exact Turtle with defaults and with
  every field, escaping, a prefix equal to a fixed one, refusals, the flag parsers, the fields
  through `buildPackageFiles`, the module check with a custom prefix, `author` placement and
  defaults, the leftovers, `create-package` flags equal to `buildPackageFiles` options, a bad flag
  refused before anything is written); the expected Turtle updated in `packageFiles`,
  `createPackageScaffold` and `createInsidePackage`.

**Verification**

- `npx jest --config jest.config.cjs` (full unit set, 258 s):
  `Test Suites: 107 passed, 107 total` / `Tests: 1338 passed, 1338 total`.
- The four touched suites alone (18 s): `Test Suites: 4 passed, 4 total` / `Tests: 50 passed, 50 total`.
- `tsc -p tsconfig-esm.json --noEmit`: clean; `npm run build`: clean.
- A host that writes the same ontology through its own Turtle writer and module generator was
  compared file by file with `buildPackageFiles` given the same values (a title with quotes, a
  two-line description, a creator, and a second case with no description and the prefix
  `schema`): every file identical except `.npmignore`, which now ends in a newline.

**Deviations**

- The data file is generated in code rather than filled from a template file: optional lines and
  a prefix that may equal a fixed one do not fit `${…}` substitution.
- No `--namespace` flag: the namespace is the existing `[uri_base]` argument (`uriBase`).
- `tsconfig.json` keeps `src/backend.ts` in `include` (the package may grow beyond an ontology) and
  `"jsx": "react"`: the file is shared by every kind, and the setting is harmless where no `.tsx`
  exists.

**Follow-ups**

- `create-ontology` takes none of the new flags; it writes the defaults. Recorded here; add them
  if a caller needs them.

## Addendum (2026-11-15): review round

After review:

- **The template's empty fields stay.** `defaults/package/package.json` has its
  `"author": {"name": "", "email": "", "url": ""}` again, beside the empty `description`, for every
  kind: suggestions for the user to fill in. `buildPackageFiles` fills what it is given:
  `description` (new option; default: the ontology's description), and `author`, whose given
  fields replace the empty ones (default `url`: the ontology's creator). `withAuthor` became
  `filledPerson`.
- **Every field has a flag; `--yes` asks nothing.** `--author "Name <email> (url)"` is replaced by
  `--author-name`, `--author-email` and `--author-url` (checked: an email, a URL), on the three
  package commands. `--yes` (`-y`) on those and on `create-ontology` treats the run as having no
  terminal: flags and defaults only, a missing `--kind` or `--location` refused. `create-ontology`
  now takes the ontology flags too and asks the title, description and prefix on a terminal.
  `--description` is also the new package's `package.json` description.
- README: the flags table gains the author flags and the `package.json` fields, with an example
  of a fully flagged, non-interactive `create-package`.
- Tests (`tests/unit/ontologyScaffoldTurtle.test.ts`): the author flags and their refusals,
  `description` and `author` filled into the template's empty fields for both kinds, `--yes` on a
  terminal refusing a missing `--kind` and writing the defaults, `create-ontology` with flags.

**Verification**

- `npx jest --config jest.config.cjs` on the touched suites (`ontologyScaffoldTurtle`,
  `packageFiles`, `createPackageScaffold`, `createInsidePackage`, `createPackageLocation`,
  `packageKind`; 4.7 s): `Test Suites: 6 passed, 6 total` / `Tests: 76 passed, 76 total`.
- `tsc -p tsconfig-esm.json --noEmit`: clean; `npm run build`: clean.
