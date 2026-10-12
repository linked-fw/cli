---
summary: >
  Proposal, measured but not adopted: rebuild `linked localize` on npm workspaces. The app commits
  `"packages-local/*"` in its `workspaces`, npm links and dedupes the checkouts, and a postinstall
  script restores the committed lockfile so the working tree stays clean. Pulls, merges and branch
  switches then work as usual, and pruning, relink, `--ensure` and the Vite dedupe go away (about
  3,200 lines down to roughly 200). Measured on a CN clone with four checkouts: one copy of every
  shared package, identical registry versions to CI, a Renovate pull in 10.5s with a clean
  `git status`. Next: a one-week trial with all checkouts and both developers.
status: Open -- design measured; trial and implementation not started
---

# 009 — Localize on npm workspaces

## Why

`linked localize` exists so that working on a framework package from a checkout never changes a
committed file. [Report 011](../reports/011-localize-one-copy.md) rejected npm workspaces for three
reasons:

1. a per-developer workspace entry leaks into the lockfile, and `npm ci` exits 0 on a dangling link;
2. Vite compiles anything matched by a workspace glob from source;
3. each package must stay releasable on its own lockfile.

The tool built instead installs every checkout on its own, so the checkout's own copies of core,
React and its localized siblings come back with every install. Keeping one copy of each is now most
of the code: pruning with a range rule, a resolution check that keeps some copies, an `@types` stub
case, a run-time check before `start`/`script`/`call`/`build-all`, two relink hooks, `--no-save`
and `--include=dev` installs, and a Vite dedupe derived from the same rule. That is about 3,200
lines in `src/localize/` and 19 localize commits between 29 September and 12 October 2026. It is
a reimplementation of the hoisting npm already does in a workspace.

Measured against those three reasons:

