---
date: 2026-10-22
summary: >
  New commands for one integration branch across an app and its `packages-local/` checkouts:
  `linked branch status|start`, `linked worktree add|list|remove`, `linked release plan` and
  `linked doctor resolve`, on a shared repo model (`src/integration/repos.ts`). Running a second
  dev server from a git worktree that shares the main checkout's `node_modules` now works: Vite
  gets a per-worktree `cacheDir`, the drift check and git hooks know about the shared install,
  and `linked localize` refuses there. `@_linked/cli` is no longer loaded twice in the dev server
  (Node only, never bundled by the SSR runner). 85 suites / 941 jest tests and 5 Playwright tests
  pass; an end-to-end dry run of branch start, worktree add, landing, release plan and remove
  passed.
---

# 024 — Integration branches and worktrees

## PR

### Summary

Work that spans an app and several framework packages no longer needs a PR per change. One
integration branch per piece of work carries it in every repo it touches, with a target recorded
per repo; agents work in worktrees on `<integration>--<agent>` branches and land locally by
rebase plus `merge --ff-only`; a release opens PRs per repo from branches cut for it. This PR
adds the CLI side: commands to start and inspect the integration branch, create and remove agent
worktrees, plan a release, and check where each package is loaded from, plus the fixes that let
a worktree with a symlinked `node_modules` run its own dev server next to the main one.

### Changes

- **`linked branch status [--json]`** — per repo: branch, target, dirty, ahead/behind the target
  and the integration branch; flags `off-branch`.
- **`linked branch start <name> --target <b> [pkgs…]`** — switches the app root and the named
  checkouts, records the target; all preconditions checked before any switch; a partial failure
  is rolled back.
- **`linked worktree add <agent> [--with] [--app-detached] [--port] [--dataset] [--dir]`** — app
  worktree plus nested package worktrees on the agent branch, `node_modules` and gitignored
  `.env*` linked, start command printed; a `--with` checkout joins the integration branch;
  rollback on failure.
- **`linked worktree list [--all] [--json]`** and **`remove <agent> [--force]
  [--delete-unlanded] [--dir]`** — landed state per branch; `remove` finds the worktree by its
  branch, refuses while unlanded or changed, `--force` keeps unlanded branches (sha printed),
  `--delete-unlanded` deletes them.
- **`linked release plan [--json]`** — per repo in dependency order (app last): commits, reports
  with their `## PR` section, changesets, release PRs in stack order, warnings, next action.
- **`linked doctor resolve [--json]`** — Vite's vs Node's directory per `@_linked` package; flags
  `overlay` and `two-copies`, exits 1 on `two-copies`.
- **Dev server** — `@_linked/cli` is never bundled by the SSR runner (`SSR_NODE_PACKAGES`, dev
  `ssr.external`, a virtual shim for `ssrLoadModule` entries); `cacheDir` is
  `<app>/.vite-cache` when `node_modules` is a symlink.
- **Shared install** — git hooks skip `npm install`, `localize`/`delocalize` refuse (exit 6), and
  the drift check looks next to the real `node_modules`, in a worktree whose `node_modules` is a
  symlink.
- **Tidy-ups** — the stale `doctor → app-doctor` rename hint is gone (`linked doctor` exists
  now); stale comments in `vite-config.ts` about a `development → src` export condition corrected.
- **Docs** — new [integration-branches-and-worktrees.md](../integration-branches-and-worktrees.md);
  [vite-runtime-config.md](../architecture/vite-runtime-config.md) covers the Node-only CLI, Node's
  native load sites, the per-worktree cache and overlay resolution; README and localize.md link to
  them.

### Verification

Full jest, after the final readability pass:

```
Test Suites: 85 passed, 85 total
Tests:       941 passed, 941 total
```

The new and extended suites on their own
(`tests/unit/integration tests/unit/doctorResolve.test.ts tests/unit/viteCacheDir.test.ts`):

```
Test Suites: 6 passed, 6 total
Tests:       73 passed, 73 total
```

`npx linked build`: `✔ Build successful`. Playwright (review gate, `npm test`): `5 passed`.

End-to-end dry run in an app with this build (about 3.5 minutes): `branch start try067 --target
integration-worktrees cli`, `worktree add t1 --with cli --port 4069`, a commit in each worktree,
a boot on the printed command (`Up and running at http://localhost:4069`, `doctor resolve` exit
0), landing cli then app by rebase and `merge --ff-only` (`e2ed539..b7701cc`,
`37d65a0f5..7bfa54e30`), `worktree list` showing both landed, `release plan` ordering cli before
the app, both `open PRs`, with the report's `## PR` quoted. `worktree remove t1` then failed (it
assumed the default directory); that was fixed (it finds the worktree by its branch) and covered
by `remove finds a worktree outside the default dir`.

