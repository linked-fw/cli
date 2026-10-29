---
date: 2026-10-29
summary: >
  `linked checkout --pin <npm>=<branch>` / `--pins-only`, `linked branch fork --worktree <dir>
  [--from <ref>]` and `linked branch push --worktree <dir>`: a server checks a package out on a
  branch it chooses (not the same-name rule) and keeps a package branch in a worktree of its own,
  outside every app checkout. Minor. For Create Now plan 225 step OB (ontology working branches),
  CN report 261.
---

# 039 — Checkout pins and worktree forks

## PR

### Summary

Create Now decouples ontology package branches from app branches (CN plan 225, decision G): a
person's working branch of an ontology (`{userSlug}/{topic}`) lives in a worktree of its own, and
app branches use it by a pin. The same-name rule was the cli's (`packageBranch`, used by `linked
checkout`), so the cli gains:

- `linked checkout <branch> --pin <npm>=<branch>` (repeatable): that package follows its pin —
  attached, or detached at `origin/<pin>` while another worktree of its base clone holds the
  branch; a re-run fast-forwards a detached pinned worktree and attaches it once the branch is
  free. A pin whose branch origin lacks falls back to `origin/<default>` with a message. The entry
  carries `pin`.
- `--pins-only`: no same-name rule; a package without a pin sits detached at `origin/<default>`
  (`fellBack` then means "no pin"). In either pins mode a clean worktree whose head origin has moves
  to its new target when the pins change (`switched`); uncommitted or unpushed work is `kept`.
- `linked branch fork <branch> <pkg> --worktree <dir> [--from <ref>]`: the branch in a new worktree
  of the package's base clone (found through the package's checkout in the app, which is not
  touched), from `--from` (default `origin/HEAD`) and pushed `-u`, or on origin's branch; reused when
  there (fast-forwarded when behind), a deleted one pruned and made again; a clean app checkout's
  package worktree that holds the branch lets go of it (detached at the same commit).
- `linked branch push <branch> --worktree <dir>`: one worktree, no app checkout needed.
- `linked localize` keeps the same-name rule (the developer workflow; no pins). Without the new
  flags every command behaves as before.

### Changes

- `src/commands/checkout.ts`: `CheckoutOptions.pins`, `pinsOnly`; `targetOf`, `holderOf`,
  `headOnOrigin`; `packageWorktreeIn` and `updatePackage` follow the target; `CheckoutPackage.pin`;
  `parsePins`; `runCheckout` takes `--pin`, `--pins-only`.
- `src/commands/branch-fork-merge.ts`: `ForkOptions.worktree`, `from`, `forkWorktree`;
  `PushOptions.worktree`; the commander actions.
- `src/cli.ts`: the flags and their help.
- `README.md`, `docs/integration-branches-and-worktrees.md` (flag table, **Pins**, the two
  `--worktree` sections), K-checkout in `docs/plans/002-package-repos-cli-steps.md`.
- Tests: `tests/unit/checkout/pins.e2e.test.ts` (9 cases).
- Changeset `checkout-pins-and-worktree-forks` (minor).

### Verification

- `npx jest --config jest.config.cjs tests/unit/checkout` → `Tests: 59 passed, 59 total` (the pins
  file: 9; the existing checkout, land, credentials, repo-lock and unpublished suites unchanged and
  green).
- The whole unit suite after a build (`linked build`): `Tests: 1165 passed` before the review
  fixes; the two suites that read `lib/` (`shapeHierarchy`, `ontologyDataReachable`) fail without a
  build, as on `dev`.
- CN's suites run this cli through `node_modules/.bin/linked` (CN report 261).

### Deviations

- `branch fork --worktree` finds the base clone through the package's checkout in an app checkout
  (`--dir`), as `branch fork` does, rather than taking a base clone path.
- A pin whose branch origin lacks falls back to the default branch (with a message) instead of
  refusing: a merged and deleted working branch is in `main`.
- From CN's review: `--worktree` prunes deleted worktrees, fast-forwards a stale local branch, and
  takes the branch from a clean, pushed app checkout's package worktree that holds it.

### Follow-ups

None in this repo. Deleting merged working branches: CN backlog 268.

## Details

The pins mode moves a worktree only when `git for-each-ref --contains HEAD refs/remotes/origin`
names a branch, so no commit becomes unreachable. A held pin is detached at `origin/<pin>`, never
`git worktree add --force`. The skills in `semantu-agents` do not describe these flags.
