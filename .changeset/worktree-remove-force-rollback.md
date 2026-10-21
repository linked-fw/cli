---
"@_linked/cli": patch
---

`linked worktree remove` finds the agent's worktree by its `<base>--<agent>` branch wherever it is (a detached one by its package worktrees), with `--dir` as an override. `--force` now keeps unlanded agent branches and prints their sha; the new `--delete-unlanded` deletes them. `linked worktree add` rolls back when any step throws, never removes a directory it did not create, keeps a base branch another agent moved, rejects an invalid agent name before changing anything, links `.env` files to their real path and quotes paths in the printed start command. `linked worktree list` shows only agent worktrees unless `--all` is given.
