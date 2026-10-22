---
"@_linked/cli": patch
---

The git hooks no longer run `npm install` in a worktree whose `node_modules` is a symlink: it would rewrite the main checkout's install.
