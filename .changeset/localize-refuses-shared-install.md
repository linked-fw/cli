---
"@_linked/cli": patch
---

`linked localize` and `linked delocalize` refuse (exit 6) in a worktree whose `node_modules` is a symlink, where their install would rewrite the main checkout's, and name the checkout to run them in; `--list` still works there. `linked doctor` is no longer reported as a rename of `app-doctor`.
