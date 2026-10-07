---
'@_linked/cli': patch
---

`createViteConfig` dedupes every linked package the app has installed — by its `linkedPackage` flag, whatever its npm scope — plus `react` and `react-dom` in every mode, not only `@_linked/server-utils` and `@_linked/react` in a standalone app. An app with a localized package otherwise had Vite resolve `@_linked/core` from that checkout's own `node_modules`, and its dev SSR backend loaded one core per copy (three, measured). A standalone app's `optimizeDeps.exclude` now also picks linked packages by the flag rather than the `@_linked/` scope. Apps that list these in their own `resolve.dedupe` can drop that line.
