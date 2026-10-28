---
date: 2026-10-28
summary: >
  One lock per base clone: `linked checkout`, `branch fork`, `branch push`, `branch merge` and
  `worktree remove --branch` take a shared base clone's `linked.lock` around their git work on that
  repo, one repo at a time; a waiter is refused after 120 s naming the holder, a dead holder's lock
  is taken over; a new base clone is cloned beside its place and renamed in. Patch. Step SU of CN
  master plan 057 (with server report 022).
---

# 036 — One lock per base clone

## PR

### Summary

A package's bare base clone (`<root>/.repos/<owner>/<name>.git`) is the git dir of that package's
worktree in every app checkout that lists it, but callers only serialised runs per app (K-checkout,
CN backlog 193 §7). Two apps listing one package could fetch, add worktrees or move refs in it at
once and fail on git's ref or `index.lock`. Each base clone now has its own lock.

### Changes

- `src/integration/repo-lock.ts` (new): `withRepoLock(gitDir, what, fn, {timeoutMs, pollMs})` holds
  `<gitDir>/linked.lock`, created with `wx` and holding `{pid, host, at, what}`; waits (polling,
  default 120 s), then throws a refusal (exit 6) naming the holder and the file to delete if no run
  is working. A lock whose pid is gone on this host is moved aside and taken over (a lock taken
  over meanwhile is given back); one from another host is never broken. Re-entrant within one
  process; released only if the file is still its own. `withCheckoutLock(run, dir, …)` locks the git
  common dir of a checkout (`git rev-parse --git-common-dir`).
- `src/commands/checkout.ts`: the app's base clone and app worktree, then each package's base clone
  and worktree, each under that base clone's lock (`withBase`), so a run holds one lock at a time
  and two runs cannot deadlock. A missing base clone is cloned into `<name>.git.new-XXXXXX` beside
  its place, configured and fetched there, and renamed into place; when another run's clone got
  there first, this one is dropped and the existing one is verified and fetched under the lock.
  `worktree remove --branch` (`checkoutRemove`) fetches, removes worktrees and deletes branches
  under each repo's lock; a lock refusal is reported in the result (code 6), never thrown.
- `src/commands/branch-fork-merge.ts`: `branch fork` from its fetch to its push, `branch push` per
  repo, `branch merge` per repo for the fetch and again for the merge step, each under the lock of
  that repo's git dir; a refusal comes back as the command's result (code 6).
- Options `lock?: RepoLockOptions` on `CheckoutOptions`, `CheckoutRemoveOptions`, `ForkOptions`,
  `PushOptions`, `MergeOptions` (tests use short waits).
- Docs: `docs/integration-branches-and-worktrees.md` §One run per base clone at a time; K-checkout's
  "callers serialise per app" in sub-plan 002 and in CN plans 057, 180 and 200.
- Tests `tests/unit/checkout/repo-lock.test.ts` (7): held while running and removed after (also on
  a throw); re-entry; waiting for a holder that releases; refusal after the wait naming the holder;
  a dead holder taken over, another host's never; `checkout`, `fork`, `push`, `merge` and
  `worktree remove --branch` refused (6) while another process holds the package's or the app's base
  clone lock, nothing removed; no lock or `.new-` directory left after a run.
- Changeset `.changeset/base-clone-lock.md` (patch).

### Verification

- cli unit suite (`npx jest --config jest.config.cjs`, 39 s):
  ```
  Test Suites: 98 passed, 98 total
  Tests:       1135 passed, 1135 total
  ```
- `npm run build`: compiled, copied, chmod (3 s).
- CN regular set on the step's CN worktree (rebased on `dev` 417e89222, `CN_TEST_PORT=4359`, under
  the shared slot lock), one run for the step (server and cli):
  ```
  test:regular
    typecheck:gate                                   PASS   13s
    unit (vitest)                                    PASS   58s      (Tests  3150 passed | 5 skipped)
    packages                                         PASS    7s
    playwright (integration + sign-in e2e)           PASS  242s     (355 passed, 16 skipped, 4.0m)
    total                                            PASS  320s
  ```
- The end-to-end check (server report 022) ran `linked checkout` through CN's project creation
  against real GitHub: base clones made by rename, the app on `change-1`, both packages detached at
  `origin/main`, then the save's `branch fork` of the ontology package.

### Deviations

- `worktree remove --branch` takes the lock too: it fetches, removes worktrees and deletes branches
  in the same shared base clones as the four commands named in the step.
- The lock is held per repo rather than for the whole run (one lock at a time, so no deadlock);
  a caller still serialises the runs of one app checkout, whose worktrees and files are not locked.
  K-checkout updated in sub-plan 002 and CN 057/180/200.

### Follow-ups

None new. CN backlog 193 §7's base-clone item is removed.

## Details

- The lock lives in the base clone, so it needs the base clone first; cloning beside and renaming
  makes the clone atomic, so no run ever locks or worktrees a half-made one.
- Waiting blocks the thread (`Atomics.wait`), which is right for these sync git runs; a CN calling
  the cli runs it as a child process, so its event loop is not held.
- A pid reused by an unrelated process makes a stale lock look alive until the wait ends; the
  refusal names the file to delete.
