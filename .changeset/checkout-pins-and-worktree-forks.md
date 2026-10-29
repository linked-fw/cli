---
"@_linked/cli": minor
---

`linked checkout` takes `--pin <npm>=<branch>` (repeatable: a package follows its pin, detached at `origin/<branch>` while another worktree holds the branch, and fast-forwards on a re-run) and `--pins-only` (no same-name rule: a package without a pin sits at `origin/<default>`); in either mode a clean worktree moves when its pin changes. `linked branch fork <branch> <pkg> --worktree <dir> [--from <ref>]` makes the branch in a worktree of its own from the package's base clone, outside every app checkout, and `linked branch push <branch> --worktree <dir>` pushes that one worktree. Without the new flags nothing changes.
