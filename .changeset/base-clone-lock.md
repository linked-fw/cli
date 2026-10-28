---
'@_linked/cli': patch
---

One lock per base clone: `linked checkout`, `linked branch fork`, `linked branch push`, `linked branch merge` and `linked worktree remove --branch` take a shared base clone's lock (`linked.lock` in it) around their git work on that repo, one repo at a time, so two app checkouts that list the same package no longer fail on git's ref or index locks. A waiter is refused (exit 6) after 120 s with the holder named; a lock left by a process that is gone is taken over. A new base clone is cloned beside its place and renamed into it.
