---
'@_linked/cli': patch
---

`linked build-all` now builds `@_linked/cli` first and alone when it is one of the packages to build (a localized checkout). Every other package's build runs `linked build` from that checkout's `lib/`, so building it in parallel with them pulled `lib/` out from under their builds (`ENOENT …/lib/esm/installed-packages.js`) and left their dependents unbuilt, and anything built before it used a stale cli. If the cli fails to build, `build-all` now stops with a clear message instead of building the rest with a broken cli. `--from` a later package skips the cli as before; `--from @_linked/cli` builds it and then everything; `--sync` is unaffected.
