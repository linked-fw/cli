---
date: 2026-10-24
summary: >
  `linked generate-ontology` writes a package's ontology accessor modules from its Turtle: per
  prefix in `package.json` `"linkedOntologies"`, a terms module (`<prefix>.ts`, one pure
  `export const Term = ns('Term')` per subject in the namespace, sorted, JSDoc from
  rdfs:comment/label), a data module (`<prefix>.data.ts`: `ns`, `dataFiles`, `loadData`,
  `_ontologyResource`, `Prefix.add`) and the register module. No aggregated object. `linked build`
  fails on a stale module. On schema.org: 2,802 terms, a 402,091-byte module, and an esbuild bundle
  of `schema.Person` alone of 1,868 bytes (125,759 with every term). The SSR shim no longer empties
  `@_linked/cli/*` under Vitest (CN backlog 130).
---

# 027 — Ontology accessor generator

## Decisions

Owner's decisions (2026-10-24), as given: generate the accessor module from the Turtle, every
subject in the namespace, named exports only, no aggregated object, generated names always win,
one fixed identifier rule, no alias map. Choices made here:

- **How a package declares its ontologies: `package.json` `"linkedOntologies"`.** One entry per
  prefix: `{"<prefix>": {"namespace": "<IRI>", "data": ["<file>.ttl", …]}}`, `data` naming files in
  `src/data/` and defaulting to `["<prefix>.ttl"]`. The existing registration could not be the
  source: the namespace and the data files live in TypeScript (`createNameSpace(base)`,
  `dataFiles = [...]`, written three different ways across the packages), which the generator
  would have to parse, and the Turtle's own `@prefix` lines are ambiguous (`rdf.ttl` declares
  `rdfs:` too). The config covers every case:

  | Package | Entries |
  |---|---|
  | schema | `schema` (`schema.ttl`, `schema-added.ttl`) |
  | rdfs | `rdf`, `rdfs` |
  | owl, xsd, dcat, org | one each, default data |
  | dcmi | `dc` (`dcelems.ttl`), `dcterms`, `dcmitype` |
  | sioc | `sioc` (`sioc.ttl`, `sioc-types.ttl`; the `sioc_t:` subjects are not in its namespace) |
  | a CN project ontology package | `<ontologySlug>` (its scaffold already names the file `<slug>.ttl`) |

- **Several namespaces in one package: one entry each**, each with its own three modules and only
  the subjects of its own data files under its own namespace.
- **The sibling is `<prefix>.data.ts`**, next to `<prefix>.register.ts`. The generator writes all
  three modules, so the namespace exists once (the config) and the stale check covers all of them.
  The register module now imports its helpers from the data module; the terms module imports only
  `ns`, renamed (`ns as ns_`) when a term is itself called `ns`.
- **What a term is.** A named subject whose IRI is the namespace plus a non-empty local name
  without `/`, `#` or `?`. The namespace IRI itself (the ontology), blank nodes and objects that are
  never subjects are not terms. A deeper path is listed by the command rather than flattened into a
  name.
