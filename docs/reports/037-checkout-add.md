---
date: 2026-10-28
summary: >
  `linked checkout <branch> --add <repo>` (repeatable): one more package worktree in the app
  checkout's `packages-local/` that no list names, by the same branch rule and base clone lock,
  marked `added`, never a reason to install and never built. Minor. For Create Now plan 070 step
  NO (editing a workspace ontology the app does not use), CN report 210.
---

# 037 — `linked checkout --add`

## PR

### Summary

Create Now edits a workspace ontology package that the app does not list in
`linked.unpublishedPackages` (CN plan 070, design choice D-NO2): its worktree goes into the
branch checkout's `packages-local/`, unlisted, so `linked branch fork`, `push` and `merge`, which
already take every checkout there, cover it. `linked checkout <branch> --add <repo>` places it.

- The package's name is what its `package.json` declares on `<branch>` (else on its default
  branch) in its base clone; its worktree is `packages-local/<checkoutNameFor name>`, on
  `<branch>` when its repo has it, else detached at `origin/<default>`, under the base clone's
  lock, as a listed package's.
- The result marks it `added: true`. It is left out of the install trigger and out of the builds,
  so the app's `package.json` and lock stay as committed.
- A later run without `--add` reports it `unlisted` and keeps it, as any checkout no list names.
- An `--add` of a package a list names with the same repo is that listed package (a message); with
  another repo, one name added with two repos, or a repo with no `package.json` naming a package,
  it is refused (exit 6).

### Changes

- `src/commands/checkout.ts`: `CheckoutOptions.add`, `CheckoutPackage.added`, `addPackages`,
  `declaredName`; added worktrees out of `unlisted()`, `needsInstall` and the builds; `(added)` in
  the text output.
- `src/cli.ts`: `--add <repo>` (repeatable).
- `README.md`, `docs/integration-branches-and-worktrees.md` (flag table, **Added packages**),
  K-checkout in `docs/plans/002-package-repos-cli-steps.md` (and CN 057, 180, 200).
- Tests: two cases in `tests/unit/checkout/checkout.e2e.test.ts`.
- Changeset `checkout-add` (minor).

### Verification

- `npx jest --config jest.config.cjs tests/unit/checkout/checkout.e2e.test.ts` → `Tests: 12 passed,
  12 total` (29.7 s). The added package's entry:
  ```json
  {"name": "acme-extra", "branch": "main", "detached": true, "fellBack": true,
   "requiredBy": [], "status": "created", "added": true}
  ```
  with `install: {ran: false}` and `builds: []` on a run with `install: true` over an app that has
  its install, and no change to the app's `package.json` / `package-lock.json`.
- The whole unit suite after `npm run build`: `Test Suites: 98 passed, 98 total`, `Tests: 1137
  passed, 1137 total` (38.9 s).

### Deviations

None.

### Follow-ups

None in this repo. CN's use of it: CN report 210.

## Details

The skills in `semantu-agents` do not describe `linked checkout`, so they need no change.
