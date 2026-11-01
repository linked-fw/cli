---
'@_linked/cli': patch
---

The react-native template's `nativeDefaults` test stubs its store with `readQuery`, the one read method of `@_linked/core`'s `IDataset` (it replaced `selectQuery` and `askQuery`). The template's `@_linked/core` pin must move to the core minor that has `readQuery` with this release.
