---
'@_linked/cli': minor
---

`create-package` chooses where a package lives inside an app: `packages/` (part of the app's repository: a workspace member, added to its dependencies and installed at the app root) or `packages-local/` (its own git repository, under `linked localize`'s name for it, with `git init`, a first commit, an optional `--remote` and `--push`, then installed, built, linked and recorded by `linked localize --adopt`). Choose with `--location`, `--remote` and `--push`; with none of them you are asked, on a terminal only. An existing target folder is refused. Outside an app nothing changes.

`linked localize --adopt` links a checkout already in `packages-local/` without cloning it, and `build-all` builds packages recorded in `local-packages.json` even when the app does not declare them yet. Needs `@_linked/localize` 0.2.0.
