---
date: 2026-10-30
summary: >
  `@_linked/cli` gained a machine-wide master port lock and registry, `worktree relink --all`,
  `branch list` and `branch add-package`; `linked build` writes a package's component index
  (`lib/esm/data/components.ttl`); an `unpublishedPackages` entry can carry a `branch` key that
  checkout pins and `branch merge` lands and strips. Done; three minor and one patch changeset.
---

# 044 — Hub imports: cli

## PR

### Summary

Three pieces:

- **Masters, part one.** Two masters started at once, in one app or in two, never take the same
  preview port (a machine-wide lock and port registry under `~/.linked`). One command relinks every
  worktree of an app, one lists its integration branches and masters, and a framework package can
  join a running master by command.
- **Component index.** `linked build` writes `lib/esm/data/components.ttl` for a package that
  exports linked components from `src/components/index.ts`: per component its export name, start
  shape, query shape and query wire format, as deterministic Turtle a host can store and
  hash-replace without running component code. `@_linked/react` generates the text; the CLI loads
  the built package in a child and writes the file.
- **The `branch` key.** An app branch names the package branch it uses in its own `package.json`
  (`"acme-ont": {"repo": "…", "branch": "rene/topic"}`). `linked checkout` places a keyed package
  as a pin, `linked localize --listed` clones it on that branch, and `linked branch merge` lands
  the keyed branch before the packages on the app branch and strips every key, so `main` lists
  none.

### Changes

- **Locks** (`src/integration/repo-lock.ts`): `withRepoLockAsync(gitDir, what, fn, options?)`
  (same lock file and holder as `withRepoLock`, timer waits, never re-entrant: overlapping calls
  queue per lock), `linkedHome()` (`$LINKED_HOME`, else `~/.linked`), `withMachineLockAsync(name,
  …)`; both loops share `tryAcquire`; `withRepoLock` unchanged.
- **Port registry** (`src/integration/masters.ts`): `readPortRegistry`, `recordPort`,
  `releasePort`, `portHolder`, `freeMasterPort(masters, registry)`; atomic writes.
- **`branch start --worktree`** (`src/commands/master.ts`, `makeMaster`) holds the `master-ports`
  machine lock from choosing the port to recording it; `--port` refusal names the holder; a lock
  timeout is exit 6 with nothing made. `worktree remove <m>` (`removeMaster`) releases the entry.
- **`worktree relink --all [--json]`** (`worktreeRelinkAll`, `formatRelinkAll`).
- **`branch list [--json]`** (`branchList`, `formatBranchList`, `runBranchList`).
- **`branch add-package <m> <packages...> [--target] [--json]`** (`branchAddPackage`,
  `runBranchAddPackage`); `addPackageWorktree(spec, messages, run) → undo | null` extracted from
  `createWorktreeSet`, which uses it (messages and undo order unchanged).
- **Component index build step** (`src/utils/componentsTurtle.ts`): `COMPONENTS_TURTLE_PATH`,
  `collectComponentsTurtleInputs`, `generateComponentsTurtle`, `writeComponentsTurtleStep`,
  `ASSET_RESOLVE_HOOK`; the step `Writing components.ttl` in `planBuildSteps`, right after
  `Writing shapes.ttl`, skipped by `--skip-shape-check`.
- **Branch key**: `src/integration/branchName.ts` (`isBranchName`); `src/installed-packages.ts`
  (`UnpublishedPackage.branch?`, validation in `unpublishedPackages()`);
  `src/integration/unpublished.ts` (`walkUnpublished` keeps keys from the root list only,
  `pinsFromKeys`, `stripBranchKeys`); `src/commands/checkout.ts` (keys as pins,
  `CheckoutPackage.pinFrom`, keys ignored on the app's default branch, a pinned worktree moves on
  a non-fast-forward pin change only when clean); `src/localize/localize.ts` (`--listed` on the
  key's branch); `src/commands/branch-fork-merge.ts` (keyed branches landed first, keys stripped,
  `MergeResult.strippedKeys`, `MergeRepo.via`, the same-name refusal).
- Help text in `src/cli.ts`; docs: README, `docs/localize.md`,
  `docs/integration-branches-and-worktrees.md` (Masters: registry and lock, `branch list`,
  `branch add-package`, `relink --all`; merge with branch keys; checkout pins).
