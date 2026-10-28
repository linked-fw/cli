---
'@_linked/cli': minor
---

`linked branch push <branch> [--dir <app>] [--json]`: in an app checkout, push `<branch>` in the
app and every `packages-local/` checkout on it (what origin lacks, `-u` when new; a diverged
branch is refused, never forced), so `linked branch merge` finds nothing unpushed. The token comes
only from `LINKED_GIT_TOKEN`, as for every remote call.
