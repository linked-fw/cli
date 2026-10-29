---
date: 2026-10-29
summary: >
  Masters, part one (backlog 013): `branch start --worktree` chooses, makes and records its
  preview port inside a machine-wide lock (`<LINKED_HOME>/locks/master-ports`) against a machine
  port registry (`<LINKED_HOME>/master-ports.json`), released by `worktree remove <m>`;
  `withRepoLockAsync`, `linkedHome`, `withMachineLockAsync`; `worktree relink --all`;
  `branch list`; `branch add-package <m> <packages...>` (with `addPackageWorktree` extracted from
  `createWorktreeSet`). Minor. Step CL of CN plan 282, sub-plan 004.
---

# 041 — Master worktrees, part one

## PR

### Summary

Two masters started at the same time, in one app or in two, no longer take the same preview port.
After an `npm install` in the main checkout, one command relinks every worktree of the app. One
command lists the app's integration branches and masters. A framework package can join a running
master by command. This is step CL of CN plan 282 (sub-plan [004](../plans/004-hub-imports-cli.md)
§CL, contract KC) and the first part of backlog [013](../backlog/013-master-worktrees-remaining.md).
013 is trimmed to what is still left.

### Changes

- **Locks** (`src/integration/repo-lock.ts`):
  - `withRepoLockAsync(gitDir, what, fn, options?)` uses the same lock file and holder format as
    `withRepoLock`. It waits with timers, holds the lock until `fn`'s promise settles, and is never
    re-entrant: calls that overlap in one process queue per lock.
  - `linkedHome()` returns `$LINKED_HOME`, else `~/.linked`.
  - `withMachineLockAsync(name, …)` takes `<linkedHome()>/locks/<name>`, making the directory
    when it is missing.
  - Both loops now share one acquire step (`tryAcquire`); `withRepoLock` is unchanged.
- **Port registry** (`src/integration/masters.ts`):
  - `readPortRegistry` (never writes; skips an entry whose `dir` is gone), `recordPort`,
    `releasePort`, `portHolder`, and `freeMasterPort(masters, registry)`.
  - The registry is written atomically (temp file, then rename). An entry whose `dir` is gone is
    dropped at the next write.
- **`branch start --worktree`** (`src/commands/master.ts`) holds the `master-ports` machine lock
  while it reads this app's masters and the registry, chooses or checks the port, makes the
  worktrees, records git config and adds its registry entry.
  - The body that runs after the checks moved into `makeMaster`.
  - The `--port` refusal names the holder:
    `Port 4510 is master ma's (<dir>). Pick another, or leave --port out.`
  - A lock timeout returns exit 6 and makes nothing.
- **`worktree remove <m>`** (`removeMaster`) releases the master's registry entry under the same
  lock and prints `Released preview port <p> on this machine.`
- **`worktree relink --all [--json]`** (`worktreeRelinkAll`, `formatRelinkAll`, the `--all` and
  `--json` options in `src/cli.ts`):
  - Relinks masters first, then their steps, then the other worktrees, and runs anywhere in the
    app.
  - A worktree with an install of its own is left as it is (code 0).
  - It goes on past a failure and exits 1 when any worktree failed.
  - It is refused together with an agent name, `--dir` or `--from`.
- **`branch list [--json]`** (`branchList`, `formatBranchList`, `runBranchList`):
  - Reads the `branch.<b>.linked-target`/`-worktree` records of the app repo and every
    `packages-local/` checkout, plus the masters' ports, datasets and steps.
  - `otherPorts` lists the registry's masters of other apps.
  - A row names at most five repos; `--json` has all of them.
  - It lists from the main checkout wherever it runs.
- **`branch add-package <m> <packages...> [--target] [--json]`** (`branchAddPackage`,
  `runBranchAddPackage`):
  - Checks everything first. It refuses when `<m>` is not a master, a package is unknown or
    already in `<m>`, a checkout is detached without `--target`, the target is missing, branch
    `<m>` exists, or a step has a worktree of the package.
  - Per package it makes the worktree on `<m>` with its nested `node_modules` link and records
    `linked-target`/`-worktree` in that repo.
  - A failure undoes the whole run. It then relinks the master and each of its steps.
  - `addPackageWorktree(spec, messages, run) → undo | null` is the per-package part of
    `createWorktreeSet`, and both now use it. The messages and the undo order are unchanged.
- **Tests**:
  - `tests/setup-linked-home.cjs` (jest `setupFiles`) gives every test file a temporary
    `LINKED_HOME`.
  - New tests in `tests/unit/checkout/repo-lock.test.ts` (4), `tests/unit/integration/master.test.ts`
    (10) and `tests/unit/integration/worktree.test.ts` (3).
