---
'@_linked/cli': minor
---

Warn that `.env-cmdrc.json` is deprecated.

It is still read, and still read *first*, so nothing changes for an app that
uses it. But it is the only reason `--env` exists, and both are going away: a
flat `.env` plus whatever the deployment injects into the environment replaces
the profile model entirely.

The warning also calls out the case that costs the most time to diagnose — an
app with both files, where `.env-cmdrc.json` wins and the `.env` sitting next
to it is ignored in full, silently.
