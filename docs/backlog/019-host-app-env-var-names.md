---
summary: >
  The worktree and master commands hard-code two env var names of one host app
  (`CN_PROJECTS_ROOT`, `CN_TEST_PORT`). Replace them with generic names: either the app declares
  the names of its projects-root and test-port variables, or the cli uses `LINKED_*` names and the
  app reads its old names as a fallback.
source: the scrub of host-app mentions, 10 Nov 2026
status: open
---

# 019 — Generic names for the host app's env vars

## Problem

`linked worktree add` (preview command of a master) and `linked branch start --worktree` print or
set two env vars whose names belong to one particular host app, not to the framework:

- `CN_PROJECTS_ROOT`: where the app keeps its clones of managed apps. A master's preview overrides
  it to `<wt>/apps` when the app's `.env` sets it, so the preview's clones are its own.
- `CN_TEST_PORT`: the port the app's test runner uses. The master command prints it as the port
  after the preview's.

Every other app has no use for these names, and the names leak a private app into a public
package. Renaming them now would break that app's preview and test commands, so behaviour stays
as is until this item is done.

## Options

1. **The app declares the names.** `linked.app.json` (or the app's `package.json`) lists the env
   var for its projects root and for its test port, e.g.
   `{"worktree": {"projectsRootVar": "MY_PROJECTS_ROOT", "testPortVar": "MY_TEST_PORT"}}`. The cli
   sets or prints only what the app declares; an app declaring nothing gets neither.
2. **Framework names.** The cli uses `LINKED_PROJECTS_ROOT` and `LINKED_TEST_PORT`; the host app
   reads them, falling back to its old names for a while. Simpler, but presumes every app has a
   projects root and a test runner reading a port.

Option 1 keeps the cli free of any app's conventions; option 2 is less configuration.

## Where the names occur

Code (behaviour):

- `src/commands/worktree.ts:391` (doc comment), `:399` (reads it from `.env`), `:400` (sets it)
- `src/commands/master.ts:235` (prints `CN_TEST_PORT=`)
- `src/cli.ts:767` (help text of `branch start`)
- `tests/unit/integration/master.test.ts:82` (fixture `.env`), `:173` (asserted preview command)

Docs quoting them:

- `CHANGELOG.md:39`
- `docs/integration-branches-and-worktrees.md:414`, `:419`
- `docs/plans/003-master-worktrees.md:37`, `:105`
- `docs/reports/040-master-worktrees.md:6`, `:66`, `:117`
- `docs/reports/041-master-worktrees-part-one.md:128`, `:130`

## Done when

No `CN_` name is left in `src/`, `tests/` or the current docs (`docs/integration-branches-and-worktrees.md`);
the host app's preview and test commands still work; historical reports and the CHANGELOG may
keep the old names as history.
