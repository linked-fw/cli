---
summary: >
  Masters run in their own worktree: `linked branch start <m> --worktree` makes the integration
  branch in a link-farm worktree (never switching the owner's checkouts), `linked worktree add
  <agent> --from <m>` gives steps flattened farms with a `parent` marker that `relink` honours,
  CN's own `packages/*` become overlays, `worktree list/remove` know masters, and `linked branch
  land <m>` merges the owner's branch into `<m>`, fast-forwards the owner's checkouts, builds and
  pushes. For Create Now's master-run workflow (proposal of 2026-10-29). Lands on `dev`.
status: Implementation
---

# 003 — Master worktrees

## Ideation (settled by the owner)

The ideation is the proposal "Master runs in their own worktree" (2026-10-29). Settled:

- The owner stays on his stable branch (`dev`) in the main checkout and every `packages-local/`
  checkout; nothing but `branch land` moves them.
- Each master gets an integration branch `<m>` in its own worktree (`../wt/<m>`) with nested
  framework worktrees and a link farm into the one install, plus its own preview CN.
- Steps: option A flattened. A full app worktree on `<m>--<agent>`, nested package worktrees from
  the master's, a farm that links straight into the install with the master's overlays under its
  own, and the master recorded as `parent` so `relink` rebuilds the same farm.
- `land` brings the target in by **merge** (not rebase); conflicts stay in the master's worktree
  for the agents to resolve; then ff-only into the owner's checkouts, build, **push**.
- Release is unchanged. No cookie prefix. No `--package-only` in this slice.

Decisions taken here (automatic mode, maintainability first):

1. **`packages/*` overlays only when usable.** An unbuilt `packages/access` in a fresh worktree
   has no `lib/`, so linking it would make tsc and Node fail where they work today. A `packages/*`
   member is an overlay when its entry point exists (`main`, or the `.` export's import/default)
   or it declares none (`editor-chrome`, `my-app`). Built later: `linked worktree relink`.
2. **Preview env from the linked `.env`.** The CLI is not CN-specific: the start command overrides
   `SITE_ROOT` (to `http://localhost:<port>`) whenever the linked `.env` defines it, for every
   worktree; a master's preview also overrides `CN_PROJECTS_ROOT` (to `<wt>/apps`) when the
   `.env` defines it.
3. **Records in git config** (common config, every worktree sees it), in each repo of the master:
   `branch.<m>.linked-target`, `branch.<m>.linked-worktree` (that repo's worktree dir); in the app
   repo also `linked-port` and `linked-dataset`. A master is a branch with `linked-worktree`.
4. **Port slots** `45k0` (k = 1..9): the first not recorded by another master. `--port` overrides.
5. **Dirty owner checkouts don't block `branch start`** (nothing is switched there; the branch
   starts at the committed tip, which is printed). `land` does require them clean.
6. **`land` stops after a merge that made a commit** (exit 3, "re-test") unless `--no-retest`; a
   re-run with nothing new to merge proceeds. A conflict is left in progress in the master's
   worktree (exit 4) with the files named.
7. **Removing a master** is `linked worktree remove <m>`: refuses while a step worktree exists or
   a branch has not landed in its target; deletes `<m>` (git drops its `branch.<m>.*` config).
8. **`--with` a package the master lacks** is refused in `--from`; adding it later is a follow-up
   (`branch add-package`).

## Plan

### Contracts

- `branchStartWorktree(appRoot, name, {with, target?, port?, dataset?, dir?}, run)` →
  `{code, messages, dir, port, startCommand}`. Run in the main checkout. Per repo the target is
  `--target` or that checkout's current branch. Refuses (nothing created) on: invalid name, `--`,
  a detached checkout without `--target`, `<m>` existing in a repo, the dir existing or inside
  the root, a port held by another master.
- `worktreeAdd(appRoot, agent, {…, from?})`: with `from` (or when `appRoot` is a master's
  worktree) the base is `<m>`, the default dir `<dir of the master>/<m>--<agent>`, `--with` picks
  from the master's nested worktrees, there are no joins, and the farm marker records `parent`.
- Farm marker: `{installRoot, overlays, parent?}`.
- `worktreeRelink`: installRoot from the marker (else git's first worktree), overlays =
  `overlaysOf(parent) ∪ overlaysOf(dir)`, the worktree's own winning.
- `overlaysOf(dir)`: `packages-local/*` as today plus usable `packages/*`.
- `worktreeList(root)`: `masters: [{name, dir, target, port, dataset, worktree, steps}]` added;
  masters and their steps are not in `worktrees`.
- `worktreeRemove(root, name)`: `name` = `<m>` (a master), `<m>--<agent>` or `--from <m>` +
  agent (a step), else as today.
- `branchLand(appRoot, m, {dryRun, retest, build, push}, run)` → `{code, messages, repos}`;
  codes 0 landed, 1 refused, 3 re-test needed, 4 conflict, 5 landed but a build or push failed.

### Expected file changes

- `src/commands/worktree-node-modules.ts`: usable `packages/*` overlays, `parent` in the marker,
  `readFarmMarker`.
- `src/commands/worktree.ts`: shared create step, `--from`, master-aware list/remove/relink,
  start-command env, `packages/*/node_modules` links.
- `src/commands/master.ts` (new): master records, `branchStartWorktree`, `branchLand`.
- `src/cli.ts`: `branch start --worktree --with --port --dataset --dir` (target optional with
  `--worktree`), `branch land`, `worktree add --from`, `worktree remove --from`, `relink --from`.
- `tests/unit/integration/master.test.ts` (new), additions to `worktree.test.ts`.
- `docs/integration-branches-and-worktrees.md`, changeset (minor), report 040.

### Pitfalls

- `git branch -d <m>` in a worktree repo fails while a worktree holds it: remove worktrees first.
- `git merge --ff-only` must run in the checkout that holds the target (the owner's).
- Nested `node_modules` links must point at the real directory (no link to a link).
- `branch start` without `--worktree` keeps its exact behaviour and its required `--target`.

## Tasks

### Phase 1: farm (overlays, parent marker, relink)
- `overlaysOf` with usable `packages/*`; marker `parent`; relink from the marker; nested
  `node_modules` link from the install root's matching path; `packages/*/node_modules` links.
- Validation: worktree tests and new ones (packages overlay usable/unusable, relink keeps the
  parent overlays); full unit suite green.

### Phase 2: `branch start --worktree`, `worktree add --from`
- Validation: sandbox tests — owner checkouts never switch, config records, preview command with
  `SITE_ROOT`/`CN_PROJECTS_ROOT`, step farm flattened, default dir, refusal of a missing package.

### Phase 3: list/remove of masters, `branch land`
- Validation: sandbox tests — list groups steps, remove step via `<m>--<a>`, land merge/ff/push
  into a bare origin, re-test stop, conflict left in progress, refusal when the owner is dirty,
  remove master after land.

### Phase 4: docs, changeset, CLI e2e by hand in a sandbox with the built `lib/`
- Validation: `npx linked build`, the full unit suite, the e2e specs that need no Docker, a
  sandbox run of the built CLI end to end.

Dependencies: 1 → 2 → 3 → 4, sequential (one agent).

## Implementation log

- Phases 1-3 (farm, start/add, list/remove/land) were implemented together in one commit: the
  shared `createWorktreeSet` step serves `worktree add`, `add --from` and `branch start
  --worktree`, so splitting them would have left intermediate commits with half an API.
  Validation: `tests/unit/integration/master.test.ts` (9 tests) and the existing worktree,
  branch, repos, release-plan, farm and doctor-resolve suites (85 tests) pass. The full unit
  suite: 1170 passed, 5 failed (`shapeHierarchy`, `ontologyDataReachable`), failing identically
  on the untouched code in this worktree (checked with the changes stashed): not this change.
- Phase 4: `npx linked build`, then the built CLI end to end in a sandbox (start a master, a
  step, land the step into the master, relink, remove the step, owner commits, `land
  --dry-run`, `land` → 3, `land` → 0 with push to a bare origin, remove the master, and the
  in-place `branch start --target` and `worktree add` unchanged).
