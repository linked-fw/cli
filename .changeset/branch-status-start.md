---
"@_linked/cli": minor
---

`linked branch status` and `linked branch start` manage one integration branch across an app and its `packages-local/` checkouts. `status` shows per repo the branch, its target, dirty, ahead/behind the target and the integration branch, and flags a repo on neither as `off-branch`. `start <name> --target <b> [packages...]` switches the app root and the named checkouts, creating the branch from the target where needed, and records the target. It refuses, switching nothing, on a dirty tree, a target missing where the branch has to be created, a name equal to the target or containing `--`, or a branch another worktree has checked out; a switch that fails partway puts the repos already switched back (a created branch that moved or was forked from since is kept, and its sha printed).
