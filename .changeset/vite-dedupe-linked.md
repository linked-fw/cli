---
'@_linked/cli': patch
---

`createViteConfig` dedupes every installed `@_linked/*` package plus `react` and `react-dom` in every mode, not only `@_linked/server-utils` and `@_linked/react` in a standalone app. An app with a localized package otherwise had Vite resolve `@_linked/core` from that checkout's own `node_modules`, and its dev SSR backend loaded one core per copy (three, measured). Apps that list these in their own `resolve.dedupe` can drop that line.
