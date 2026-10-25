---
"@_linked/cli": patch
---

The react-native template pins `@_linked/core` 2.43.0 and drops its `rejectComputedImports` Babel plugin. Core's `loadOntologyFiles` now has a `react-native` export condition that gives Metro a stub without `import()`, so Hermes compiles the bundle with the stock Babel config plus `stripJsonImportAttributes`.
