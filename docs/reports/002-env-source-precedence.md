---
summary: A flat .env is now read before .env-cmdrc.json instead of after, so adding
  one is the whole migration step. The profile file still works when it is the only
  file present, and now warns that it and the --env flag are being removed.
---

# Environment source precedence

## What changed

`ensureEnvironmentLoaded` reads two possible sources. The order is reversed:

| | Before | After |
|---|---|---|
| 1st | `.env-cmdrc.json` | `.env` |
| 2nd | `.env` | `.env-cmdrc.json` |

Whichever is found first wins outright; the second is never read. The shell environment is
re-applied last either way, so injected values still beat anything on disk.

`.env-cmdrc.json` also now warns that it is deprecated.

## Why

The old order made migrating a cliff. An app that added a flat `.env` next to its existing
profile file got **none of it**, silently — the profile file was found first and that was that.
The only way to switch was to delete `.env-cmdrc.json` outright and hope the flat file was
complete, with no way to stage it.

Reversed, adding `.env` *is* the migration. The profile file can sit on disk doing nothing until
it is convenient to delete.

Nothing breaks for an app that has not migrated: `.env-cmdrc.json` is still read when it is the
only file present, `--env a,b` still selects profiles, and `_main` is still merged.

## The warning

```
.env-cmdrc.json is deprecated and will be removed in a future major release.
  Move its values into a flat `.env`, and supply anything that differs per deployment
  from the environment itself. `--env` goes away with it.
  This app has BOTH files. `.env` wins, so `.env-cmdrc.json` — and any `--env` profile
  named with it — is being ignored entirely. Delete it once the flat file is complete.
```

The third line exists because the new precedence has its own quiet failure. A half-migrated app
keeps passing `--env staging` on its build and serve commands and keeps getting nothing from
it. That is the intended behaviour, but it is invisible from the outside — values the app still
believes it is getting from a profile are simply absent — so it is said out loud.

## Where this is going

`.env-cmdrc.json` is the only reason `--env` exists. Both are slated for removal: a flat `.env`,
plus whatever the deployment injects into the environment, covers what the profile model did.
Apps carrying per-profile configuration will need those values to come from the environment at
deploy time rather than from a checked-in file of profiles.

## Public API

`envDeprecationNotices({hasEnvCmdrc, hasDotEnv}): string[]` is exported from `src/lifecycle.ts`.
It is pure — it returns the lines to print and prints nothing — so the messages can be asserted
without a `process.chdir`. An earlier version of the test did chdir into a temp directory and
that leaked into an unrelated suite, which is why the decision was extracted this way.

## Tests

`tests/unit/envCmdrcDeprecation.test.ts` — four cases: profile file alone warns; both files
present adds the "being ignored entirely" line; a flat `.env` alone stays quiet; no env file at
all stays quiet.

Full suite: 23 files, 299 tests.

PR: [#105](https://github.com/linked-fw/cli/pull/105)