- **Docs and release**:
  - `docs/integration-branches-and-worktrees.md` (§Masters: registry and lock, `branch list`,
    `branch add-package`; `worktree relink --all`) and the README command list.
  - Changeset `master-worktrees-part-one.md` (minor).

### Verification

Run in `/Users/rene/web/wt/hub-imports--cl/packages-local/_linked-cli`.

The build: `/Users/rene/web/create_now/node_modules/.bin/linked build`. `npx linked build` finds no
`linked` bin in a fresh cli worktree; see Deviations.

```
✔ Writing shapes.ttl
✔ Checking sideEffects
✔ Checking dependencies
✔ Build successful
/Users/rene/web/create_now/node_modules/.bin/linked build  10.35s user 1.24s system 92% cpu 12.582 total
```

`npx tsc --noEmit -p tsconfig.json` printed no errors.

`npx jest --config jest.config.cjs tests/unit/integration tests/unit/checkout/repo-lock.test.ts`
(the final run):

```
Test Suites: 6 passed, 6 total
Tests:       106 passed, 106 total
Time:        83.916 s, estimated 96 s
```

The same run plus `land.e2e`, `worktreeNodeModules` and `doctorResolve` (at the end of phase 3):
`Test Suites: 9 passed, 9 total / Tests: 129 passed, 129 total / Time: 72.587 s`.

`npm run test:unit` (full, after the build):

```
Test Suites: 101 passed, 101 total
Tests:       1196 passed, 1196 total
Time:        73.206 s, estimated 87 s
npm run test:unit  148.27s user 140.77s system 392% cpu 1:13.69 total
```

**Sandbox run of the built CLI.** The sandbox is two apps `a/app` and `b/app` under the scratchpad.
Each is on `dev` (target `main`) with `_linked-server` and `_linked-core`, and both share
`LINKED_HOME=<sb>/home`.

Two `branch start` runs started in parallel get different ports, and both are recorded:

```
$ (cd a/app && linked branch start ma --worktree --with server) & (cd b/app && linked branch start mb --worktree --with core) & wait
Preview link: http://localhost:4510 (its test runs: CN_TEST_PORT=4511; steps: ports 4512-4519).
a exit 0
Preview link: http://localhost:4520 (its test runs: CN_TEST_PORT=4521; steps: ports 4522-4529).
b exit 0
$ cat $LINKED_HOME/master-ports.json
{ "4510": {"app": "<sb>/a/app", "master": "ma", "dir": "<sb>/a/wt/ma"},
  "4520": {"app": "<sb>/b/app", "master": "mb", "dir": "<sb>/b/wt/mb"} }
$ ls $LINKED_HOME/locks/master-ports/        (empty: released)
```

`branch list` in each app, after `worktree add s1 --from ma --with server` in `a`:

```
$ linked branch list            (in a/app)
BRANCH  KIND         TARGET  REPOS                              WORKTREE      PORT  DATASET  STEPS
ma      master       dev     app, _linked-server                <sb>/a/wt/ma  4510  -        1
dev     integration  main    app, _linked-core, _linked-server  (checkouts)   -     -        -
Other masters on this machine: 4520 mb (<sb>/b/app)
$ linked branch list            (in b/app)
mb      master       dev     app, _linked-core                  <sb>/b/wt/mb  4520  -        0
dev     integration  main    app, _linked-core, _linked-server  (checkouts)   -     -        -
Other masters on this machine: 4510 ma (<sb>/a/app)
$ linked branch list --json     (in b/app)
{"branches": [{"name": "mb", "kind": "master", "target": "dev", "repos": [{"rel": ".", "target": "dev", "worktree": "<sb>/b/wt/mb"}, {"rel": "packages-local/_linked-core", …}], "dir": "<sb>/b/wt/mb", "port": 4520, "dataset": null, "steps": []}, {"name": "dev", "kind": "integration", …}],
 "otherPorts": [{"port": 4510, "app": "<sb>/a/app", "master": "ma", "dir": "<sb>/a/wt/ma"}]}
```

`branch add-package` on `ma`, run from the step's worktree with the step present:

```
before: step farm @_linked/core -> <sb>/a/app/node_modules/@_linked/core
$ linked branch add-package ma core
<sb>/a/wt/ma/packages-local/_linked-core: @_linked/core on ma
<sb>/a/wt/ma: relinked
<sb>/a/wt/ma--s1: relinked
Master ma now has: _linked-core, _linked-server
Build each added package there: npx linked build
(exit 0)
after: step farm @_linked/core -> <sb>/a/wt/ma/packages-local/_linked-core
step marker overlays: {"@_linked/core": "<sb>/a/wt/ma/packages-local/_linked-core", "@_linked/server": "<sb>/a/wt/ma--s1/packages-local/_linked-server"}, parent <sb>/a/wt/ma
$ linked branch add-package ma core
packages-local/_linked-core: already in master ma (<sb>/a/wt/ma/packages-local/_linked-core).
Nothing was made.
(exit 1)
```

