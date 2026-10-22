---
"@_linked/cli": minor
---

`linked worktree add|list|remove`: an agent's worktree of the app on `<base>--<agent>`, with a nested worktree of each package it changes, sharing the main checkout's install.

- `add <agent> [--with pkgs] [--app-detached] [--port] [--dataset] [--dir]` symlinks `node_modules` (also each package's nested one) and the gitignored `.env*` files (to their real path, never private keys), switches a `--with` checkout that is not on the base onto it, and prints the start command with paths quoted. Every precondition is checked before anything changes (including the agent name, and `--with` for `--app-detached`); a later failure undoes what the run created, never removes a directory it did not create, and keeps a base branch another agent moved or forked from.
- `list [--all] [--json]` shows the agent worktrees and whether each branch has landed; `--all` adds every other worktree.
- `remove <agent> [--force] [--delete-unlanded] [--dir]` finds the worktree by its agent branch (a detached one by its package worktrees) and refuses while a branch has not landed or a worktree has changes. `--force` removes it anyway and keeps unlanded branches, printing their sha; `--delete-unlanded` deletes them. When `git worktree remove` fails, the worktree's links are put back.
