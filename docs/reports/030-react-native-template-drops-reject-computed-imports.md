---
date: 2026-10-25
summary: >
  The react-native template pins `@_linked/core` 2.43.0 and removes the `rejectComputedImports`
  Babel plugin (and its test), which report 029 added for core's `loadOntologyFiles`. Core 2.43.0
  gives Metro a stub through its `react-native` export condition. Template typecheck, tests and
  `expo export --platform ios` pass. Patch.
---

# 030 — The react-native template drops `rejectComputedImports`

## Why

Report 029 added `apps/mobile/babel/rejectComputedImports.js` because core's server-only
`loadOntologyFiles` did `import(variable)`, which Metro leaves in the bundle and Hermes cannot
compile. Core 2.43.0 (core report 077, linked-fw/core#398) gives `./ontology/loadOntologyFiles` a
`react-native` and a `browser` export condition that resolve to a stub without `import()`, and
core's own ontology modules import it by package specifier, so the plugin has nothing left to do.

## What changed

- Deleted `defaults/app-react-native/apps/mobile/babel/rejectComputedImports.js` and
  `__tests__/rejectComputedImports.test.ts`; `babel.config.js` registers only
  `stripJsonImportAttributes`.
- `@_linked/core` is pinned to 2.43.0 in `apps/mobile`, `packages/app-shapes` and `services/api`.
- The template README, the cli README and the scaffold file list in
  `tests/unit/createApp.reactNative.test.ts` no longer name the plugin.

## Gate

- Before core 2.43.0, as the control: a scaffold on core 2.42.1 with the plugin removed fails
  `npx expo export --platform ios` in Hermes (`error: Invalid expression encountered` at
  `return yield import(/* @vite-ignore */ /* webpackIgnore: true */specifier);`).
- `RUN_TEMPLATE_FULL=1 npx jest --config jest.template.config.cjs tests/template/react-native.full.test.ts`:
  `Tests: 10 passed, 10 total`, including `npm run typecheck passes`, `npm test passes (app Jest and
  API node --test)` and `expo export bundles for iOS`.
- A fresh scaffold with the built cli: one core copy, 2.43.0; `apps/mobile/babel/` holds only
  `stripJsonImportAttributes.js`; `npx expo export --platform ios` → `iOS Bundled 3100ms
  apps/mobile/index.ts (716 modules)`, `Exported: ../../../export`. The `.hbc` holds
  `node:fs/promises` 0 times.
- `npm run test:unit`: `Test Suites: 90 passed, 90 total`, `Tests: 1 skipped, 1044 passed, 1045 total`.

## Follow-ups

None.

## PR

The react-native template pins `@_linked/core` 2.43.0 and drops the `rejectComputedImports` Babel
plugin, its test and its wiring (`babel.config.js`, both READMEs, the scaffold file list). Core
2.43.0 (linked-fw/core#398) resolves `loadOntologyFiles` to a stub without `import()` under Metro's
`react-native` condition, so the plugin is no longer needed.

**Verification**

- Control, core 2.42.1 without the plugin: `npx expo export --platform ios` fails with `error:
  Invalid expression encountered` at the `import(specifier)`.
- `RUN_TEMPLATE_FULL=1 npx jest --config jest.template.config.cjs tests/template/react-native.full.test.ts`:
  `Tests: 10 passed, 10 total` (typecheck, app and API tests, `expo export bundles for iOS`).
- Fresh scaffold on core 2.43.0: `iOS Bundled 3100ms apps/mobile/index.ts (716 modules)`,
  `Exported: ../../../export`; `node:fs/promises` occurs 0 times in the `.hbc`.
- `npm run test:unit`: `Tests: 1 skipped, 1044 passed, 1045 total`.

**Deviations:** none. **Follow-ups:** none.
