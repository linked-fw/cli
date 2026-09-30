---
summary: >
  `linked create-package` produced a package that did not work: an ontology that was never
  registered, an entry-graph compile that dropped unimported modules, no `.gitignore`, and a
  `types` field that had been "fixed" into breaking node10 resolution for every package ever born
  from the template. Records why the four had to land together, why `"types": "index.d.ts"` is
  correct although it names a file that does not exist, and the retraction of the measurement
  that got it wrong — file existence used as a proxy for module resolution, which broke two
  packages before it was reverted.
---

# The package template started wrong

`5197e61`, PR [#157](https://github.com/linked-fw/cli/pull/157), merged 2026-09-30.

`defaults/package/` is what a developer gets on day one. It shipped four defects, and three of
them were invisible: a scaffolded package built successfully and was wrong anyway.

## The four defects

### 1. The ontology was never registered

A fleet-wide sweep on 2026-09-24 moved every package to importing the `.register.js` sibling
rather than the terms module. The template was **half** converted. `src/index.ts` still imported
the terms module, and `createPackage`'s rename list and variable-substitution list **both**
omitted `src/ontologies/example-ontology.register.ts`.

So `linked create-package foo` produced `src/ontologies/foo.ts`, plus a leftover
`example-ontology.register.ts` still containing a literal `${hyphen_name}`, imported by nothing.
`linkedOntology()` never ran.

The symptom lands nowhere near the cause: a consuming app boots into **`_this is not defined`**,
an error that names neither the ontology nor the package. It passed the build only because the
entry-graph compile (defect 2) never reached the orphaned file.

Fixed in three places: `index.ts` imports `./ontologies/${hyphen_name}.register.js`;
`createPackage` adds the register file to both arrays; and `createOntology` writes the
`.register.js` import for ontologies added later, so the next one does not reintroduce the gap.

### 2. The entry-graph compile

`files: ['./src/types.ts','./src/index.ts']`, `include: ['./src/backend.ts']`. A module nothing
imports is never emitted, so a scaffolded package silently shipped less than its `src/`. Replaced
with the whole-folder shape the rest of the fleet uses: `files: ['./src/index.ts']`,
`include: ['./src/**/*.ts', './src/backend.ts']`, tests and test helpers excluded, plus
`skipLibCheck: true`.

### 3. No `.gitignore`

`lib/` and `node_modules/` were committable from minute one. Adds
`defaults/package/gitignore.template`, picked up by the existing `renameShippedDotfiles` pass —
the same mechanism `npmignore.template` uses, because npm applies a nested `.npmignore` to this
CLI's own tarball.

### 4. `types` / `typesVersions` — the one that mattered

The template declared `"types": "lib/esm/index.d.ts"` **alongside**
`typesVersions: {"*":{"*":["lib/esm/*"]}}`. TypeScript applies `typesVersions` to the `types`
field as well, so it asked for `lib/esm/lib/esm/index.d.ts`. node10 resolution failed outright;
`bundler` resolution kept working off `exports` and hid it.

**Every package ever scaffolded from this template was node10-broken at its root import.**

Also in the same commit: `data.defauilt` → `data.default` in the example ontology, which made
`loadData()` resolve to `undefined` under ESM.

## Why they had to land together

Fixing the compile alone (2) converts a silent defect into a **hard build failure at birth**: a
whole-folder compile reaches the unsubstituted placeholder from (1) and fails with
`Cannot find module './${hyphen_name}.js'`. Anyone scaffolding a package between the two fixes
would have got a package that could not build at all.

That ordering constraint is the reason this is one commit rather than four, and it is the general
rule for this directory: **widening what the template compiles is only safe once everything it
will now reach is correct.**

## `"types": "index.d.ts"` is correct, and reads like a bug

The fix is the pre-image of the mapping, not the path on disk:

```json
"//types": "Correct as written, do not 'fix' it: typesVersions below is applied to the types
            field too, so \"index.d.ts\" resolves to lib/esm/index.d.ts. Writing that literal
            path applies the mapping twice (lib/esm/lib/esm/index.d.ts) and breaks node10
            resolution. Verify with ts.resolveModuleName under node10 AND bundler, not by
            looking for the file on disk.",
"types": "index.d.ts",
```

The `"//types"` key is doing real work: it carries the explanation into **every package the
template ever scaffolds**, where the next person to notice that `index.d.ts` is absent will be
standing. An explanation that lives only in this report is an explanation that reader will never
see.

Measured against a real scaffold with `ts.resolveModuleName`, TypeScript 5.4.5:

```
before  node10  -> FAILED
before  bundler -> <scaffold>/lib/esm/index.d.ts
after   node10  -> <scaffold>/lib/esm/index.d.ts
after   bundler -> <scaffold>/lib/esm/index.d.ts
```

`typesVersions` cannot simply be deleted instead: it is the only mechanism that keeps **subpath**
imports resolving under node10. Once it is present, `types` has to be written as its pre-image.

## Retraction: the diagnosis that broke two packages

This was already "fixed" the wrong way once, downstream, on the strength of a measurement that was
cheap, plausible, and inverted the answer.

**What was measured: file existence.** A backlog item in the consuming project (create-now
backlog 072) observed that 22 of 24 installed `@_linked/*` packages declare `"types":
"index.d.ts"` while no such file is present in the package directory, concluded that every node10
consumer silently types those packages as `any`, and proposed a one-line fix across **20**
separate `linked-fw/*` repositories.

**What it should have measured: module resolution.** Because `typesVersions` is applied to the
top-level `types` field, `index.d.ts` is rewritten to `lib/esm/index.d.ts` *before anything touches
the filesystem*. The missing file is the **pre-image of a mapping, not a path that is meant to
exist**.

The sweep reached two packages before it was stopped. Both then resolved under `bundler` and
**failed** under node10 — the fix opened exactly the gap it had been filed to close, and the
consuming project's own typecheck could not see it, because `bundler` resolution reads `exports`
and never consults `types`. Both were reverted.

The sentence to keep is that item's own retraction of itself:

> "Does this file exist" is a proxy for "does this module resolve". The proxy was cheap, it was
> plausible, and it inverted the answer.

## The test, and why it asserts resolution rather than layout

`tests/template/package.full.test.ts`, gated behind `RUN_TEMPLATE_FULL=1` because it needs network
and several minutes. It scaffolds with the **built** CLI into a temp dir, writes two probe modules
(`src/orphan.ts`, imported by nothing, and `src/orphan.test.ts`), installs and builds. Seven
assertions:

1. `npm run build` succeeds and emits `lib/esm/index.js`.
2. The ontology register sibling is emitted **and imported**; the `example-ontology.register.ts`
   placeholder is gone.
3. `lib/esm/orphan.js` exists — the whole-folder compile.
4. `lib/esm/orphan.test.js` does **not** — tests are still excluded.
5. No file in the scaffold contains an unsubstituted `${…}` placeholder, walking every source file.
6. `.gitignore` exists with its three entries; `gitignore.template` is gone.
7. The scaffolded package resolves under **both** `Node10` and `Bundler` via
   `ts.resolveModuleName`, against a sibling `consumer/node_modules/<pkg>` symlink.

Assertion 7 is the guard against the retraction above repeating, and its header comment says so.
That is the right shape for a regression test against a *measurement* error: it does not assert
the file layout, it asserts **the thing the file layout was a proxy for**. A test that checked for
`index.d.ts` on disk would have endorsed the broken fix.

## For whoever touches this next

- The test is gated and runs in **no automated pipeline**. It protects nothing until something
  runs it; `npm run test:template` with `RUN_TEMPLATE_FULL=1` is the whole invocation.
- Out of scope and still open: CJS in the template, an explicit `exports` map, a `src/backend/`
  folder.
- Any new file added to `defaults/package/` must be added to `createPackage`'s rename **and**
  substitution lists. Defect 1 was exactly that omission, and assertion 5 is what catches it now.