Runtime checks in the app (per step): no `_linked-cli/src` module in Vite's SSR graph and
`lifecycle.js`, `utils.js`, `utils/packageFiles.js` loaded once from `lib/esm`; a worktree booted
twice with 0 drift lines, 0 re-optimizing on the second boot, its own `.vite-cache/deps`, and
the main `node_modules/.vite/deps` mtime unchanged (`1792614840` before and after).

### Deviations

- `worktree add --dir` is refused anywhere inside the app root, not only under a workspace glob.
- `release plan` has two more next actions than planned (`nothing to release`, `PR state
  unknown`), counts commits with `--no-merges`, and reports a missing target per repo.
- Loading the CLI once needed three changes, not one: `ssr.external` in dev, and a virtual shim
  for `ssrLoadModule` entries whose package root is empty (a re-exporting root loaded a second
  `@_linked/core`).
- `doctor resolve`'s "loaded by Node" set is the CLI plus the packages the app's `vite.config`
  imports, instead of a fixed list.
- Review iterations added: `remove` finding the worktree by branch, `--delete-unlanded`,
  sha-guarded rollbacks in `worktree add` and `branch start`, the `list --all` split, release
  plan warnings, the localize refusal, and `--app-detached` requiring `--with`.

### Follow-ups

None recorded. Three low findings were consciously left untracked:
- `doctor resolve`'s import scan strips comments without knowing about strings, so a `'src/*'`
  glob before an import can hide it;
- a reused integration branch name counts the earlier release's PRs;
- the empty root shim for `@_linked/cli` stands in for a fix in `@_linked/server`'s
  `indexLincdPackage` (skip, or natively import, a package the SSR runner does not bundle).

## Details

### Design

- **State lives in git.** The target is `git config branch.<integration>.linked-target` per repo;
  the active integration branch is the app root's current branch when it has a target. Agent
  worktrees are found through `git worktree list` by their `<base>--<agent>` branch. No files or
  locks of the CLI's own.
- **Check, then change, then undo.** `branch start` and `worktree add` check every precondition
  in every repo before changing any. Each change pushes its undo; a failure runs them in reverse.
  A branch the run created is deleted on undo only while it is exactly what the run made
  (`safeToDeleteCreatedBranch`: same sha, not checked out, no other branch forked from it,
  compared against the branches that contained the sha at creation).
- **Read-only where possible.** `branch status`, `worktree list`, `release plan` and
  `doctor resolve` change nothing; `release plan` never fetches (a network side effect in a
  read-only command) and warns when `origin/<target>` is ahead instead.
- **Seams.** Every git and gh call goes through the `Run` seam (`src/localize/run.ts`); core
  functions return data and an exit code, the `run*` commander actions print.

### File map

| File | Responsibility |
|---|---|
| `src/integration/repos.ts` | repo model: `listRepos`, `getTarget`/`setTarget`, `aheadBehind`, `integrationOf`, `agentBranch`, `git`, `currentBranch` |
| `src/commands/branch.ts` | `branchStatus`, `formatBranchStatus`, `branchStart`; shared helpers `selectCheckouts`, `refExists`, `localBranchExists`, `worktreesOf`, `parseWorktreeList`, `branchesContaining`, `safeToDeleteCreatedBranch` |
| `src/commands/worktree.ts` | `worktreeAdd`, `worktreeList`, `formatWorktreeList`, `worktreeRemove`, `defaultWorktreeDir`, `shellQuote` |
| `src/commands/release.ts` | `releasePlan`, `formatReleasePlan`, `extractPrSection`, `stackOrder`, `dependencyOrder` |
| `src/commands/doctor.ts` | `resolveRows`, `doctorResolve`, `formatTable`, `nodeLoaded`, `linkedImports`, `nodeResolveRoot` |
| `src/vite-config.ts` | `SSR_NODE_PACKAGES`, `isSsrNodeSpecifier`, `ssrNodeShim`, `ssrExternal`, `ssrBundledWorkspaces`, `viteCacheDir` |
| `src/localize/localize.ts` | `refuseSharedInstall` (also used by `delocalize.ts`) |
| `hooks/drift.cjs` | `installRoot`: the `missing-dir` check looks next to the real `node_modules` |
| `hooks/git-hook.cjs` | `sharedNodeModules`: post-merge/post-checkout skip the install |
| `src/cli.ts` | registers `doctor`, `branch`, `worktree`, `release` |
| `src/unknown-command.ts` | `RENAMED` removed |

### Rules per command

- **branch start** refuses: dirty selected repo; missing target where the branch must be
  created; `name === target`; `--` in the name or an invalid ref name; the branch checked out in
  another worktree. A partial failure switches repos back, deletes created branches (or keeps
  them, printing why) and restores the target entry.
- **branch status** off-branch: neither on the integration branch nor on the repo's target (its
  own entry, else the root's); detached is off-branch; no integration branch, nothing is.
- **worktree add** refuses: an existing dir or one inside the app root; a detached app root;
  an invalid agent name; `--app-detached` without `--with`; an existing agent branch; a dirty
  joining checkout or a missing target to create the base from. Links `.env*` only when
  gitignored, to its realpath; never private keys; `'junction'` links on Windows.
- **worktree remove**: finds by agent branch, then a detached worktree's package branches, then
  the default dir; `--dir` overrides. Ignores its own links and `.vite-cache` in the change
  check. Restores the links when `git worktree remove` fails.
- **release plan** next action and warnings: see the user doc.
- **doctor resolve**: bundled is computed with `discoverWorkspaces`,
  `workspaceDependents(ssrBundledWorkspaces(...))`, `ssrNoExternal` and `ssrExternal(true)`; an
  `ssr.external` name wins over `noExternal`, as in Vite 6.

### Worktree layout

```
<parent of app>/wt/<agent>/                     app worktree (<base>--<agent> or detached)
  node_modules -> <app>/node_modules
  .env* -> realpath of the app's gitignored .env files
  .vite-cache/                                  Vite cache, created on first start
  packages-local/<pkg>/                         package worktree on <base>--<agent>
    node_modules -> <app>/packages-local/<pkg>/node_modules
```

### Findings from the experiments

- A package worktree in a worktree's `packages-local/` overlays that one package for Vite: the
  glob entry wins in `discoverWorkspaces`, everything else resolves through the symlinked
  `node_modules` to the main checkout. HMR follows it (the watch set uses the same rule). Node
  loads only the CLI's `lib/` and the `vite.config` imports natively.
- Without a `cacheDir`, a worktree's server re-optimized the main checkout's
  `node_modules/.vite/deps`.
- The drift check reported every localized package as gone in a worktree.
- The shared git hooks ran `npm install` in a worktree after a checkout or merge that changed
  manifests, relinking the main install to the worktree's checkouts; `linked localize` did the
  same.
- `@_linked/cli` ran twice in every dev process (the bin from `lib/`, a Vite copy from `src/`
  through `LinkedServer`). Leaving it out of `ssr.noExternal` was not enough: Vite 6
  externalizes a package outside `node_modules` only when `ssr.external` names it, and an
  `ssrLoadModule` entry is always transformed. A re-exporting package-root shim loaded the CLI's
  release tooling and a second `@_linked/core` (the dual-copy guard fired), hence the empty root.
- Package checkouts have npm-nested dependencies (the CLI has 23); a package worktree without the
  nested `node_modules` link failed to parse in jest.

### Tests

| File | Tests |
|---|---|
| `tests/unit/integration/repos.test.ts` | 9 |
| `tests/unit/integration/branch.test.ts` | 13 |
| `tests/unit/integration/worktree.test.ts` | 29 |
| `tests/unit/integration/releasePlan.test.ts` | 13 |
| `tests/unit/doctorResolve.test.ts` | 6 |
| `tests/unit/viteCacheDir.test.ts` | 3 |
| `tests/unit/ssrExternal.test.ts` | +3 |
| `tests/unit/localize/drift.test.ts` | +2 |
| `tests/unit/localize/hooks.test.ts` | +1 |
| `tests/unit/localize/commands.test.ts` | +1 |
| `tests/unit/unknownCommand.test.ts` | +1 (updated) |

The integration suites run real git in temporary repos; `release plan` fakes `gh` through the
seam.

### Known limitations

- Overlaying the CLI, or a package the app's `vite.config` imports, needs the worktree's own
  built bin: Node loads them from the main checkout's install.
- A worktree with a symlinked `node_modules` cannot change dependencies; it needs its own install.
- `release plan` compares local targets; the release flow updates them first.
- The three low findings under Follow-ups.
