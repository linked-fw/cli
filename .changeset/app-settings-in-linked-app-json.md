---
"@_linked/cli": major
---

`linked.app.json` holds every setting of an app; `linked.config.js` is no longer read.

**Breaking.**

- An app with a `linked.config.js` (or `lincd.config.js`) is refused when its server starts (`linked start`, `linked serve-app`, a compiled server) and when it is built (`linked build-app`); the error shows the JSON to move its settings into. Move them into `linked.app.json` and delete the file.
- Schema version 1 gains `cssMode` (`tailwind` | `postcss`), `syncShapesOnBoot`, `datasetCloneScript`, `publish` (`staticAssets`, `releasePrefix`) and `server` (`rpcExposure`, `rawQueries`, `apiOnly`, `cachePaths`, `cacheTimeout`). Each is checked; an unknown key, also inside `server` or `publish`, is refused. `linked prefixes` keeps them when it adds prefixes.
- `LINKED_RPC_EXPOSURE`, when set, wins over `server.rpcExposure`; a value other than `warn` or `enforce` is refused at start.
- `defineConfig` (`@_linked/cli/defineConfig` and the package entry) is removed: nothing reads a settings module any more.
- Types: `ModuleConfig`, `AdjustedModuleConfig` (the old webpack build's) and `LinkedServerConfig.multiCore` are removed; `LinkedConfig` is the configuration the cli gives `LinkedServer` (`cssMode`, `syncShapesOnBoot`, `server`), and loses `datasetCloneScript`. New: `AppServerSettings`, `CssMode`, `RpcExposureMode`, `RawQueriesMode`. `server.loadAppComponent` and `server.loadRoutes` are set by the cli only.
- `resolveLinkedConfigPath` and `LINKED_CONFIG_FILES` (`@_linked/cli/commands/start`) are removed; `readDatasetCloneScript` is synchronous.

**Fixed.** `linked generate-ontology` replaces a side-effect import of a `src/ontologies/<name>.register.js` that no longer exists (a register module deleted by hand) with the import of the ontology index, as it does for the register modules it removes itself.
