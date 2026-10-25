---
summary: >
  Integration branches and worktrees across an app and its `packages-local/` checkouts:
  `linked branch status|start`, `linked worktree add|list|relink|remove`, `linked release plan` and
  `linked doctor resolve`. The model (one integration branch per piece of work with a target
  recorded per repo, agent branches `<integration>--<agent>`, landing by rebase plus
  `merge --ff-only`, releases from cut branches merged with merge commits), the shared-install
  rules (no `npm install` or `linked localize` in a worktree, whose `node_modules` links into the
  main checkout's install), and
  the limitations.
---

# Integration branches and worktrees

```sh
npx linked branch start overhaul --target main core server   # app + two checkouts on `overhaul`
npx linked worktree add agent1 --with server --port 4041      # ../wt/agent1, own server worktree
# … work, commit, rebase, land with merge --ff-only …
npx linked worktree remove agent1
npx linked release plan                                       # what `overhaul` would release
```

This page is for apps that develop some framework packages from git checkouts in
`packages-local/` ([`linked localize`](localize.md)) and want one piece of work — often several
agents in parallel — to span the app and those packages without a PR per change.

## The model

- **One integration branch per piece of work**, e.g. `overhaul`, in the app root and in each
  `packages-local/` checkout the work touches. The others stay on their target.
- **A target per repo**: the branch the work is released into (`main`, `dev`, …), recorded in
  that repo's git config as `branch.<integration>.linked-target`. A branch with a recorded target
  is an integration branch; the app root's current branch decides which one is active.
- **Agents work in worktrees**, on local branches named `<integration>--<agent>`
  (`overhaul--agent1`). git cannot hold both `overhaul` and `overhaul/agent1`, so the separator is
  `--`, and neither an integration name nor an agent name may contain it. An agent worktree is a
  worktree of the app with a nested worktree of each package the agent changes.
- **Landing is local**: rebase the agent branch onto the integration branch in the worktree,
  re-run the tests there, then fast-forward the main checkout:
  `git -C <checkout> merge --ff-only overhaul--agent1`. A refused fast-forward means another agent
  landed first: rebase again. `--ff-only` either applies cleanly or changes nothing, so no lock is
  needed. An agent that changed several repos lands the packages first, in dependency order, and
  the app last, then runs `npx linked build` in each landed package checkout (Node-native code
  runs from `lib/`).
- **Releases** open PRs per repo to the target, framework packages first (they publish on merge),
  the app last. Each PR comes from a branch cut for it and named for what it does
  (`overhaul--webid-local`), so commits landed later do not join a PR under review. Several PRs in
  one repo are stacked: a later PR's base is the earlier PR's branch. The release's PRs are the
  ones whose head starts with `<integration>--` (agent branches share the prefix but are never
  pushed). Merge with merge commits, not squash, so stacked PRs merge cleanly and the target can
  be merged back into the integration branch.

## Shared install

An agent worktree runs on the main checkout's install. Its `node_modules` is a **link farm**: a
real directory in which every entry links to the main checkout's entry of the same name, except

- each package with a checkout in the worktree's `packages-local/`, which links to that checkout,
  so Vite, `tsc` (`npm run typecheck`) and Node (the backend, `tsx`, Vitest, Jest) all load the
  worktree's copy; its `@scope` is a real directory whose other entries link one by one;
- `.bin`, a real directory of the same relative links, so an overlaid package's bin (`linked` from
  a `@_linked/cli` worktree) is the worktree's and every other bin the main checkout's;
- npm's hidden lockfile and the caches (`.vite`, `.vite-temp`, `.cache`), left out.

`node_modules/.linked-worktree.json` names the install the farm links into and its overlays.
`linked worktree add` makes the farm; `linked worktree relink` rebuilds it after an `npm install`
in the main checkout (a package installed since is missing from the farm until then; `doctor
resolve` says so) or after adding a package worktree by hand. A package another installed
package imports stays the main checkout's copy for that importer in Node and `tsc`.

