---
'@_linked/cli': patch
---

The undo of `linked worktree add` and `linked branch start` keeps a base branch the run created when another local branch has forked from it since, as well as when it moved or is checked out, and prints `kept <branch> at <sha>: <reason>`. `linked branch start --help` lists every refusal and the undo.
