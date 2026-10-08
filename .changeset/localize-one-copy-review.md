---
'@_linked/cli': minor
---

`linked localize`: the one-copy check is cheap again, and pruning no longer breaks a checkout's own build.

- **The run-time check (before `linked start`, `script`, `call`, `build-all`, and `linked localize --ensure`) is fast when copies are kept.** It now makes the same per-copy decision as pruning, without removing anything, and only prunes when that decision removes something. Candidates are looked up directly, and the ranges other installed packages ask are read from npm's hidden lockfile (`node_modules/.package-lock.json`) instead of walking each tree. Measured on an app with 21 localized checkouts and 54 kept copies: 6.6 s → about 40–50 ms. Its one line of output now goes to stderr.
- **A copy is kept when removing it would change what its own dependencies resolve to.** If any of its `dependencies`, `peerDependencies` or `optionalDependencies` (or the `@types/` package TypeScript takes for one) resolves, from the copy's place in the checkout, to a different version than from the app's copy, the copy stays. Previously a checkout that kept React 18 for its own range could lose a renderer library to the app's copy, which then saw React 19's types, and the checkout's own `tsc` failed. If a checkout is in that state, `linked localize --reinstall <package>` restores it.
- **Candidates are per checkout.** In checkout A, a candidate is a localized sibling, `react`/`react-dom`, or one of A's own runtime dependencies that the app provides. A devDependency of A is never removed just because another checkout depends on the same package at runtime.
- **One command converges.** A prune repeats (at most 5 passes) until nothing more can go, so a second `--ensure` has nothing left to do.
- **`--no-prune` is remembered.** Localizing or adopting with `--no-prune` records `"prune": false` on that entry in `local-packages.json` (an optional field, still schema version 1). From then on `--relink`, `--reinstall` and the run-time check leave that checkout's `node_modules` alone. Localizing it again without the flag turns pruning back on. `--ensure --no-prune` does nothing.
- **`--ensure` takes no package names.** Given names, it exits 2 instead of silently ignoring them. Use `--reinstall <package>` for one checkout.
- **Kept copies are summarised, one line per checkout** (`kept N own copies the app's cannot replace: react@18.3.1 (app 19.2.0), …`), instead of one warning per copy. `linked localize --list` now gives each kept copy's reason, shows `prune: off` for a `"prune": false` checkout, and counts kept copies in its summary.
- The client dependency scan never lists `react-native` (added to its default deny list): a web build never loads it, and esbuild cannot parse its Flow source.
