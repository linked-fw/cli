---
"@_linked/cli": patch
---

- `linked branch start` refuses a name equal to its target and a branch another worktree has checked out, and when a switch fails partway it puts the repos already switched back (previous branch, created branches deleted, target entries restored).
- `linked release plan` warns per repo when a changesets repo adds no changeset (merging would not publish), and when `origin/<target>` has commits the local target lacks; the warnings are in `--json` as `warnings`.
- `linked localize` and `linked delocalize` refuse to install in a worktree whose `node_modules` is a symlink, and name the checkout to run them in; `--list` still works there.
- `linked doctor resolve` treats `@_linked/cli` and the `@_linked/*` packages the app's `vite.config` imports as loaded by Node, instead of a fixed list.
- `linked doctor` is no longer reported as a rename of `app-doctor`, and `@_linked/cli` is no longer listed in dev `ssr.noExternal`.
