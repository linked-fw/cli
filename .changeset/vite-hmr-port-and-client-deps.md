---
'@_linked/cli': minor
---

Dev server: the HMR port and the optimizer's include list now configure themselves, and
`linked doctor` checks what they cannot fix.

- **The HMR port is chosen automatically.** The port derived from the dev port
  (`24678 + (PORT - 4040)`) is still the default, but when another process already holds it —
  a second checkout of the same app, or an unrelated dev server — `createViteConfig` now takes the
  next free port and logs it, instead of leaving the second app without HMR. Vite serves the
  configured port to the browser, so the client follows. `LINKED_HMR_PORT` sets the port
  explicitly and replaces app-specific overrides.
- **`optimizeDeps.include` is generated for linked packages' client dependencies.** Linked
  packages are excluded from Vite's optimizer so the browser loads one copy of each, which also
  means Vite never crawls their imports: a CommonJS dependency then fails in the browser, and any
  other one triggers a re-optimise and reload mid-session. Apps listed those dependencies by hand,
  including npm-nested ones (`'@_linked/primitives > vaul'`). In dev they are now read from the
  excluded packages' import graph: files importing Node builtins or server-only packages (and
  files importing those) are server code and are skipped, and a dependency the app root resolves
  to a different copy gets the nested form. The entries are added to the app's own list, never
  replace it; `clientDepIncludes: {deny}` / `false`, or `LINKED_CLIENT_DEP_INCLUDES=0`, opt out,
  and `DEBUG=linked` prints what was added. Results for installed packages are cached in
  `node_modules/.cache/linked/`.
- **`linked doctor`** loads the app's dev config and warns about `optimizeDeps.include` entries
  that do not resolve (naming the nested form when that is the problem), and about linked
  packages whose dependencies' React peer range excludes the app's React — the reason npm nests
  them — with the dependency to bump. It also lists hand-written entries that are now generated.
  Exits 1 on a warning.