Worktrees made by earlier versions have `node_modules` as one symlink to the main checkout's, so
`tsc` and Node load the main checkout's copies of their packages (`doctor resolve` says so); run
`linked worktree relink` in such a worktree to move it to the farm.

An install in a worktree would write into the main checkout's install (through the links, or
through a symlinked `node_modules`), or replace the farm. Hence:

- **Never run `npm install` in such a worktree.** The git hooks `linked localize` writes skip their
  `post-merge`/`post-checkout` install there and say so:
  `[linked] skipped npm install: node_modules links into <path> …` (`… is a symlink to <path> …`
  for a symlinked one).
- **`linked localize` and `linked delocalize` refuse there** (exit 6) and name the checkout to run
  them in; `linked localize --list` still works.
- **Work that changes dependencies** needs its own install: a worktree with a `node_modules` of
  its own (delete the farm, then `npm install` there) instead of the farm. `relink` leaves such
  an install alone.
- **Drift** (`linked localize --list`, and the check before `linked start`) reads checkouts next to
  the real `node_modules`, so a worktree reports no false "checkout is gone".
- **Vite's cache** is per worktree: in a worktree sharing the install, `createViteConfig` uses
  `<worktree>/.vite-cache` instead of `node_modules/.vite`. Add `.vite-cache/` to `.gitignore`.
- **`linked build` in a package worktree** passes `--preserveSymlinks` to `tsc`, so a declaration
  that names a hoisted transitive dependency gets the same bare specifier as in the main checkout
  (without it: TS2742 "cannot be named without a reference to '…/node_modules/…'"). It also sets
  the execute bit on the package's `bin` files, which a bin run through the farm needs.

