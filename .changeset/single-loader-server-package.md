---
"@_linked/cli": patch
---

`createViteConfig` now bundles `@_linked/server` in the dev SSR runner (`ssr.noExternal`), in workspace and standalone mode alike. `linked start` loads `LinkedServer` through `vite.ssrLoadModule`, so Vite already evaluated that entry and every file it reaches by relative import, while bare `@_linked/server/...` imports from the app and its storage config went to Node. The package was split across two loaders, and which one evaluated a given file depended on import order: in Create Now, `package.js` and `ontologies/lincd-server.js` evaluated once in each, and `shapes/filestores/LocalFileStore.js` too once the package's `backend` loaded. Vite is now the only loader for it. The new `SSR_ENTRY_PACKAGES` export names the packages this applies to.
