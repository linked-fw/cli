---
'@_linked/cli': minor
---

**Renamed:** `linked doctor` is now `linked app-doctor` (no alias). It checks how an app uses
linked packages, so run outside an app (no `vite.config.{ts,js,mjs}`) it now says so and exits 1,
instead of reporting "0 warnings" for a directory it never checked.

**Removed:** the `linked yarn` command and the `safeYarn` export — the workspace is npm-only.