How Vite resolves an overlay is in
[the Vite runtime config](architecture/vite-runtime-config.md#git-worktrees).

## `linked branch`

Run in the app (any directory inside it).

### `linked branch status [--json]`

One row per repo — the root (`.`), then each `packages-local/` checkout:

| column | |
|---|---|
| `repo` | `.` or `packages-local/<dir>` |
| `branch` | the checked-out branch, or `detached` |
| `target` | the target recorded for that branch, empty when none |
| `dirty` | uncommitted or untracked changes |
| `vs target` | `+ahead/-behind` of HEAD against the target, `-` without one |
| `vs integration` | the same against the root's integration branch, `-` when there is none or the repo lacks it |
| `flag` | `off-branch`: the repo is on neither the integration branch nor its target |

A repo's target for the integration is its own `branch.<integration>.linked-target`, or the
root's target when the repo has none, so a checkout the work has not touched, left on `main`, is
not flagged; a detached HEAD is. `--json` prints `{integration, rows}`.

### `linked branch start <name> --target <branch> [packages...]`

Puts the app root and the named checkouts on `<name>`: `git switch <name>` where it exists,
otherwise `git switch -c <name> <target>`, and records the target in each. Packages are named by
package name (`@_linked/core`), short name (`core`) or directory (`_linked-core`). Checkouts not
named are left as they are, and listed.

It refuses, switching nothing, when any selected repo has uncommitted or untracked changes,
`--target` is missing in a repo where `<name>` has to be created, `<name>` equals the target,
`<name>` contains `--` or is not a valid branch name, or another worktree has `<name>` checked
out. If a switch still fails partway, the repos already switched go back: each to its previous
branch (or commit), a branch the run created is deleted, and the target entry is restored. A
created branch that has moved, is checked out somewhere, or that another branch has forked from
since is kept, with `kept <branch> at <sha>: <reason>`.

## `linked worktree`

Run in the app's main checkout. The base is the root's integration branch, or its current branch
when it has none (then agents land straight into that branch).

### `linked worktree add <agent>`

| flag | |
|---|---|
| `--with <pkgs>` | comma-separated `packages-local/` checkouts the agent changes (`@_linked/core`, `core` or `_linked-core`) |
| `--app-detached` | check the app out detached at the base tip, for work that changes only packages; needs `--with` |
| `--port <n>` | the port in the printed start command (default `<port>`; the main checkout uses 4040) |
| `--dataset <name>` | adds `FUSEKI_DATASET=<name>` to the printed start command, and the clone commands when the app has them |
| `--dir <path>` | where to put it; default `<parent of the app root>/wt/<agent>`; refused anywhere inside the app root |

It creates:

```
<dir>/                           app worktree on <base>--<agent> (or detached at <base>)
<dir>/node_modules/              link farm into <app root>/node_modules (see Shared install)
<dir>/node_modules/<pkg>  ->     <dir>/packages-local/<pkg>, for each --with package
<dir>/.env, .env.local …  ->     the root's gitignored .env files (their real path)
<dir>/packages-local/<pkg>/      worktree of packages-local/<pkg> on <base>--<agent>
<dir>/packages-local/<pkg>/node_modules -> packages-local/<pkg>/node_modules (when it has one)
```

then prints the start command, e.g. `cd ../wt/agent1 && PORT=4041 npm run start:local`
(`npm start` when the app has no `start:local`). Private keys (`*.pem`, `*.key`, untracked) are
never linked; the output names them with the `ln -s` line to run when the app needs one.

A `--with` checkout that is not on the base joins the work: it is switched to the base, created
from the target where it does not exist, and the target is recorded. Before anything changes, it
refuses when the agent branch already exists anywhere, a joining checkout is dirty, or its target
is missing; every later failure undoes what the run created (never a directory it did not make,
and a base branch it created only while nothing has moved or forked from it).

**Adding a package later**: from the main checkout,
`git -C packages-local/<pkg> worktree add -b <base>--<agent> <dir>/packages-local/<pkg> <base>`,
then `linked worktree relink <agent>` (or `linked worktree relink` in the worktree): it links the
package worktree's `node_modules` to its checkout's and the package into the farm.

### `linked worktree relink [agent] [--dir <path>]`

Rebuilds an app worktree's `node_modules` farm from the main checkout's `node_modules` and the
packages now in the worktree's `packages-local/`: the agent's worktree, the one at `--dir`, or,
without either, the worktree it runs in. It also gives each package worktree without a
`node_modules` the link to its checkout's. A symlinked `node_modules` (an earlier layout) is
replaced; a `node_modules` of the worktree's own is refused and left alone. The new farm is
built next to the old one and swapped in by rename; restart the worktree's dev server after it.

### `linked worktree list [--all] [--json]`

The app's agent worktrees — on `<base>--<agent>`, or detached with a package worktree on one —
each with its package worktrees: branch (or detached) and whether it has landed in the base
(`git merge-base --is-ancestor`). `--all` adds every other worktree of the app, marked
`(not an agent worktree)`; the main checkout is never listed. `--json` prints
`{base, worktrees}`.

### `linked worktree remove <agent>`

Finds the agent's app worktree by its branch `<base>--<agent>` (a detached one by its package
worktrees on that branch, or at the default directory), removes the package worktrees, then the
app worktree, then deletes the landed agent branches (`git branch -d`).