`worktree relink --all`, after a package was installed in `a/app`, then removing the step and the
master:

```
$ linked worktree relink --all
<sb>/a/wt/ma:
  <sb>/a/wt/ma/node_modules: links into <sb>/a/app/node_modules (4 entries), with @_linked/core -> packages-local/_linked-core, @_linked/server -> packages-local/_linked-server
<sb>/a/wt/ma--s1:
  <sb>/a/wt/ma--s1/node_modules: links into <sb>/a/app/node_modules (4 entries), with @_linked/core -> ../ma/packages-local/_linked-core, @_linked/server -> packages-local/_linked-server
Relinked 2 worktrees
(exit 0)
lodash in step farm: <sb>/a/app/node_modules/lodash
$ linked worktree remove ma--s1       (exit 0)
$ linked worktree remove ma
…
Forgot master ma (its branch.ma.linked-worktree, -port and -dataset records).
Released preview port 4510 on this machine.
(exit 0)
$ cat $LINKED_HOME/master-ports.json
{ "4520": {"app": "<sb>/b/app", "master": "mb", "dir": "<sb>/b/wt/mb"} }
```

**The running master `hub-imports` read with the built bin.** These are read-only commands, run in
`/Users/rene/web/create_now` with the real `LINKED_HOME`:

```
$ linked branch list
BRANCH       KIND         TARGET  REPOS                                                          WORKTREE                        PORT  DATASET  STEPS
hub-imports  master       dev     app, _linked-cli, _linked-core, _linked-react, _linked-server  /Users/rene/web/wt/hub-imports  4520  -        3
side-225     master       dev     app                                                            /Users/rene/web/wt/side-225     4510  -        3
dev          integration  main    app, _linked-auth, _linked-cli, _linked-core, … (+20)          (checkouts)                     -     -        -
$ linked branch list --json   → hub-imports: port 4520, target dev, 5 repos each with its worktree, steps ["cl","hi","sy"]; otherPorts []
$ linked worktree list        → Master hub-imports (target dev, preview http://localhost:4520), steps cl, hi, sy; Master side-225 (4510) …  (exit 0)
$ linked branch status        → Integration branch: dev (target main), rows as before (exit 0)
$ ls -d ~/.linked             → No such file or directory   (nothing was written)
```

Not run: `npm run test:e2e` (Docker), and CN's tests (no CN change).

### Deviations from the plan

- **A registry entry whose `dir` is gone is ignored when read and dropped at the next write**
  (KC says "dropped when read"). Reads happen outside the lock (`branch list`), so writing there
  could race with a run that holds the lock. The behaviour the tests check is the same.
- **`relink --all` leaves a worktree with an install of its own as it is**, with code 0 and one
  line saying so. A plain `relink` refuses such a worktree (exit 1). Under `--all` that would make
  every run fail once one master has its own install. KC in sub-plan 004 is updated to say so.
- **`branch list` names at most five repos in a text row** (`… (+n)`). CN's `dev` lists 24 repos.
  The JSON keeps all of them. KC is updated.
- **`add-package`**: the refusal when a step has a worktree of the package (named in the
  Pitfalls) and what happens when a relink fails afterwards (the worktrees stay, exit 1) are added
  to KC.
- **The `--port` refusal and the free-port choice now run after the per-repo checks**, inside the
  lock, so a run with several problems lists the repo problems first.
- **The build** used `/Users/rene/web/create_now/node_modules/.bin/linked build`. In a fresh cli
  worktree, `npx linked build` reports `sh: linked: command not found`: the farm's `.bin/linked`
  points at that same unbuilt CLI. This is recorded in backlog 013.

### Follow-ups

- `own-install`, `--package-only`, refusing a second copy, and the two safety nets: backlog
  [013](../backlog/013-master-worktrees-remaining.md).
- The first build of the CLI in a fresh master or step worktree needs the main checkout's bin:
  backlog 013 ("Building the CLI in a fresh worktree").
