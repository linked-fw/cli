---
summary: >
  Sub-plan of Create Now master plan 282 (shapes and packages per hub) for `@_linked/cli`:
  CL — backlog 013 part one (a machine-wide port lock under `~/.linked` with an async variant,
  `worktree relink --all`, `branch list`, `branch add-package`); CI — the component index file
  `linked build` emits next to `shapes.ttl` (with `@_linked/react`); BK — the `branch` key of an
  `unpublishedPackages` entry. Lands on the master `hub-imports`.
status: Plan
---

# 004 — Hub imports: CLI steps

## Master plan

[CN plan 282](../../../../docs/plans/282-shapes-and-packages-per-hub.md) —
`/Users/rene/web/wt/hub-imports/docs/plans/282-shapes-and-packages-per-hub.md` (decisions,
rules for every step, status table, numbers, starter prompt). Steps land on the master branch
`hub-imports` in this worktree (`/Users/rene/web/wt/hub-imports/packages-local/_linked-cli`) with
`git merge --ff-only hub-imports--<agent>`; never on `dev` or `main` directly.

## Contracts

K7 and K8 are copied verbatim from plan 282; the rest are there. A step that changes one updates
it here and in 282 in the same landing.

- **K7 `package.json` keys** (providers BK in `_linked-cli` and VD; consumers CN): an
  `unpublishedPackages` entry `{name, repo, branch?}` (D17, G8); `linked.defaultOntology: "<npm
  name>"` (D23).
- **K8 Component index file** (provider CI in `_linked-cli`/`@_linked/react`; consumer CX): emitted
  by `linked build` next to `shapes.ttl`; per component its name, start shape, query wire format
  (`QueryBuilder.toJSON`) and query shape. File name and vocabulary: *open*, settled when wave 2 is
  detailed.

Note on K7: on disk the list stays keyed by npm name, as `unpublishedPackages()` in
`src/installed-packages.ts` reads it today: `"linked": {"unpublishedPackages": {"<npm name>":
{"repo": "<url>", "branch": "<branch>"}}}`. `{name, repo, branch?}` is the parsed entry
(`UnpublishedPackage`).

### KC — CLI surface of step CL (provider CL; consumers the master and every later step)

- **Port lock.** `linked branch start <m> --worktree …` chooses and records its preview port
  holding one machine-wide lock, `<LINKED_HOME>/locks/master-ports/linked.lock`
  (`LINKED_HOME` defaults to `~/.linked`; the env override is for tests). Same holder format,
  wait (120 s), stale take-over and refusal (exit 6) as the repo lock. Inside the lock the free
  port is the first `45k0` slot that neither this app's masters (git config, as today) nor the
  machine registry `<LINKED_HOME>/master-ports.json` holds. The registry maps
  `"<port>": {"app": "<main checkout>", "master": "<m>", "dir": "<master worktree>"}`; an entry
  whose `dir` no longer exists is dropped when read. `branch start --worktree` adds its entry
  before releasing the lock; `worktree remove <m>` (`forgetMaster`) removes it. `--port` is
  refused when the registry or this app's masters hold it, naming the holder:
  `Port 4520 is master hub-imports's (/Users/rene/web/wt/hub-imports). Pick another, or leave --port out.`
  The app's git config stays the record of its own masters; the registry only answers "is this
  port taken on this machine".
- **`src/integration/repo-lock.ts` API** (additions; `withRepoLock`, `withCheckoutLock`
  unchanged):
  - `withRepoLockAsync<T>(gitDir, what, fn: () => Promise<T>, options?): Promise<T>` — the same
    lock file and holder; waits with timers, not `Atomics.wait`; releases after `fn`'s promise
    settles.
  - `linkedHome(): string` — `process.env.LINKED_HOME ?? path.join(os.homedir(), '.linked')`.
  - `withMachineLockAsync<T>(name, what, fn, options?)` — `withRepoLockAsync` on
    `<linkedHome()>/locks/<name>` (directory made on demand).
- **`linked worktree relink --all [--json]`.** Relinks every worktree of the app: each master's
  worktree, then that master's steps, then the other agent worktrees (`worktree list --all`
  minus the main checkout). Run anywhere in the app. Refused together with an agent name,
  `--dir` or `--from`. Text output: per worktree its `relink` lines under a heading
  `<dir>:`; last line `Relinked <n> worktrees` or `Relinked <n> of <t>; failed: <dir>, …`. Exit
  0 when every one relinked, 1 otherwise (the rest still run). JSON:
  `{code, worktrees: [{dir, kind: 'master'|'step'|'agent', master?, code, messages}]}`.