It refuses, removing nothing, while an agent branch has not landed in the base or a worktree has
changes of its own (the links and the farm `add` made and `.vite-cache` don't count). The farm
is deleted without following its links.

| flag | |
|---|---|
| `--force` | remove even with changes or unlanded branches; unlanded branches are **kept**, and their sha printed (`kept <branch> at <sha> (not landed)`) |
| `--delete-unlanded` | also delete unlanded agent branches (`git branch -D`), printing the sha each was at |
| `--dir <path>` | the app worktree directory, instead of finding it by its branch |

Pull every checkout the work touched before `remove` when the work landed through a PR rather
than locally: an agent branch counts as landed only once the local base contains it. A
squash-merged branch never does; remove it with `--delete-unlanded`. When `git worktree remove`
fails, the links (and the farm) are put back so the worktree stays usable.

## `linked release plan [--json]`

Run in the app on its integration branch. For each repo on that branch, in dependency order (the
`package.json` dependencies among the checkouts, the app last):

- the commits the target lacks (`git log --no-merges <target>..<integration>`; merging the
  target back does not count as something to release);
- the reports and changesets added (`docs/reports/*.md`, `.changeset/*.md`), and each new report's
  `## PR` section (from `## PR` up to the next `## ` heading), or `no PR section`;
- the release PRs (via `gh pr list`, head `<integration>--*`) in stack order, with their state;
- warnings: `no changeset: merging will not publish` (the repo has `.changeset/config.json`,
  commits, and no new changeset) and `target behind origin/<target>: fetch first`;
- the next action:

| next | when |
|---|---|
| `open PRs` | commits to release and no open or merged release PR (or all merged and new commits since) |
| `waiting` | a release PR is open |
| `merge target back` | every release PR merged, and the target has commits the integration branch lacks |
| `done` | every release PR merged, nothing left either way |
| `nothing to release` | no commits and no release PR |
| `PR state unknown` | `gh` is missing or failed (e.g. no remote) |

Repos not on the integration branch are listed as left out. A repo whose target does not exist
shows an error instead of failing the plan. It compares against the **local** target branches and
never fetches: update them first (`git -C <checkout> pull --ff-only` where the target is checked
out, `git fetch origin <t>:<t>` otherwise). It changes nothing.

After a release: when every PR is merged and published, switch each repo to its target, pull,
delete the integration branch (local and remote), then `npm install` and `npx linked build-all`.
Otherwise stay on the integration branch and merge the target back after each merged PR.

## `linked doctor resolve [--json]`

Run in the app. One row per source workspace and installed `@_linked/*` package:

| column | |
|---|---|
| `name` | the package |
| `vite` | the directory Vite's dev SSR runner loads it from, or `external` when Vite leaves it to Node |
| `node` | the directory Node resolves it to from the app, or `(not installed)` |
| `bundled` | whether the dev SSR runner bundles it (computed with the same functions as `createViteConfig`) |
| `flag` | `overlay` or `two-copies`, below |

- **`overlay`**: bundled, and Vite's directory differs from Node's. Expected in a worktree for
  the app's own `packages/*` (the farm links them to the main checkout's build): Vite takes the
  worktree's copy, Node would take the main checkout's, and nothing loads it natively. A package
  with its own worktree shows no flag: the farm gives Node the worktree's copy too. In a worktree
  with a symlinked `node_modules` it shows `overlay`, and the report ends with the `relink` hint;
  the hint also lists what a farm lacks against the main install.
- **`two-copies`**: the same, for a package Node also loads during `linked start` —
  `@_linked/cli`, and every `@_linked/*` package the app's `vite.config.*` imports. The process
  then runs two instances of it.

Exits 1 when any row is `two-copies`, 0 otherwise. `--json` prints the rows
(`name`, `vite`, `node`, `bundled`, `flag`).

## Limitations

- **Overlaying the CLI needs a build in the worktree.** With `--with cli`, the worktree's
  `linked` bin is the worktree's CLI, run from its `lib/`: build it there (`npx linked build`)
  before starting the app. `doctor resolve` shows the CLI as `external` either way.
- **Transitive imports.** A package installed in the main checkout that imports an overlaid
  package gets the main checkout's copy in Node and `tsc` (Vite gives it the worktree's).
- **Dependency changes** need a worktree with its own install (see Shared install).
- **Data is shared.** Worktrees use the same data store unless started with a dataset of their
  own (`--dataset`).
- **Release PRs are matched by name.** Reusing an integration branch's name later counts the
  earlier release's PRs as well.
