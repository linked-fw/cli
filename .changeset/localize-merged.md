---
'@_linked/cli': minor
---

Localize is now part of the cli. `linked localize` and `linked delocalize` no longer load the separate `@_linked/localize` package, which is no longer a dependency and will be deprecated in favour of `linked localize`; its `linked-localize` binary is not replaced. The guide is in `docs/localize.md`.

New:

- `linked localize --ensure` removes every localized checkout's own copy of a package the app provides and exits 0. It never runs npm and prints nothing when there is nothing to remove — for an app's npm `pre*` scripts.
- `linked localize --reinstall <pkg>` runs `npm install` inside that package's checkout and then prunes it. Use it instead of a hand-run `npm install` in a checkout.
- A run-time one-copy check before `linked start`, `linked script`, `linked call` and `linked build-all`: stat-only, it removes a checkout's own copy of what the app provides with one line of output.
- `linked localize --list` shows directories in `packages-local/` that `local-packages.json` does not record, as `UNRECORDED` (they do not fail `--check`).

One rule now says what the app provides: the localized packages, plus their runtime dependencies (`dependencies`, `peerDependencies`, `optionalDependencies`) that the app has at a version satisfying every localized range, plus `react` and `react-dom`. Pruning, the run-time check and Vite's `resolve.dedupe` all use it.

Behaviour change: pruning now also removes a checkout's own copy of tooling or other runtime dependencies the app provides in range (for example `vite` or `typescript` declared in `dependencies`); the checkout resolves the app's copy instead. devDependencies are no longer candidates.
