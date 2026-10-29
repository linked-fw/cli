---
"@_linked/cli": patch
---

`linked checkout --pin`: a pin to a branch other than the run's own is always checked out detached at `origin/<pin>` (it is written in its own worktree), so no app checkout holds it; `linked branch fork --worktree` no longer detaches another checkout's worktree, and refuses a `--from` that starts with `-`.
