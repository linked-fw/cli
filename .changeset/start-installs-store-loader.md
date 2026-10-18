---
"@_linked/cli": minor
---

`linked start` installs a module loader for core's `loadStores` (`globalThis[Symbol.for('@_linked/core:importModule')]`). A store named in `linked.backend.datasets.json` whose package the Vite SSR runner bundles (`@_linked/server/shapes/quadstores/RemoteDataset`) is loaded through `vite.ssrLoadModule`; any other (`@_linked/fuseki/shapes/FusekiStore`) through Node, at the file Vite's SSR resolver returns. Each store then comes from the same copy of its package as the app's own import, so `instanceof RemoteDataset` and `instanceof RemoteDatasetUnreachableError` hold in dev. A core that does not read the loader ignores it.