- Tests: `tests/setup-linked-home.cjs` (jest `setupFiles`: a temporary `LINKED_HOME` per test
  file); new or extended `repo-lock`, `integration/master`, `integration/worktree`,
  `componentsTurtle` (11), `esmSpecifiers` (step list), `integration/branchName` (37 names against
  git), `unpublished`, `pins.e2e`, `listed`, `land.e2e`.
- Changesets: `master-worktrees-part-one.md` (minor), `component-index.md` (minor),
  `branch-key.md` (minor), `branch-key-review.md` (patch).

### Verification

- Report 041 (masters): build `✔ Build successful`; targeted run `Test Suites: 6 passed, 6 total`
  / `Tests: 106 passed, 106 total`; `npm run test:unit` `Test Suites: 101 passed, 101 total` /
  `Tests: 1196 passed, 1196 total`. Sandbox: two parallel `branch start --worktree` runs in two
  apps sharing one `LINKED_HOME` got ports 4510 and 4520, both recorded in `master-ports.json`,
  lock directory empty afterwards.
- Report 042 (component index): `jest tests/unit/componentsTurtle.test.ts
  tests/unit/shapesTurtle.test.ts` → `Tests: 23 passed, 23 total`; `node lib/esm/launch.js build`
  → `✔ Writing components.ttl` / `✔ Build successful`; `npm run test:unit` → `Test Suites: 102
  passed, 102 total` / `Tests: 1207 passed, 1207 total`. Sandbox package built twice: `cmp` →
  `IDENTICAL`, `shasum -a 256` →
  `d35a60a68c0b794f8e55dac5b3359a95938f74f37a78663f0a6cc70c63330e6f`; `fromJSON` round trip of
  each indexed query equals the literal; with `components/index.ts` deleted, no file and
  `lib/esm/data` holds only `shapes.ttl`.
- Report 043 (branch key): the plan's jest list → `Test Suites: 7 passed, 7 total` / `Tests: 113
  passed, 113 total`; sandbox with `file://` remotes: checkout `pinFrom: "key"`, `--pin` wins
  (`pinFrom: "flag"`), `localize --listed` on `rene/topic`, `branch merge --mode push` →
  `"strippedKeys":["acme-ont"]`, `branch keys on origin/main: 0`. Review fixes: `pins.e2e` +
  `land.e2e` `Tests: 29 passed, 29 total`.
- Last full suite (report 043, after the review fixes): `npm run test:unit` → `Tests: 1263
  passed, 1263 total`.
- Not run: `npm run test:e2e` (Docker).

### Deviations

- A registry entry whose `dir` is gone is ignored on read and dropped at the next write under the
  lock (reads such as `branch list` never write).
- `relink --all` leaves a worktree with an install of its own as it is (code 0); `branch list`
  names at most five repos per text row (`… (+n)`), JSON has all.
- The component step also leaves out, with a warning, a component whose `.shape` has no node
  shape or whose query names no shape; generator warnings go through an out-param, so
  `componentIndexTurtle` keeps its `string | undefined` return.
- Branch keys become pins before the dependency walk (packages are placed during it).
- A detached pinned worktree now moves when its pin changes to a non-fast-forward target, but only
  without uncommitted changes or commits origin lacks; otherwise it is `kept`, naming the
  worktree.
- Keys on the app's default branch are ignored with a message; `branch merge` refuses a key naming
  the merged branch when no checkout of that package is on it.

### Follow-ups

- Remaining master-worktree work (`own-install`, `--package-only`, refusing a second copy, the
  safety nets; building the CLI in a fresh worktree; two copies of core in an agent worktree):
  `docs/backlog/013-master-worktrees-remaining.md`.
- A `Checking components/index` build check: `docs/backlog/014-checking-components-index.md`.
- Stale `lib/` output surviving a rebuild within 120 s: `docs/backlog/015-stale-lib-files-within-two-minutes.md`.
- Branch key leftovers (push mode with an app already in `<into>`, one-line object reflow, no
  command sets a key): `docs/backlog/016-branch-key-follow-ups.md`.

## Details

### Contract: masters CLI surface (KC in the hosting application's plan 282)

