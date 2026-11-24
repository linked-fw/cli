---
date: 2026-11-02
summary: >
  Comments in src/, the README and the current docs (backlog, integration-branches-and-worktrees)
  no longer name a particular private host app or point at its docs; they describe the host
  generically. Comments and docs only, no behaviour change, no changeset. Five user-facing message
  strings in the worktree and master commands still name the host's scripts and are left as code.
packages: [cli]
---

# 048 — No mentions of a particular host app

The cli is open source; comments and docs named one private app built on it, cited its backlog
and architecture docs, and used its domain in an example IRI. They now say "a host app", "a
hosting app", "an app that commits through the GitHub API", and the example IRI uses
`example.org`.

## PR

**What changed**

- `src/`: comments in 19 files rewritten generically, meaning kept (`lifecycle.ts`, `vite-config.ts`,
  `cli-methods.ts`, `commands/start.ts`, `commands/setup-publish.ts`, `installed-packages.ts`,
  `workspace-globs.ts`, `interfaces.ts`, `integration/credentials.ts`, `integration/masters.ts`,
  `utils/{componentsTurtle,ontologyModules,ontologyNamespace,packageFiles,packageKind,packageManager}.ts`).
  References to another repo's backlog item and architecture section were dropped; the rule they
  pointed to is already stated inline.
- `README.md`, `docs/integration-branches-and-worktrees.md` and backlog items 006, 009, 011, 012,
  013, 014, 016, 017: the host named generically; absolute paths of its checkout replaced by
  `<main>`; a citation of its report dropped.
- No changeset: comments and docs only.

**Verification**

- `npx linked build` → `✔ Build successful`.
- `npm run test:unit` → `Test Suites: 103 passed, 103 total`, `Tests: 1267 passed, 1267 total`.
- `npm run test:e2e` → `7 passed (1.3m)`.
- A case-insensitive grep for the host's name, abbreviation and domain over `src`, `package.json`,
  `README.md` and `docs` (without `docs/reports` and `docs/plans`) finds only the strings below.

**Deviations from the plan**

- Left as code, not comments: `src/commands/worktree.ts:632-638` (checks for and prints the host's
  backup script and the dump of its main dataset, both by names that carry the host's
  abbreviation) and `src/commands/master.ts:242` and `:494` (the same hint, and a restart message
  that names the host). Changing them changes output, so they need a decision.
- Not touched: `docs/reports/` and `docs/plans/` (historical records of finished work),
  `CHANGELOG.md` (published history), and `tests/` (fixtures and comments there also name the host;
  outside this pass's scope).

**Follow-ups**

- The five message strings above: make the dataset-clone hint generic or configurable by the app
  (e.g. read script names from the app), and say "the app server" in the land message.
- `tests/` comments and fixtures: same cleanup, in a separate pass.
