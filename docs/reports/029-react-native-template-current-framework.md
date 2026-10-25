---
date: 2026-10-25
summary: >
  The react-native template pins the current `@_linked/*` releases (core 2.42.1, schema 1.9.1,
  server 3.12.1, react 2.0.4, cli 1.57.2, fuseki 3.9.1, s3 1.7.1, server-utils 1.16.2). Its
  example shape's property is `name` (`schema.name`, namespace import), and a Babel plugin
  turns an `import()` of a computed specifier into a rejected promise so Hermes can compile the
  bundle. Typecheck and `expo export --platform ios` pass. No Expo or React Native change. Patch.
---

# 029 — The react-native template on the current framework

## Why

Report 028 §Gate: `react-native.full.test.ts` failed "npm run typecheck passes" and "expo export
bundles for iOS" on a clean `main` ("Tests: 2 failed, 8 passed, 10 total"). Three causes, the
second and third hidden behind the first:

1. **Two cores.** The template pinned `@_linked/core` 2.28.3, but `@_linked/schema` 1.5.0 and
   `@_linked/xsd` needed a newer core and got 2.42.1 nested. `Person.select(…)` came from one copy
   and `linkedComponent` expected the other: "Types have separate declarations of a private
   property '_shape'". The same split put both cores in the Metro bundle.
2. **An inherited `label`.** In core 2.42.1 every `Shape` already has `label` (`rdfs:label`). The
   template's `Example.label` with path `https://example.com/app/label` threw when the module
   loaded: "Invalid override for Example.label: path cannot change". This broke the app's Jest
   suites and the shapes package's `linked build` ("Checking shape references").
3. **`import()` in the bundle.** Core's `loadOntologyFiles` loads `node:fs/promises` through a
   variable specifier. A vocabulary's generated data module (`schema.data.js`, `xsd.data.js`)
   imports it, Metro cannot resolve a variable `import()` and leaves it in the bundle, and Hermes
   cannot compile `import()`: "error: Invalid expression encountered … `import(/* @vite-ignore */
   /* webpackIgnore: true */specifier)`".

None of the three is caused by Expo or React Native, so Expo 57 / React Native 0.86.3 stay.

## What changed

- `apps/mobile`, `services/api`, `packages/app-shapes` `package.json`: the `@_linked/*` pins
  above, checked with `npm view` on 2026-10-25. They stay exact pins:
  `createApp.reactNative.test.ts` asserts an exact pin and Renovate moves them. One core is
  installed (2.42.1); every nested `@_linked/*` uses it.
- `packages/app-shapes/src/shapes/Example.ts`: the property is `name` with path `schema.name`,
  from `import * as schema from '@_linked/schema/ontologies/schema'` (the generated accessors of
  report 027). The class stays `ns('Example')`, the app's own term. `app-shapes` depends on
  `@_linked/schema` 1.9.1. `__tests__/nativeDefaults.test.tsx` selects `name`.
- `apps/mobile/babel/rejectComputedImports.js` (registered in `babel.config.js`): an `import()`
  whose specifier is not a static string becomes
  `Promise.reject(new Error('import() with a computed specifier is not available in React Native (<file>)'))`.
  The module it would load does not exist on a device, and core's one caller reachable on React
  Native (`readPackageOntologies`) already catches the rejection and skips the package. A static
  specifier is left alone, so Metro still bundles it as an async module. It applies under Jest
  too. Tests in `__tests__/rejectComputedImports.test.ts`.
- README (§react-native) and the template README describe both Babel plugins.
- `createApp.reactNative.test.ts` lists the new plugin and its test.

## Gate

- `npm run build`: passes.
- `npx jest --config jest.config.cjs`: "Tests: 1 skipped, 1044 passed, 1045 total" (the skip is
  `shapesTurtle.test.ts`'s golden comparison, as on `main`).
- `RUN_TEMPLATE_FULL=1 npx jest --config jest.template.config.cjs tests/template/react-native.full.test.ts`:
  "Tests: 10 passed, 10 total", including "npm run typecheck passes" and "expo export bundles for
  iOS".
- In the scaffold that run produced: `npm test` "Tests: 29 passed, 29 total" (Jest), "# pass 10 /
  # fail 0" (API); `npx expo export --platform ios` (Metro plus Hermes bytecode, no Xcode or
  simulator needed) "iOS Bundled 11435ms apps/mobile/index.ts (715 modules)".
- Not run: the template's `test:integration` (needs the API against a Fuseki).

## Review

An independent review found no blocking issue. Fixed: the missing changeset; the rejection now
names the file, so a computed `import()` in the app's own code is easy to find; the template
README says the plugin applies under Jest. Left as is: the plugin no longer evaluates the
specifier expression (no call site has side effects in it); `services/api/test/exampleAccess.test.mjs`
keeps literal shape IRIs, since the rule under test takes a `ReadonlySet<string>`.

## Follow-ups

- Core: `loadOntologyFiles` could keep its Node-only `import()` out of bundles that never run in
  Node (e.g. a `react-native` export condition), which would make the Babel plugin unnecessary.
  Recorded here.
- Confirm that the shared Renovate preset bumps the three template `package.json` files in one
  group, so the core pins cannot drift apart again.

## PR

### Summary

The react-native template pins the current `@_linked/*` releases, and its typecheck and iOS
export pass again.

### Changes

- Pins: core 2.42.1, schema 1.9.1, server 3.12.1, react 2.0.4, cli 1.57.2, fuseki 3.9.1, s3
  1.7.1, server-utils 1.16.2. The old core pin installed a second core under schema ("Types have
  separate declarations of a private property '_shape'").
- `Example.label` became `Example.name` (`schema.name`, namespace import): core 2.42.1's `Shape`
  already has `label` (`rdfs:label`), and the override with another path threw at load.
- New Babel plugin `rejectComputedImports.js`: core's Node-only `loadOntologyFiles` uses
  `import(variable)`, which Metro leaves in the bundle and Hermes cannot compile. It becomes a
  rejected promise naming the file.
- No Expo or React Native change.

### Verification

- Build passes; unit: "Tests: 1 skipped, 1044 passed, 1045 total".
- `react-native.full.test.ts`: "Tests: 10 passed, 10 total" (was "2 failed, 8 passed").
- `npx expo export --platform ios` in the scaffold: "iOS Bundled 11435ms apps/mobile/index.ts
  (715 modules)".

### Deviations

- The pins stay exact (the brief wrote `^2.42.1`): the template's unit test asserts exact pins,
  and Renovate maintains them.

### Follow-ups

- Core: keep `loadOntologyFiles`' `import()` out of React Native bundles (this report).
- Check that Renovate groups the template's three `package.json` files (this report).