- The master builds this landing in its cli worktree and switches to the built bin: sub-plan 004
  §Progress, second line (the master's task). The master's `_linked-core` worktree has no `lib/`
  yet, so `tsc` in its cli worktree cannot resolve `@_linked/core/*` (see Details, D1). The master
  builds core there first, then runs `<main>/node_modules/.bin/linked build` in the cli worktree.

## Details

### Phases

1. Locks and the registry (`dfb135d`).
2. `worktree relink --all` and `branch list` (`7785482`).
3. `addPackageWorktree` and `branch add-package` (`a273ced`).
4. Row cap in `branch list`, docs, backlog 013, changeset (`d792e03`), then the report (last
   commit).

### Notes

- Existing masters stay readable. A master started before this change is recorded only in its
  app's git config, which `freeMasterPort` and `--port` still read. So `hub-imports` (4520) and
  `side-225` (4510) keep their ports, and a new master in CN gets 4530. Another app does not see
  these two masters until they are restarted, because the registry does not have them.
- `branch list` and `worktree list` never create `~/.linked`. Only `branch start --worktree` and
  `worktree remove <m>` write there, inside the lock.

### Autonomous decisions

| # | Where | Problem | Choice | Alternative | Rationale |
|---|---|---|---|---|---|
| D1 | setup, typecheck | The master's `_linked-core` worktree (same commit `8e275f3` as `dev`) has no `lib/`, so `tsc` in my worktree failed on `@_linked/core/*` imports | Pointed my own worktree farm's `node_modules/@_linked/core` at the main checkout's built core (same source); the worktree is removed at the end | Build core in the master's worktree | Touches nothing of the master's; identical source |
| D2 | tests | Existing tests call `branchStartWorktree`, which now writes the registry; nothing stopped them from writing to the real `~/.linked` | Jest `setupFiles` sets `LINKED_HOME` to a temporary path for every test file; the new tests set their own | Only per-test `LINKED_HOME` in the new tests | Safety first: no test, old or new, can reach `~/.linked` |
| D3 | `branch start` | How long to hold the machine lock | From choosing the port to recording git config and the registry, worktree creation included | Reserve the port in the registry first, then create without the lock | One critical section; no half-reserved entries to clean up after a crash (a stale lock is taken over) |
| D4 | registry | KC says a gone entry is "dropped when read" | Ignored on every read, dropped at the next write under the lock | Rewrite the file on read | No write outside the lock (`branch list` is read-only) |
| D5 | `worktree remove <m>` | The registry release fails (lock timeout) | Reported as a message; the remove still succeeds | Fail the remove | The worktree is gone, so the entry no longer counts and is dropped at the next write |
| D6 | `branch start` | A lock timeout | Returned as exit 6 with the holder named, nothing made | Throw to the CLI | Same refusal as the repo lock, and the result object stays the single interface |
| D7 | `withRepoLockAsync` | Re-entry in one process | None: a per-lock promise queue; a nested call on the same lock waits forever (documented) | Re-entry by depth as in the sync lock | KC and the Pitfalls: two overlapping async calls must not both "re-enter" |
| D8 | `relink --all` | A worktree with an install of its own | Left as it is, code 0, one line | Count it as failed (plain `relink` refuses it) | Once `own-install` exists, `--all` would otherwise always exit 1 |
| D9 | `relink --all` | Which worktrees | `worktree list --all` from the main checkout: masters, then their steps, then every other worktree (non-agent ones too) | Agent worktrees only | KC: "`worktree list --all` minus the main checkout" |
| D10 | `branch list` | Row order and the TARGET column | Masters first, then integration branches, each by name; TARGET is the app's target, else the first repo's | Order by git config | Masters first matches KC's example; the app's target is what `land` uses |
| D11 | `branch list` | CN's `dev` has 24 repos, too wide for a row | Text names at most five (`… (+n)`); JSON has all of them | Full list | Readable at a terminal width; nothing is lost in JSON |
| D12 | `branch list` | An app with no records | Prints `No integration branches or masters.`, exit 0 | An empty header | KC: exit 0 for an empty list; a clearer message |
| D13 | `add-package` | A relink fails after the worktrees were made | The worktrees and records stay; exit 1 with `rerun linked worktree relink --all` | Undo everything | The worktrees are correct, and a relink is repeatable on its own |
| D14 | `add-package` | Which install the new package's nested `node_modules` links into | The master's farm marker `installRoot`, else the main checkout | Always the main checkout | Same as the master's own farm |
| D15 | `add-package` | How to tell a package is already in `<m>` | A `branch.<m>.linked-worktree` record in that repo, or the directory existing in the master | The record only | Also catches a worktree added by hand |
| D16 | registry | The key for "this app" | The real path of the main checkout; `otherPorts` compares real paths | The path as typed | `/tmp` and `/private/tmp` compare equal |
| D17 | release | Bump | minor | patch | New commands (feature) |
| D18 | build | `npx linked build` fails in a fresh cli worktree | Built with the main checkout's bin; recorded in backlog 013 | Change worktree farms in this step | Out of scope (KC); it has a home |
