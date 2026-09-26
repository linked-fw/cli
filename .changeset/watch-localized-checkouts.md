---
'@_linked/cli': patch
---

`linked start` now watches linked dependencies that are installed as source, not only packages
matched by the app's `workspaces` globs. The HMR watch set feeds `onSourceChange`, the
dispose-and-re-index cycle that replaces a package's registered backend providers; built from
`workspaces` alone it could not contain a checkout outside the workspace (a `packages-local/<pkg>`
localized checkout, in no glob), so a saved backend edit there was reloaded by Vite and then had no
effect — the provider instance registered at boot was never replaced.

The watch set and the Vite resolver table now share one discovery rule
(`discoverLinkedSourceDependencies`), so they cannot disagree about what is source. Only working
copies are watched: a published package that ships `src/` in its tarball stays inside
`node_modules`, which Vite's watcher ignores, so it is resolved from source as before but not
counted at boot.