- **Port lock.** `linked branch start <m> --worktree …` chooses and records its preview port
  holding one machine-wide lock, `<LINKED_HOME>/locks/master-ports/linked.lock` (`LINKED_HOME`
  defaults to `~/.linked`; the override is for tests). Same holder format, wait (120 s), stale
  take-over and refusal (exit 6) as the repo lock. Inside the lock the free port is the first
  `45k0` slot that neither this app's masters (git config) nor the machine registry
  `<LINKED_HOME>/master-ports.json` holds. The registry maps `"<port>": {"app": "<main checkout,
  real path>", "master": "<m>", "dir": "<master worktree>"}`; an entry whose `dir` is gone is
  ignored when read and dropped at the next write. `branch start --worktree` adds its entry before
  releasing the lock; `worktree remove <m>` (`forgetMaster`) removes it (a failed release is a
  message, the remove still succeeds). `--port` is refused when the registry or this app's masters
  hold it, naming the holder: `Port 4520 is master <m>'s (<dir>). Pick another, or leave --port
  out.` The app's git config stays the record of its own masters; the registry only answers "is
  this port taken on this machine". `branch list` and `worktree list` never create `~/.linked`.
- **`src/integration/repo-lock.ts`**: `withRepoLockAsync<T>(gitDir, what, fn: () => Promise<T>,
  options?): Promise<T>` (same lock file and holder; timer waits; released after `fn` settles; a
  nested call on the same lock waits forever), `linkedHome(): string`,
  `withMachineLockAsync<T>(name, what, fn, options?)` (on `<linkedHome()>/locks/<name>`, directory
  made on demand). `withRepoLock`, `withCheckoutLock` unchanged.
- **`linked worktree relink --all [--json]`**: every worktree of the app, masters, then their
  steps, then other worktrees (`worktree list --all` minus the main checkout); runs anywhere in the
  app; refused with an agent name, `--dir` or `--from`. A worktree with its own install is left as
  it is (code 0, one line). Text: per worktree its `relink` lines under `<dir>:`; last line
  `Relinked <n> worktrees` or `Relinked <n> of <t>; failed: <dir>, …`. Exit 0 when all relinked, 1
  otherwise. JSON `{code, worktrees: [{dir, kind: 'master'|'step'|'agent', master?, code,
  messages}]}`.
- **`linked branch list [--json]`**: integration branches and masters from `listMasters`,
  `worktreeList` and the `branch.<b>.linked-target` records of the app repo and every
  `packages-local/` checkout. Text columns `BRANCH KIND TARGET REPOS WORKTREE PORT DATASET STEPS`,
  masters first then integration branches, each by name; TARGET is the app's target, else the first
  repo's; at most five repos per row; a line `Other masters on this machine: …`; no records →
  `No integration branches or masters.` JSON `{branches: [{name, kind, target, repos: [{rel,
  target, worktree}], dir, port, dataset, steps}], otherPorts: [{port, app, master, dir}]}`. Exit 0.