- **The identifier rule** (`ontologyIdentifier`): a character that cannot appear in an identifier
  (Unicode `ID_Start`/`ID_Continue`, plus `$`) becomes `_`; a leading digit gets a leading `_`; a
  reserved word (ES keywords, strict-mode future reserved words, `null`/`true`/`false`,
  `eval`/`arguments`, the CommonJS bindings `exports`/`require`/`module`/`__esModule`, and the
  keys core's `linkedOntology` adds to the terms, `_ns`/`_prefix`/`_load`/`_data`) gets a trailing
  `_`. A collision after the rule is refused, naming the terms;
  nothing is renamed to resolve it.
- **The doc line**: `rdfs:comment`, else `rdfs:label` (English, then no language, then by language
  tag, then by value); HTML tags, `[[Term]]` and Markdown links reduced to their text, literal `\n`
  and whitespace collapsed, cut after the first sentence (not after `e.g.`/`i.e.`/`etc.`) and at 160
  characters on a word boundary with `…`; `*/` escaped, a leading `@` escaped. No line when there
  is no text or it only repeats the name.
- **Tree-shaking**: every initializer is `/*#__PURE__*/ ns('Term')`. The data module keeps its
  `Prefix.add` side effect.
- **One generator.** `@_linked/cli/utils/ontologyModules` is pure (no Node, no parser), so CN's
  browser-side `useCodeGenerator` can import it: it takes `{prefix, namespace, dataFiles,
  terms}` with `terms: {localName, label?, comment?}[]`. `@_linked/cli/utils/ontologyTerms`
  selects the terms: `ontologyTermsFromQuads` is pure, and `ontologyTermsFromTurtle` parses with
  `n3` (now a cli dependency, loaded by a variable specifier) or with a `Parser` the caller passes.
  CN should feed the Turtle it writes through the same selection (with its own statically
  imported n3 in the browser) rather than map its draft by hand: `linked build` checks against
  that selection, so a term the draft lists differently (an individual, another label) would read
  as stale.
- **CN backlog 130 (the SSR shim under Vitest).** Reproduced in a CN worktree:
  `import {buildPackageFiles} from '@_linked/cli/utils/packageFiles'` in a Vitest test was
  `undefined`. CN's Vitest inlines `@_linked/*`, so the shim's own `export * from
  '@_linked/cli/x'` came back to the resolver, which handed it the shim again: a module
  re-exporting itself. The resolver now lets an import made by the shim resolve as usual
  (`ssrNodeShimId`). Under `linked start` that import never reaches the resolver (`ssr.external`
  names the cli), so nothing changes there.

## What changed

- `src/utils/ontologyModules.ts` (new): the identifier rule, collisions, the doc line, and the
  three module generators.
- `src/utils/ontologyTerms.ts` (new): terms, labels and comments from Turtle.
- `src/utils/generateOntology.ts` (new): `linkedOntologies` validation, generation, writing, the
  stale check and the build step.
- `src/cli.ts`: `linked generate-ontology [--check]`.
- `src/cli-methods.ts`: `linked build` starts with **Checking ontology modules**.
- `src/vite-config.ts`: `ssrNodeShimId`.
- `package.json`/`package-lock.json`: `n3 ^2.13.12` (already locked as core's dependency).
- README §Ontology accessor modules, §Package flags.
- Tests: `tests/unit/ontologyGenerator.test.ts` and the fixture `tests/fixtures/ontology-generator`
  (two namespaces, golden modules); `ssrExternal.test.ts` (the shim's re-export);
  `esmSpecifiers.test.ts` (the step list).

## Measurements

Dry run on `@_linked/schema`'s real data (`schema.ttl` 991,635 bytes plus `schema-added.ttl`), in
a scratch copy of the package, with the built cli:

```
schema: 2802 terms from src/data/schema.ttl, src/data/schema-added.ttl
Wrote src/ontologies/schema.ts, src/ontologies/schema.data.ts, src/ontologies/schema.register.ts
real 1.04
```

- **Terms: 2,802** (the hand-written module has 132, all of them among the generated names; it
  also exports `ns`, `dataFiles`, `loadData`, `_ontologyResource` and the `schema` object).
- **Module size: 402,091 bytes** (95,376 gzipped); `schema.data.ts` 911, `schema.register.ts` 694.
  A second run writes nothing and the hash is unchanged (`c51c1ddd…`).
- **Tree-shaking**, the modules compiled with `tsc` (es2018), bundled with esbuild 0.28.2 `--bundle
  --minify --format=esm --platform=browser` against the localized core:

  | Entry | Bytes | gzip |
  |---|---|---|
  | `import * as schema …; console.log(schema.Person)` | 1,868 | 771 |
  | `import {ns} from './schema.data.js'` (baseline: core's `Prefix`, `createNameSpace`) | 1,850 | 762 |
  | `console.log(schema)` (every term) | 125,759 | 38,650 |

  `schema.Person` costs 18 bytes over the baseline. A Vite 6 (Rollup) library build of the same
  entry is 3,892 bytes unminified and holds `"Person"` and no other term.
- **Name collisions after the rule: none**, in any vocabulary package. Renamed names: schema
  `3DModel` → `_3DModel`, `yield` → `yield_`; dcterms `ISO639-2` → `ISO639_2`, `ISO639-3` →
  `ISO639_3`. Term counts: rdf 18, rdfs 15, owl 77, xsd 39, dc 15, dcterms 98, dcmitype 12, dcat 52,
  org 45, sioc 99. No package has a subject under its namespace that is not a term.
- **Build cost**: the check parses the data on every `linked build`; for schema about 0.1 s of
  parsing (1.0 s for the whole command, node start included).

## Review fixes

Two independent read-only reviews found nothing high-severity. Fixed:

- **Medium — the Turtle reader in a browser.** A bare `import('n3')` does not resolve in a browser.
  The selection is now the pure `ontologyTermsFromQuads`, `ontologyTermsFromTurtle` takes an
  optional `Parser`, and the dynamic import carries `@vite-ignore`/`webpackIgnore`.
- **Medium — the `sources` option.** It changed the header, so a module generated with it always
  failed the build check. It is removed: the header always names the data files.
- **Medium — the doc cut split surrogate pairs.** In CJK comments without spaces, the cut could
  leave half a pair. That half was written as U+FFFD, so the module read as stale forever. The cut
  is now by code point, and lone surrogates become U+FFFD in literals, docs and the header before
  writing.
- **Medium — names a CommonJS build binds** (`__esModule`, `exports`, `require`, `module`). tsc
  refuses them, or the emitted module throws. They are now reserved.
- **Low, fixed:**
  - `_ns`/`_prefix`/`_load`/`_data` are reserved, because core's registration would overwrite them.
  - Prefixes that differ only in case are refused.
  - A namespace must end in `/`, `#` or `:`.
  - Duplicate terms are sorted before deduplicating.
  - A module without terms has no unused import.
  - The Unicode-table dependence (the Node version's ICU) is documented.
  - Quads are collected in a loop, not with `push(...)`.
- **Low, left:**
  - Modules of a prefix removed from `linkedOntologies` are not reported (follow-up below).
  - The shim's own re-export resolves as usual instead of being forced external. Under `linked
    start` it is externalized before the resolver runs, and under Vitest a resolved copy is what
    is wanted.
  - Importing a package root keeps every term (`<prefix>.register.ts` does `import * as terms`), as
    the old self-registering module did. Only `import * as x from '<pkg>/ontologies/x'` without the
    root tree-shakes.

## Gate

- `npx jest --config jest.config.cjs`: "Test Suites: 90 passed, 90 total / Tests: 1038 passed,
  1038 total".
- `npx linked build`, then the built cli on itself: "✔ Checking ontology modules … ✔ Build
  successful".
- `npm run test:e2e` (the build steps changed): "6 passed (1.2m)".
- CN Vitest probe, a temporary test in a CN worktree, since removed:
  - `import {buildPackageFiles} from '@_linked/cli/utils/packageFiles'` gave "1 failed" with the old
    `vite-config` and passed with this one;
  - the generator imported and ran under jsdom: "2 passed".

## Follow-ups

- Rewrite the vocabulary packages to `linkedOntologies` and the generated modules, and their
  consumers to `import * as` and the generated names (the next step; consumers of `schema.ns`,
  `loadData`, `dataFiles` move to `<prefix>.data`).
- Switch CN's `ontologyCodeGenerator` to `@_linked/cli/utils/ontologyModules`, and the cli's
  `create-ontology` / `create-package --kind ontology` scaffold to the same three modules plus a
  `linkedOntologies` entry. Both together: CN's test compares its output to the scaffold.
- Report or remove the modules of a prefix dropped from `linkedOntologies` (in
  `linked generate-ontology --check`).
- CN backlog 130 can be closed once CN installs this cli; its test workaround
  (`lib/esm/utils/packageFiles.js` by path) can then go.

## PR

### Summary

Vocabulary packages ship their terms twice: as Turtle and as a hand-written accessor module, and
the two drift apart. `linked generate-ontology` generates the accessor modules from the Turtle, and
`linked build` fails when the committed ones are stale.

### Changes

- **`linked generate-ontology [--check]`.** It reads each prefix in `package.json`
  `"linkedOntologies"` (`{"<prefix>": {"namespace": "<IRI>", "data": ["<file>.ttl"]}}`, with `data`
  defaulting to `<prefix>.ttl`). For each one it writes three modules:
  - `src/ontologies/<prefix>.ts`: one `export const Term = /*#__PURE__*/ ns('Term')` per subject in
    the namespace, sorted, each with a JSDoc line;
  - `<prefix>.data.ts`: `ns`, `dataFiles`, `loadData`, `_ontologyResource`, `Prefix.add`;
  - `<prefix>.register.ts`.

  There is no aggregated object. Names follow one rule: an invalid character becomes `_`, a leading
  digit gets a leading `_`, a reserved word gets a trailing `_`. Collisions are refused.
- **`linked build`** now starts with **Checking ontology modules**.
- **For create-now:** `@_linked/cli/utils/ontologyModules` (pure) and
  `@_linked/cli/utils/ontologyTerms` (`ontologyTermsFromQuads`, `ontologyTermsFromTurtle`).
- **The dev SSR shim** no longer re-exports itself when Vitest inlines `@_linked/cli/*`. Before,
  that made a cli helper `undefined` in an app's Vitest run (create-now backlog 130).
- **`n3`** is now a cli dependency.

### Verification

- Unit tests: "Tests: 1038 passed, 1038 total".
- Build: "✔ Build successful".
- e2e: "6 passed (1.2m)".
- On schema.org's real data:
  - 2,802 terms and a 402,091-byte module; a second run writes nothing.
  - An esbuild bundle of `schema.Person` alone is 1,868 bytes, against 1,850 with no terms and
    125,759 with every term.
  - No vocabulary package has a name collision.

### Deviations

- The generator also writes the data and register modules, so the namespace lives only in the
  configuration.
- The `create-ontology` scaffold is unchanged. It switches together with create-now's generator.

### Follow-ups

All recorded in this report's §Follow-ups:

- rewrite the vocabulary packages and their consumers;
- switch create-now's generator and the scaffold;
- report the modules of a dropped prefix;
- close create-now backlog 130.
