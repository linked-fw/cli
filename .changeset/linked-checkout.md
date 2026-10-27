---
'@_linked/cli': minor
---

`linked checkout <branch>`: a branch checkout of an app and the packages it lists in `linked.unpublishedPackages` (transitively), as git worktrees of bare base clones in a projects root, with one install and a `--json` result. `linked branch fork` creates and pushes a project branch in a package checkout; `linked branch merge --into <default>` lands the repos on a branch in dependency order (`--mode push`, or `--mode update` for protected default branches); `linked worktree remove --branch` removes a checkout once it has landed. `linked localize --listed` clones the listed packages in a developer's app. `unpublishedPackages(json)` reads the list (`@_linked/cli/installed-packages`); `dependencyOrder` follows its edges. Private repos: the token comes only from `LINKED_GIT_TOKEN`, used through `GIT_ASKPASS` with credential helpers and git hooks off, never written to a URL or a git config, and kept from installs and builds.
