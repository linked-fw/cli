---
"@_linked/cli": minor
---

Masters, part one: `branch start --worktree` chooses and records its preview port inside a
machine-wide lock against a port registry under `~/.linked` (`LINKED_HOME` overrides it), so two
masters started at once in one app or two never take one port, and `worktree remove <m>` releases
it; `worktree relink --all` relinks every worktree of the app; `branch list` shows integration
branches and masters; `branch add-package <m> <packages...>` adds a framework package to a running
master. New in `integration/repo-lock`: `withRepoLockAsync`, `linkedHome`, `withMachineLockAsync`.
