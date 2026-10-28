---
'@_linked/cli': minor
---

`linked checkout <branch> --add <repo>` (repeatable) checks out a package that no `linked.unpublishedPackages` list names into the app checkout's `packages-local/`, by the same branch rule and under its base clone's lock, its npm name read from its `package.json`. The result marks it `added: true`; it never makes the install run and is never built, so the app's `package.json` and lock stay as committed. `linked branch fork`, `push` and `merge` treat it as any checkout in `packages-local/`; a later run without `--add` reports it `unlisted`.
