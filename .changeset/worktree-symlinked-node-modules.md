---
"@_linked/cli": patch
---

`linked start` works from a git worktree whose `node_modules` is a symlink: Vite gets its own cache dir (`.vite-cache/` in the app root) instead of re-optimizing the main checkout's, and the drift check no longer reports every localized package as gone.
