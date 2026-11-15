---
date: 2026-11-15
summary: >
  The worktree and master commands no longer build in one host app's env var names. An app
  declares its projects-root and test-port vars in `linked.app.json` (`worktree.projectsRootVar`,
  `worktree.testPortVar`); every worktree's start command, `worktree add` included, then points
  the projects root into the worktree. Closes backlog 019 (option 1). Minor.
packages: [cli]
---

# 056 — App-declared worktree env vars

## Summary

`linked branch start --worktree` set one host app's projects-root var by its built-in name, and
only for a master's preview; `linked worktree add` never set it, so an agent's server wrote its
checkouts into the main checkout's directory when the app's value was absolute. Backlog 019
asked for the names to come from the app.

`linked.app.json` gains `worktree`: `projectsRootVar` and `testPortVar`, env var names. `startEnv`
(both commands) sets the declared projects-root var when the `.env` sets it, to the worktree's own
directory: a relative value under the worktree, an absolute value's last segment under it. The
master's preview message names `testPortVar` with the test-run port, else says `port <n>`.

## PR

**What changed**

- `src/utils/appConfig.ts`, `schema/app/1.json`: the `worktree` settings, checked as env var names.
- `src/commands/worktree.ts`: `worktreeSettings`, `worktreeProjectsRoot`; `startEnv` without the
  `preview` flag, the var from the app's settings.
- `src/commands/master.ts`: the test-port var from the app's settings; `src/cli.ts` help text.
- Tests: the app config reader and schema, `worktree add` with and without a declared var, the
  master's preview and a step's start command.
- `docs/integration-branches-and-worktrees.md`: "App env vars".

**Verification**: `npx jest --config jest.config.cjs tests/unit/appConfig.test.ts
tests/unit/integration/worktree.test.ts tests/unit/integration/master.test.ts`: `Test Suites: 3
passed, 3 total`, `Tests: 82 passed, 82 total` (1:59 wall).

**Deviations**: none from backlog 019's option 1.

**Follow-ups**: `FUSEKI_DATASET` (`--dataset`) is still a fixed name; it names the store the
framework's Fuseki package reads, not one app's, so it stays.
