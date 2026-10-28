---
"@_linked/cli": minor
---

`linked worktree add` makes the worktree's `node_modules` a link farm into the main checkout's install instead of one symlink, with each `--with` package linked to the worktree's checkout, so `tsc` and Node (backend, tsx, Vitest, Jest) load the worktree's copies as Vite already did. New `linked worktree relink [agent]` rebuilds the farm after an `npm install` in the main checkout or a package worktree added by hand, and moves a worktree with a symlinked `node_modules` to the farm; `doctor resolve` prints when one is needed. The git hooks, `localize`/`delocalize` and the Vite cache dir treat the farm as a shared install. `linked build` inside a worktree passes `--preserveSymlinks` to `tsc` (no TS2742 for hoisted transitive types) and sets the execute bit on `bin` files.
