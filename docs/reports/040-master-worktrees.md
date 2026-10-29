---
date: 2026-10-29
summary: >
  Masters run in worktrees of their own: `linked branch start <m> --worktree` (nothing switched;
  records target, worktree, port 45k0 and dataset in git config; prints a preview command with
  SITE_ROOT and CN_PROJECTS_ROOT), `linked worktree add <agent> --from <m>` (steps with flattened
  farms whose marker records the master as parent, which relink honours), master-aware
  `worktree list/remove/relink`, `linked branch land <m>` (merge the target into <m>, re-test
  stop, ff-only into the owner's checkouts in dependency order, build, push), built `packages/*`
  members as overlays, and SITE_ROOT in every worktree start command. Minor. Plan 003.
---

# 040 — Master worktrees

## PR

### Summary

A master agent running a long plan no longer moves the owner off his stable branch. Its
integration branch lives in a worktree of its own (`../wt/<m>`) with nested framework worktrees,
a link farm into the one install and its own preview server; its steps branch from it and land in
it; and `linked branch land <m>` brings the run into the owner's branches when he approves.
Release (PRs to `main`) is unchanged. Plan: [003](../plans/003-master-worktrees.md).

### Changes

- `linked branch start <m> --worktree [pkgs] [--with] [--target] [--port] [--dataset] [--dir]`
  (`src/commands/master.ts`): per repo from the branch its checkout is on; records
  `branch.<m>.linked-target`, `-worktree` (each repo), `-port` (first free of 4510…4590) and
  `-dataset` (app); prints the preview command; undoes everything on failure; warns when a target
  is origin's default branch. Without `--worktree` the command is unchanged (`--target` still
  required).