1. **The leak is real but avoidable.** See [the design](#the-design): the committed lockfile never
   changes, and a pre-commit hook plus a CI grep refuse one that would.
2. **Building checkouts from source is what we want while editing them.** Vite dev served core
   from `packages-local/_linked-core/src` with one React. The production build took core only from
   the checkout.
3. **A checkout's own lockfile can still be maintained.** Inside the checkout,
   `npm install <dep> --package-lock-only --prefix .` changes only its own `package.json` and
   lockfile and creates no `node_modules`. A fresh clone of it then passes `npm ci`. Without
   `--prefix .`, npm targets the workspace root.

## The design

### Committed once in the app

```json
"workspaces": ["packages/*", "packages-local/*"],
"scripts": {
  "postinstall":  "node scripts/lock-at-rest.cjs",
  "dependencies": "node scripts/lock-at-rest.cjs",
  "delocalize":   "mv packages-local .packages-local.parked && npm ci",
  "relocalize":   "mv .packages-local.parked packages-local && npm install",
  "check:local":  "node scripts/check-local.cjs"
}
```

- **The lockfile change is one hunk.** The root entry's `workspaces` gains `"packages-local/*"`.
  Where `packages-local/` is absent or empty (CI, Docker, a fresh clone), `npm ci` installs a tree
  identical to the one before the change, and `npm install` is a no-op.
- **`packages-local/` and `.packages-local.parked/` are gitignored.**
- **Three `$` overrides go:** `@_linked/core`, `@_linked/react` and `@_linked/server-utils`.
  - A root override on a package that becomes a workspace member always fails with `EOVERRIDE`
    (Arborist's `assertRootOverrides`). That happens whether the value is a `$` reference or a
    literal range.
  - Scoping the overrides per parent installs, but leaves 18 nested copies of core when the app's
    range is ahead of the checkout.
  - The three are redundant today: a fresh resolution with each one removed is byte-identical,
    because every dependent's range overlaps. Their original purpose (stopping auth and others
    nesting an old `@_linked/react`) moves into the drift check, which flags any nested copy of
    them.
- **Shared hooks in `.githooks/`,** turned on with `git config core.hooksPath .githooks`. A
  `prepare` script can set that.

### How it runs

- **Install.** With checkouts in `packages-local/`, `npm install` links them, hoists and dedupes
  their dependencies, and rewrites `package-lock.json`. Then `lock-at-rest.cjs` restores the
  committed lockfile with `git checkout -- package-lock.json`. `node_modules` stays linked: the CLI
  reads only npm's hidden lockfile (`node_modules/.package-lock.json`, `prune.ts`), and Vite reads
  neither file. `git status` stays clean.
- **Pull, merge, branch switch.** The tracked files are always clean, so git never refuses.
  `post-merge` and `post-checkout` run `npm install` when `package.json` or the lockfile changed,
  which re-links the checkouts on top of the new lockfile.
- **Drift.** `check-local.cjs` runs after every install and reads the hidden lockfile. It reports:
  - a second copy of a localized package;
  - a nested copy of one of the three former override packages;
  - a declared range a checkout does not satisfy;
  - a missing checkout directory.

  It only reports and never fails the install. npm itself is silent about all of these:
  - it links the app's direct dependency to a checkout by name, whatever the version;
  - when one checkout misses another's range, it nests a registry copy that stays after the range
    is reverted;
  - `npm ci` exits 0 with a dangling link when a checkout directory is missing.
- **Changing the app's dependencies while localized:** `npm run delocalize`, then
  `npm install <dep>`, commit, `npm run relocalize`. About 45s.
  - `lock-at-rest.cjs` does not restore the lockfile when `package.json` differs from HEAD; it
    warns instead.
  - The warning only shows when `node_modules` changed, because npm runs the `dependencies` script
    only then and pipes its output, so the script also writes to `/dev/tty`.
  - The pre-commit hook is the real safety net.
- **Delocalize must use `npm ci`.** `npm install` replaces the cli link with the registry copy and
  leaves `lib/esm/launch.js` without its execute bit (`node_modules/.bin/linked: Permission
  denied`, exit 126, reproducible).

### Version bumps

None are needed while developing. The app gets the checkout whatever its version. After the
framework PR is released, Renovate's Monday PR bumps the app's range. If an app PR needs the new
release before then, delocalize, bump, commit, relocalize. The app's CI installs from its lockfile,
so a forgotten bump fails there loudly (a missing export).

## Measured

npm 12.2.0, Node 22.23.3. The setup was a CN clone at `101d6788` with `@_linked/core`, `auth`,
`shape-ui` and `cli` in `packages-local/`, plus a second clone for the CI view.

| Scenario | Result |
|---|---|
| `npm ci`, glob committed, no `packages-local/` | 1903 packages, tree identical to before; `npm install` "up to date" |
| One copy | core 1 + 24 deduped; React, react-dom, TypeScript and Vite one copy each; 0 physical copies of the checkouts |
| Registry versions vs a fresh unlocalized `npm ci` of the same commit | 0 different, 0 missing; only extras are the checkouts' own devDependencies, nested under them |
| `linked build-all` from the app | finds the checkouts, cli first, 19.7s |
| `typecheck:gate`, Vitest, core Jest, production build, Vite dev | all pass; Vitest 1873 tests, core Jest 2116 tests; core served from the checkout in dev and taken from it in the build |
| Renovate-style pull while localized | fast-forward, hook installs, 10.5s, clean; server 2.24.9 from the registry, core stays linked; drift check reports the range now ahead of the checkout |
| Branch switch to a different lockfile and back | 9s each way, clean, still linked |
| Repeated `npm install` | "up to date" in 8–10s (6s without checkouts) |
| `npm ci` with checkouts present | fails safely (`EUSAGE`, lock out of sync); nothing changed. npm's message never mentions `packages-local` |
| `node_modules` size | 997 MB for the app, 0–28 MB per checkout; today's checkouts use 186–297 MB each |

Earlier synthetic runs, a rejected outer-workspace layout (it breaks a dozen hard-coded
`./node_modules` paths in CN and duplicates `overrides`/`allowScripts`) and the full logs were in a
scratchpad that is not kept. The prototype scripts are in [009-assets/](009-assets/).

## Plan

1. **Trial, one week, before any code leaves the prototype.** Run it with:
   - all localized checkouts, not four
   - both developers, with different sets localized
   - one real Renovate Monday
   - adding an app dependency while localized
   - switching between branches that change the lockfile
   - the Docker dev flow

   Keep the current localize frozen meanwhile: fix only real breakages, add no new guards.
   - **Stop and keep localize if:** a pull or branch switch needs manual lockfile handling; the
     drift check fires more than once a week; Docker breaks; or a lockfile with `packages-local`
     entries reaches a PR.
   - **Otherwise go ahead.**
2. **In the app (CN):**
   - commit the glob, the lockfile hunk, the scripts and the `.githooks/`; remove the three
     overrides;
   - add a CI step that fails if `package.json` or `package-lock.json` has a `packages-local/`
     entry (the hook can be skipped with `--no-verify`);
   - replace the `linked localize --relink` hooks;
   - update `.gitignore` (its comment says `packages-local` is in no workspace glob), CLAUDE.md,
     `docs/how-to/develop-a-linked-package-locally.md`, and the overrides rationale in arch-03;
   - retire or invert `tests/integration/localize-lockfile-untouched.spec.ts`. Its L2 asserts the
     opposite of this design.
3. **In this CLI:**
   - `linked localize <pkg>` keeps the clone (from the registry's `repository` field, `--repo`,
     `--subdir`) and `--adopt`, then runs `npm install` at the app root;
   - `linked delocalize` removes the checkout from `packages-local/`, then `npm ci`;
   - `--list` reads `packages-local/` and the hidden lockfile instead of symlinks and
     `local-packages.json`;
   - the run-time one-copy check becomes `check-local`;
   - remove pruning, `--relink`, `--ensure`, `--reinstall`, `--no-prune`, the `providedPackages`
     rule and the localize-derived Vite dedupe;
   - `create-app` scaffolds the glob, scripts and hooks.
4. **Bootstrap with the cli itself localized.** A fresh cli checkout has no `lib/`, and its build
   needs core's `lib/`. Today the app's postinstall then fails with `linked: command not found`
   (exit 127). Dropping `linked` from postinstall removes that failure. `build-all` still builds
   cli first and fails on TS2307 while core is unbuilt, so it should build core first when both
   are checkouts.
5. **Migrating today's setups:**
   - delete each checkout's own `node_modules` and `local-packages.json`;
   - a checkout that sits in `packages-local/` while it is still being pruned must not be mixed
     with the new layout, so migrate all checkouts in one step.

## Open questions

- Should `lock-at-rest` and `check-local` stay plain dependency-free scripts in the app (no
  bootstrap risk), or ship in this CLI and be invoked by path?
- Root overrides now also apply to the checkouts: CN's `jest ^29.7.0` ran core's tests on Jest 29,
  while core's own CI uses 30. Accept that, or drop the override from CN?
- npm runs every checkout's `prepare`/`postinstall` on every root install, even an up-to-date one.
  No checkout has an expensive one today. Should we keep it that way by convention?
- npm warns `allowScripts in workspace @_linked/auth … is ignored`. It is harmless (the root list
  already covers it). Silence it, or leave it?
