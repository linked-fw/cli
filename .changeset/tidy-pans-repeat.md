---
'@_linked/cli': patch
---

Keep `react-router` and `@remix-run/router` in the `react-vendor` chunk.

`react-router-dom` was grouped with React but `react-router`, which it
re-exports, was left in the catch-all `vendor` chunk. That made the two chunks
import each other — `vendor` also runs `React.createContext(...)` at module
scope — and Rollup resolved the cycle by running `vendor` first, so every
production build threw `Cannot read properties of undefined (reading
'createContext')` before the app rendered a single frame.

The chunk routing is now exported as `chunkForModuleId` and covered by unit
tests, since getting it wrong produces a bundle that builds cleanly and only
fails in the browser.
