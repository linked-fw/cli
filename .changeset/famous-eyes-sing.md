---
'@_linked/cli': minor
---

Read `.env` before `.env-cmdrc.json`, and warn that the profile file is deprecated.

The order was the other way round, which made migrating awkward: an app that
added a flat `.env` next to its existing profile file saw none of it, silently.
Now `.env` wins, so adding it *is* the migration — the profile file can be
deleted whenever convenient.

`.env-cmdrc.json` is still read when it is the only file present, so no app
breaks. It now warns that it, and the `--env` flag that exists only to serve
it, are going away: a flat `.env` plus whatever the deployment injects into the
environment replaces both. An app holding both files is told explicitly that
the profile file and any `--env` name passed with it are being ignored.