- **`linked branch add-package <m> <packages...> [--target <branch>] [--json]`**: adds
  `packages-local/` checkouts (`@_linked/core`, `core` or `_linked-core`) to running master `<m>`.
  Per package a worktree `<m's dir>/packages-local/<dir>` on a new branch `<m>` from `--target`
  (default: that checkout's current branch), its nested `node_modules` linked into the master's
  farm `installRoot` (else the main checkout), `branch.<m>.linked-target`/`-worktree` recorded;
  then `worktree relink` of the master and each step. Checks everything first; refused (exit 1,
  nothing made) when `<m>` is not a master, a package is unknown or already in `<m>` (record or
  directory), a checkout is detached without `--target`, the target is missing, branch `<m>`
  exists, or a step has a worktree of it (`<m>--*`). A failure halfway undoes the run; a relink
  failing afterwards keeps the worktrees and exits 1 (rerun `worktree relink --all`). Output ends
  `Master <m> now has: <dirs>` and `Build each added package there: npx linked build`. JSON
  `{code, added: [{rel, dir, target}], relinked: [<dir>], messages}`.

### Contract: component index build step (K8)

The file's format (enumeration, vocabulary, IRIs, per-component triples, determinism) is
`@_linked/react`'s report 005; the terms are `@_linked/core`'s report 088. The CLI's part:

- Step `Writing components.ttl`, right after `Writing shapes.ttl`, runs when
  `lib/esm/components/index.js` exists and `@_linked/react` is in `dependencies` or
  `peerDependencies`; otherwise a quiet skip. `--skip-shape-check` skips it too.
- A child `node` imports `lib/esm/package.js` (when present; sets the publish root, so
  `getPackageUri` is the package's), `lib/esm/shapes/index.js` (when present) and
  `lib/esm/components/index.js`, with `ASSET_RESOLVE_HOOK` (resolves a relative asset specifier
  even when the build did not copy the file) before the unchanged `ASSET_HOOK`, then calls
  `componentIndexTurtle(packageName, componentsModule)` from `@_linked/react/utils/componentIndex`
  of the react the package resolves. `packageName` is the `linkedPackage('<name>')` name, else
  `package.json`'s.
- No linked component, no file; a file from an earlier build is removed whenever none is written.
  A react without `utils/componentIndex`: skipped with a warning. A module that throws on import
  fails the build. Generator warnings show as the step's warning string
  (`lib/esm/data/components.ttl written; <w1>; <w2>` or `no components.ttl written; …`).

### Contract: `package.json` keys (K7)

- On disk the list is keyed by npm name: `"linked": {"unpublishedPackages": {"<npm name>":
  {"repo": "<url>", "branch": "<branch>"}}}`; the parsed entry is `UnpublishedPackage = {name,
  repo, branch?}` (`unpublishedPackages()` in `src/installed-packages.ts`).
- `branch` is a valid git branch name (`isBranchName`, the rules of `git check-ref-format
  --branch`) other than `main`; `main`, `HEAD`, `""`, an invalid name or a non-string is refused
  with exit 6 naming the entry. Only the app's own list counts; a key in a package's (transitive)
  list is ignored with a warning; the conflict check stays on `repo`.
- `linked checkout` reads the keys as pins (`{...pinsFromKeys(appList), ...--pin}`: an explicit
  `--pin` wins, with a message; a key alone puts the run in pins mode; a workspace host passes
  `--pins-only` and no `--pin`); `CheckoutPackage.pinFrom: 'key' | 'flag'`. Keys are ignored, with
  a message per key, when the app branch is the app's default branch (origin's HEAD). A detached
  pinned worktree whose head origin has moves to a changed pin only when it has no uncommitted
  changes and no commits origin lacks; otherwise `kept`, the reason starting with its path.
- `linked localize --listed` clones a keyed entry on its key (falling back to the default branch
  with a log line), else on the app's branch.
- `linked branch merge` reads the keys from `origin/<branch>:package.json`. A key naming
  `<branch>` merges as a package on the branch, but is refused (exit 6, nothing merged) when no
  checkout of that package is on `<branch>`. A key naming another `<k>`: push mode merges
  `origin/<k>` into `<into>` first, from that package's checkout (none, or no `origin/<k>`: exit
  6); update mode refuses unless `origin/<into>` contains `origin/<k>`. Order: keyed packages by
  dependency, then the packages on `<branch>` by dependency, the app last. Every key is stripped
  from the app's `package.json` (`stripBranchKeys`: key order, indent, trailing newline and CRLF
  kept): push mode amends the app's merge commit before the push; update mode commits `Use <into>
  of <pkgs>` on the branch. `MergeResult.strippedKeys: string[]`, `MergeRepo.via: 'key' |
  'branch'`; `landed` for a keyed package compares `origin/<k>` with `origin/<into>`.
- `linked.defaultOntology: "<npm name>"` is the other key of K7; the CLI does not read it.

### Decisions that shaped it

- One critical section for `branch start`: the machine lock covers port choice, worktree creation
  and both records, so a crash leaves no half-reserved entry (a stale lock is taken over).
- No registry write outside the lock; every test file gets a temporary `LINKED_HOME`, so no test
  can reach `~/.linked`.
- The component index follows the `shapes.ttl` split: the library that owns the factory
  generates, the CLI only loads the built package. One bad component costs one entry, never the
  build.
- Branch keys are pins, not a second mechanism; keys never reach `main` (stripped in the landing
  commit), and a worktree's work is never dropped silently (the same-name refusal).

### Step reports

| Report | What it covers |
|---|---|
| [041 — Master worktrees, part one](041-master-worktrees-part-one.md) | Port lock and registry, async and machine locks, `relink --all`, `branch list`, `branch add-package`; decisions D1–D18 |
| [042 — Component index](042-component-index.md) | `Writing components.ttl` and the whole three-repo step (core terms, react generator), sandbox file; decisions C1–C12 |
| [043 — The branch key](043-branch-key.md) | Parser, walk, checkout pins, `localize --listed`, merge lands and strips; the review addendum |

### At release

- `@_linked/core` publishes before `@_linked/react` (the generator needs the component terms);
  the build step only needs a react with `utils/componentIndex` at the package's build time, and
  skips with a warning otherwise.