- `linked worktree add <agent> --from <m>` (implied in the master's worktree): `<m>--<agent>`,
  default dir `../wt/<m>--<agent>`, `--with` only from the master's packages, no joins, a farm
  straight into the install with the master's overlays under the step's own, marker `parent`;
  warns when a master package depends on one the step overrides (two copies).
- `linked worktree relink` reads `installRoot` and `parent` from the marker instead of assuming
  git's first worktree; nested `node_modules` links point at the install's real directory.
- `linked worktree list` gains `masters` (target, port, dataset, worktree, steps);
  `worktree remove` takes `<m>--<agent>` or `--from <m>` for a step and `<m>` for the master
  (refused while it has steps or is not landed; forgets its records).
- `linked branch land <m> [--dry-run] [--no-retest] [--no-build] [--no-push] [--json]`: checks
  everything first (master worktrees clean, on `<m>`, not mid-merge; steps landed; owner checkouts
  clean, on target, not behind origin), merges a moved target into `<m>` (exit 3 to re-test; a
  conflict stays in progress in the master's worktree, exit 4), ff-only per repo with frameworks
  first, `npx linked build` per landed package, `git push origin <target>` (not after a failed
  build; exit 5 on either failure).
- Farm (`worktree-node-modules.ts`): `packages/*` members are overlays when loadable as they are
  (`main` and every runtime leaf of `exports['.']` exist, or none declared), so a master's
  typecheck sees its own built `packages/access`; unbuilt ones stay the install's and are named.
  Their nested `node_modules` link to the install's.
- Every worktree start command sets `SITE_ROOT=http://localhost:<port>` when the linked `.env`
  sets `SITE_ROOT` (before, a second server served the first one's bundles).
- `src/integration/masters.ts` (records), docs (`integration-branches-and-worktrees.md` §Masters,
  README), changeset `master-worktrees.md` (minor).

### Verification

- `npx jest --config jest.config.cjs`: `Test Suites: 101 passed, 101 total`,
  `Tests: 1179 passed, 1179 total` (13 new tests in `tests/unit/integration/master.test.ts`).
- `npx playwright test --config playwright.config.ts`: `6 passed (1.2m)` (the `fetch failed … bad
  port` lines in its log are the dual-copy spec's app running without Fuseki, as designed).
- The built CLI (`node lib/esm/launch.js`) end to end in a sandbox (temp app with a bare origin,
  `packages-local/_linked-server`, a `packages/access` member): `branch start m1 --worktree --with
  server` (owner still on `dev` in both repos; `Preview: … PORT=4510 SITE_ROOT=http://localhost:4510
  CN_PROJECTS_ROOT=…/wt/m1/apps npm run start:local`), `worktree add a1 --from m1 --with server`,
  commits in the step, `worktree list` (master with step a1 `not landed`), ff of the step into the
  master's worktrees, `worktree relink m1--a1`, `worktree remove m1--a1` (`deleted m1--a1`), an
  owner commit on dev, `branch land m1 --dry-run` (`.: would merge dev into m1`), `branch land m1
  --no-build` → `exit 3` (`Re-test needed … merge commits in the app`), again → `exit 0`
  (`dev fast-forwarded to m1`, `.: pushed dev`; origin's dev = the merge commit), `worktree remove
  m1` (`Forgot master m1`), and the in-place `branch start x1 --target dev server` and plain
  `worktree add a2 --with server` unchanged.

### webid.email and preview ports

Local webid.email accepts sign-ins from preview ports: it signs in any client on localhost ports
4000-4999 (`semantu-webid-email/src/oidc/devClients.ts:78` `DEFAULT_DEV_CLIENT_PORTS = {min: 4000,
max: 4999}`, applied in `src/oidc/clientResolver.ts:172-176`; overridable with `DEV_CLIENT_PORTS`,
unset in its `.env`) and fetches the client's own Client ID Document from
`http://localhost:<port>/.well-known/linked-client.jsonld`. CN derives `client_id` and
`redirect_uri` from `SITE_ROOT` (`src/backend/auth/webIdSignin.ts`, `cnSigninClient(siteRoot)`),
so a preview with `WEBID_MODE=local` and `SITE_ROOT=http://localhost:45k0` (what the printed
command sets) works. `WEBID_MODE=production` still only works on 4040 (`DEV_CLIENT_SITE_ROOT`).
Read from the config, not run.

### Deviations from the plan / proposal

- Not in this slice (as agreed): `branch add-package`, `branch list`, `own-install`,
  `--package-only`, `relink --all`, the Playwright test lock. A step can only `--with` packages
  its master has; adding one to a running master is by hand (`git -C <main>/packages-local/<pkg>
  worktree add -b <m> <wt>/packages-local/<pkg> <target>`, `git config branch.<m>.linked-target`
  and `-worktree` there, then `linked worktree relink` in the master and its steps).
- No `AUTH_COOKIE_PREFIX` (owner: shared cookies are fine).
- `branch start --worktree` does not refuse a dirty owner checkout (nothing is switched; the
  master starts at the last commit and says so); `land` does refuse it.
- "Tested tip" recording became the simpler rule: `land` stops after any merge it makes (exit 3);
  a re-run with nothing to merge proceeds.
- `packages/*` overlays only when built (the proposal said "add them"): an unbuilt overlay would
  have broken tsc and Node in every fresh worktree.

### Follow-ups

- `branch add-package <m> <pkgs>`, `branch list`, `worktree relink --all`, `own-install` and a
  port-allocation lock (two concurrent `start --worktree` can pick the same slot): this report
  (cli backlog when scheduled).
- The two-copies case for steps is warned, not prevented; `doctor resolve` could flag it.
- Skills and CN `CLAUDE.md`: proposed changes below, for the owner to apply (not edited here).

#### Proposed skill and CLAUDE.md changes

- **workflow, "Where work happens"**: the start question becomes three-way — master run
  (`linked branch start <m> --worktree --with …`, lands into your current branch on approval),
  integration branch in place (today's, single session), or standalone PRs. A master or step never
  runs `branch start` without `--worktree`; step worktrees are `linked worktree add <agent> --from
  <m> [--app-detached] --with …`; ports: master slot 45k0 (printed), its tests 45k1, steps
  45k2-45k9; the preview command is the one `start --worktree` prints (PORT, SITE_ROOT,
  CN_PROJECTS_ROOT). "Adding a package later" stays the manual recipe above.
- **master**: the landing point of steps is the master's worktree (`git -C ../wt/<m>… merge
  --ff-only <m>--<agent>`); the owner's checkouts are read-only for the whole run; start the
  preview once, `npx linked build` in `../wt/<m>/packages-local/<pkg>` and restart it after each
  framework landing; give the owner `http://localhost:45k0` any time; end of run: with his
  approval `linked branch land <m> --dry-run`, then `land` (exit 3 → rebuild + regular set in
  `../wt/<m>`, run again; exit 4 → the agents whose files conflict resolve in `../wt/<m>` and
  commit); then `linked worktree remove <m>`. Restart recovery: `linked worktree list`. Merge the
  target into `<m>` at wave boundaries (`git -C ../wt/<m> merge dev`) to keep `land` small.
- **wrapup, Landing**: "fast-forward the main checkout" becomes "fast-forward the integration
  branch where it is checked out" (the master's worktree, from `git config
  branch.<m>.linked-worktree`, or the main checkout); step 4 builds in the master's nested
  worktree; closing line variant "Landed on `<m>`; preview at :45k0".
- **release**: unchanged mechanics; add that `land` (master → owner's branch) is not a release,
  and that a master started from `dev` releases through `dev`.
- **CN CLAUDE.md §Git**: replace "Checkouts stay on the current integration branch…" with "The
  owner's checkouts stay on his stable branch (`dev`); a master run lives in `../wt/<m>` (`npx
  linked branch start <m> --worktree --with …`), its steps in `../wt/<m>--<agent>` (`npx linked
  worktree add <agent> --from <m>`), and it lands into the owner's checkouts only on his approval
  (`npx linked branch land <m>`, which merges, fast-forwards, builds and pushes)". In "Running a
  second backend": add `SITE_ROOT=http://localhost:<port>` (now printed by every `worktree add`),
  and that CN's built `packages/*` resolve to the worktree's copy after a build plus `linked
  worktree relink` (unbuilt ones still show as `overlay`, Vite only).
