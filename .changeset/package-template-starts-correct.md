---
'@_linked/cli': minor
---

`create-package` now produces a package that is correct the moment it exists.

Three defects, fixed together because fixing one alone turns a silent defect into a hard
build failure:

- **The ontology register sibling was never wired up.** The template's `src/index.ts`
  imported the terms module rather than `<name>.register.js`, and `createPackage` omitted
  `example-ontology.register.ts` from both its substitution list and its rename list. A new
  package therefore kept a stray `example-ontology.register.ts` full of unsubstituted
  `${...}` placeholders, and nothing imported either register file — so `linkedOntology()`
  never ran and the ontology was never registered. `createOntology` now adds the register
  import to the index too.
- **The template still shipped an entry-graph compile** (`files: [types.ts, index.ts]`,
  `include: [backend.ts]`). It now uses the whole-folder shape the fleet converged on:
  `files: ["./src/index.ts"]`, `include: ["./src/**/*.ts", "./src/backend.ts"]`, with tests
  excluded. This had to follow the fix above: a whole-folder compile would otherwise reach
  the unsubstituted placeholder and fail.
- **A new package had no `.gitignore`**, so `lib/` and `node_modules/` were committable from
  minute one. The template now ships `gitignore.template` (`lib`, `node_modules`,
  `*.tsbuildinfo`), renamed by the existing dotfile pass.

- **`"types"` produced a double mapping.** The template declared
  `"types": "lib/esm/index.d.ts"` alongside `typesVersions: {"*":{"*":["lib/esm/*"]}}`,
  which TypeScript applies to the `types` field too — so it asked for
  `lib/esm/lib/esm/index.d.ts` and `node10` resolution failed outright. Restored to
  `"types": "index.d.ts"`, the convention the shipped packages already use, with a `//types`
  note in the file saying why it is correct as written.

Also fixes the `data.defauilt` typo in the example ontology's ESM JSON import, which made
`loadData()` resolve to `undefined` under ESM.

A new gated suite, `tests/template/package.full.test.ts` (`npm run test:template`),
scaffolds with the built CLI, installs, builds, and asserts each of these as a property
rather than a claim.
