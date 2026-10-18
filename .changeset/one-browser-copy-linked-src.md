---
'@_linked/cli': patch
---

Dev: relative imports inside an installed linked package that ships `src/` (e.g. `@_linked/shape-ui`) now resolve through the CLI, so the browser loads each of its modules once. Before, Vite gave a `.tsx` module `?v=<hash>` when a `.ts` file imported it and none when a `.tsx` file did, which loaded shape-ui's `hostContext.tsx` (and its React context) twice.
