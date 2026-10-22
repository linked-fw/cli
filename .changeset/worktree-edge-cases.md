---
'@_linked/cli': patch
---

`linked worktree add --app-detached` now refuses without a `--with` package (it would have nothing to land). `linked worktree remove` puts the worktree's `node_modules` and `.env*` links back when `git worktree remove` fails, so the worktree stays usable. Vite's cache dir is chosen from the app root `createViteConfig` uses throughout.