- **`linked branch list [--json]`.** The app's integration branches and masters in one view,
  from `listMasters`, `worktreeList` and the `branch.<b>.linked-target` records of the app repo
  and every `packages-local/` checkout. Text:
  ```
  BRANCH        KIND         TARGET  REPOS                 WORKTREE                        PORT  DATASET  STEPS
  hub-imports   master       dev     app, _linked-cli, …   /Users/rene/web/wt/hub-imports  4520  -        2
  some-branch   integration  dev     app, _linked-core     (checkouts)                     -     -        -
  Other masters on this machine: 4510 plan-x (/Users/rene/web/other-app)
  ```
  JSON: `{branches: [{name, kind, target, repos: [{rel, target, worktree}], dir, port, dataset,
  steps: [<agent>]}], otherPorts: [{port, app, master, dir}]}`. Exit 0 (an empty list too).
- **`linked branch add-package <m> <packages...> [--target <branch>] [--json]`.** Adds
  `packages-local/` checkouts (`@_linked/core`, `core` or `_linked-core`) to running master
  `<m>`. Run anywhere in the app. Per package: a worktree `<m's dir>/packages-local/<dir>` on a
  new branch `<m>` from `--target` (default: that checkout's current branch), its nested
  `node_modules` linked as `branch start --worktree` does, `branch.<m>.linked-target` and
  `branch.<m>.linked-worktree` recorded in that repo; then `worktree relink` of the master and of
  each of its steps. Checks everything before making anything; refused (exit 1, nothing made)
  when `<m>` is not a master, a package is unknown or already in `<m>`, a checkout is detached
  without `--target`, the target does not exist, or the repo already has a branch `<m>`. A
  failure halfway undoes what this run made. Output: one line per worktree made and per relink,
  then `Master <m> now has: <dirs>` and `Build each added package there: npx linked build`. JSON:
  `{code, added: [{rel, dir, target}], relinked: [<dir>], messages}`.

## Steps

### CL — Master worktrees, part one (backlog 013)

**Depends on:** nothing (wave 1). Runs before the others need the CLI; until it lands the master
runs the CLI from `/Users/rene/web/create_now` (`npx linked`). **Once landed and built**, the
master runs its built copy: `node /Users/rene/web/wt/hub-imports/packages-local/_linked-cli/lib/esm/launch.js`
(this worktree has no `lib/` yet: `npx linked build` here first).

**Goal.** Two masters can start at the same time on one machine without taking the same preview
port; one command relinks every worktree after an `npm install`; one view lists branches and
masters; a framework package can join a running master by command.

**Scope.** Exactly KC above:

1. `linkedHome`, `withRepoLockAsync`, `withMachineLockAsync` in `src/integration/repo-lock.ts`.
2. The machine port registry (`src/integration/masters.ts`: `readPortRegistry`,
   `recordPort`, `releasePort`; `freeMasterPort(masters, registry)` takes both), used by
   `branchStartWorktree` (choose and record inside `withMachineLockAsync('master-ports', …)`)
   and by `forgetMaster`/`removeMaster` (release).
3. `worktree relink --all` (`worktreeRelinkAll` in `src/commands/worktree.ts`, `--all` in
   `src/cli.ts`).
4. `branch list` (`branchList`, `formatBranchList`, `runBranchList`; in `src/commands/master.ts`
   or `branch.ts`, whichever keeps imports acyclic).
5. `branch add-package` (`branchAddPackage`, `runBranchAddPackage` in `src/commands/master.ts`),
   with the per-package part of `createWorktreeSet` extracted into an exported
   `addPackageWorktree(spec, messages, run) → undo | null` that both use.
6. Docs: `docs/integration-branches-and-worktrees.md` §Masters (the three commands, the lock and
   registry), README command list; backlog 013 trimmed to what is left (`own-install`,
   `--package-only`, refusing a second copy, the two safety nets); changeset (minor).

Out of scope: `own-install`, `--package-only`, the safety nets of backlog 013, any CN change.

**Verify** (in the step's cli worktree):

- `npx jest --config jest.config.cjs tests/unit/integration tests/unit/checkout/repo-lock.test.ts`
  — the new and the existing master, worktree, branch and lock tests.
- `npm run test:unit` (`jest --config jest.config.cjs`) — the full unit suite. Without a built
  `lib/`, `shapeHierarchy` and `ontologyDataReachable` fail on untouched code too (report 040):
  build first, then run.
- `npx linked build` — clean.
- The built CLI end to end in a sandbox under the scratchpad, with `LINKED_HOME` pointing into it:
  two `branch start <m> --worktree` started in parallel from two sandbox apps (`&` and `wait`)
  get different ports; `branch list` (text and `--json`) in each; `branch add-package` on one
  master with a step present, then the step's farm shows the added package as an overlay;
  `worktree relink --all`; `worktree remove` of the step and the master frees the registry entry.
  Output quoted in the report.
- Not run: `npm run test:e2e` (Docker); CN's tests (no CN change).

**Done when:** the four commands behave as KC says; the tests below pass; full unit suite green
after the build; sandbox run quoted; docs, backlog 013 and the changeset in the landing; report
`docs/reports/041-master-worktrees-part-one.md` (two parts: `## PR`, `## Details`); this section
ticked in §Progress; landed by ff-only into `hub-imports` in
`/Users/rene/web/wt/hub-imports/packages-local/_linked-cli`; then the master builds it there.

**Files found in code:**

- `src/commands/master.ts` — `branchStartWorktree` (line 73): `listMasters` at 109, the port
  chosen at 114 (`freeMasterPort`), `createWorktreeSet` at 132, `linked-port` recorded at 157.
  The function is async throughout (`listMasters`, `setTarget` await), so the lock around
  choose-and-record must be the async variant.
- `src/integration/masters.ts` — `Master`, `MASTER_PORTS`, `masterOf`, `listMasters` (git config
  `branch.*.linked-worktree` of one app repo), `freeMasterPort`, `stepPorts`, `forgetMaster`.
- `src/integration/repo-lock.ts` — `acquire` (file `linked.lock`, `wx` create, stale take-over),
  `withRepoLock` (line 149, sync, re-entrant per process via `held`, `sleep` = `Atomics.wait`),
  `commonDirOf`, `withCheckoutLock`. Callers: `src/commands/checkout.ts`,
  `src/commands/branch-fork-merge.ts`.
- `src/commands/worktree.ts` — `createWorktreeSet` (163; app worktree, `.env` links, then the
  package loop 226-244, then the farm), `worktreeList` (710; hides the master it is run in),
  `everyWorktree` (700), `findAppWorktree`, `removeMaster` (1045), `worktreeRelink` (1160-1208,
  one dir), `runWorktreeRelink` (1219), `MasterWorktrees` (675).
- `src/commands/worktree-node-modules.ts` — `farmOverlays(dir, parent)` (266), `readFarmMarker`,
  `linkNodeModules`, `overlaysOf`.
- `src/commands/branch.ts` — `branchStatus` (158), `selectCheckouts` (245), `worktreesOf`,
  `refExists`, `localBranchExists`.
- `src/integration/repos.ts` — `getTarget`/`setTarget` (`branch.<b>.linked-target`), `listRepos`.
- `src/cli.ts` — `branch` (674: `status`, `start`, `land`, `fork`, `push`, `merge`) and
  `worktree` (778: `add`, `list`, `remove`, `relink` at 842).

**Pitfalls:**

- `withRepoLock` around an async `fn` releases before the promise settles (its `finally` runs at
  once): never wrap `branchStartWorktree`'s body in it; use `withRepoLockAsync`.
- The sync lock's `held` map makes a second acquisition in the same process re-entrant. The async
  variant must not inherit that: two overlapping async calls in one process would both "re-enter".
  Keep its own per-key queue (or no re-entry) and test two overlapping calls.
- A lock alone does not stop two different apps (two app repos, two git configs) from picking the
  same slot one after the other: the registry is what makes the choice machine-wide.
- Tests must never touch the real `~/.linked`: every test sets `LINKED_HOME` to a temp dir.
- `createWorktreeSet` always adds the app worktree first, so `add-package` cannot call it as it
  is; extract the package loop, keeping `createWorktreeSet`'s messages and undo order unchanged.
- Steps do not farm into the master's `node_modules`: their marker's `installRoot` is the main
  install and `parent` names the master, whose `overlaysOf` is read from its directory. A step
  therefore sees a package added to the master on its next relink, whatever the order; `--all`
  still relinks masters first so the output reads top-down.
- `worktreeList` run inside a master's worktree omits that master; `relink --all` and
  `branch list` resolve the main checkout first (`mainCheckoutOf`) and list from there.
- `add-package` while a step holds a worktree of the same package on `<m>--<agent>`: impossible
  today (a step can `--with` only the master's packages), but check and refuse rather than assume.
- The master's own CLI must not change under it mid-wave: land CL, then `npx linked build` in the
  master's cli worktree, then the master switches to the built bin.

**Tests:**

- New, `tests/unit/checkout/repo-lock.test.ts`: `withRepoLockAsync` holds across an awaited
  `fn` (a second waiter gets it only after the promise settles); two overlapping calls in one
  process serialize; a stale holder is taken over; a timeout refuses with exit 6 naming the
  holder; `withMachineLockAsync` creates `<LINKED_HOME>/locks/<name>`.
- New, `tests/unit/integration/master.test.ts`:
  - two `branchStartWorktree` calls started together (`Promise.all`) in two sandbox apps sharing
    one `LINKED_HOME` get different ports, and both are in the registry;
  - `--port` held by another app's master (registry only) is refused, nothing made;
  - a registry entry whose `dir` is gone is ignored and dropped;
  - removing a master releases its port;
  - `branch list`: a master and a plain integration branch, text and JSON, `otherPorts`;
  - `branch add-package`: worktree on `<m>`, both records, the master's and the step's farms
    gain the overlay; refusals (not a master, already present, unknown package, branch `<m>`
    exists) change nothing; a failing `git worktree add` undoes the earlier packages.
- New, `tests/unit/integration/worktree.test.ts`: `relink --all` relinks a plain agent worktree,
  a master and its step; one broken worktree fails with exit 1 while the others relink; `--all`
  with an agent name is refused.
- Existing, must stay green: `tests/unit/integration/master.test.ts`,
  `tests/unit/integration/worktree.test.ts`, `tests/unit/integration/branch.test.ts`,
  `tests/unit/integration/repos.test.ts`, `tests/unit/checkout/repo-lock.test.ts`,
  `tests/unit/checkout/land.e2e.test.ts`, `tests/unit/worktreeNodeModules.test.ts`,
  `tests/unit/doctorResolve.test.ts`.

**Size and phases:** small–medium; no plan doc of its own (282 §Numbers), report cli 041.

1. Locks and the registry (`repo-lock.ts`, `masters.ts`, `branchStartWorktree`,
   `forgetMaster`/`removeMaster`) with their tests.
2. `worktree relink --all` and `branch list` with their tests.
3. `addPackageWorktree` extraction and `branch add-package` with its tests.
4. Docs, backlog 013, changeset, `npx linked build`, full unit suite, sandbox run, report.

One commit per phase; sequential (one agent).

### CI — Component index build (K8)

*Detailed when wave 2 starts.* With `@_linked/react`: `linked build` emits the component index
file next to `shapes.ttl` (built in a child node like `shapes.ttl`, `src/utils/shapesTurtle.ts`
and `src/utils/shapesIndex.ts` are the precedents); per component its name, start shape, query
wire format (`QueryBuilder.toJSON`) and query shape; a `components/index` entry convention (G5).
File name and vocabulary settled then (K8). Plan doc cli `005-…`; reports cli `042-…`, react
`004-…`.

### BK — The `branch` key (K7, D17, G8)

*Detailed when wave 3 starts.* Sensitive (CN commits `branch` keys into app repos; checkout pins).
Cli side:

- `UnpublishedPackage` gains `branch?: string` and `unpublishedPackages()` in
  `src/installed-packages.ts` parses and validates it (a valid branch name, else exit 6 naming
  the entry).
- `walkUnpublished` (`src/integration/unpublished.ts`): only the app's own list's `branch` keys
  count; a `branch` key in a package's (transitive) list is ignored with a warning, and a name
  listed by the app with one branch and reached again elsewhere is not a conflict on `branch`
  (only on `repo`, as today).
- `linked checkout`: the app's `branch` keys feed `targetOf` (`src/commands/checkout.ts` 738) as
  pins, with `--pins-only` kept (G8); an explicit `--pin` wins over a key.
- `linked localize --listed` (`src/localize/localize.ts` 246-268): clones each listed package on
  its `branch` when it has one.
- `linked branch merge` (`src/commands/branch-fork-merge.ts`, `branchMerge` 530): merges the named
  package branches first, then strips their `branch` keys from the app's `package.json` in the
  merge commit.

Plan doc CN `290-…`; reports CN `291-…`, cli `043-…`.

## Progress

- [ ] CL — machine-wide port lock and registry, `withRepoLockAsync`, `worktree relink --all`,
  `branch list`, `branch add-package` (report 041)
- [ ] CL landed in `hub-imports` and built in the master's cli worktree; master on the built bin
- [ ] CI — component index build (detailed at wave 2; report 042)
- [ ] BK — `branch` key, cli side (detailed at wave 3; report 043)
