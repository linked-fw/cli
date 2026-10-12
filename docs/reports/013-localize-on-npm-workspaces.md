---
date: 2026-10-12
summary: >
  `linked localize` is rebuilt on npm workspaces. An app commits `"packages-local/*"` in its
  `workspaces`; npm links and dedupes every checkout, so there is one copy of each shared package
  with the same registry versions CI installs. A dependency-free lock-at-rest hook shipped in the
  cli restores the committed lockfile after every install, marker-tagged git hooks re-install on
  pull/merge/branch switch and refuse a leaked lockfile, and a drift report (`--list --check` for
  CI) replaces pruning. `delocalize` parks checkouts; the first localize sets the app up in one
  committable diff. Pruning, relink, `--ensure`, `--reinstall`, `local-packages.json` and the
  localize-derived Vite dedupe are gone (`src/localize` 3,721 → ~2,300 lines, plus ~900 in
  `hooks/`). The cli is also hardened for Windows (untested there). Minor release, not yet
  published; a consuming app needs it before it can adopt the new set-up. Replaces plan 001 and
  backlog 009.
---

# 013 — Localize on npm workspaces

## Why

`linked localize` lets a developer work on a framework package from a git checkout without
changing a committed file. The previous model ([report 011](011-localize-one-copy.md)) installed
every checkout on its own against its own lockfile and symlinked it into the app. Each such install
brought back the checkout's own copies of core, React and its localized siblings, so most of the
code existed to remove them again: pruning with a range rule, a resolution check that kept some
copies, an `@types` companion case, a run-time check before `start`/`script`/`call`/`build-all`,
two relink hooks, `--no-save`/`--include=dev` installs and a Vite dedupe derived from the same rule
— about 3,200 lines and 19 commits in two weeks. It was a reimplementation of the hoisting npm
already does in a workspace.

Report 011 rejected workspaces for three reasons. Measured against them:

1. **A per-developer workspace entry leaks into the lockfile** — real, but avoidable: the committed
   lockfile is restored after every install, and a pre-commit hook plus a CI grep refuse one that
   would leak.
2. **Vite compiles anything a workspace glob matches from source** — which is what we want while
   editing a checkout. Measured: Vite dev served core from `packages-local/_linked-core/src` with
   one React; the production build took core only from the checkout.
3. **Each package must stay releasable on its own lockfile** — still possible:
   `npm install <dep> --package-lock-only --prefix .` inside the checkout changes only its own
   `package.json` and lockfile, and a fresh clone of it passes `npm ci`.

### Measured

npm 12.2.0, Node 22.23.3, a large consuming app (≈1900 packages) with core, auth, shape-ui and the
cli as checkouts, plus a second clone for the CI view.

| Scenario | Result |
|---|---|
| `npm ci`, glob committed, no `packages-local/` | 1903 packages, tree identical to before; `npm install` "up to date" |
| One copy | core 1 + 24 deduped; React, react-dom, TypeScript, Vite one copy each; 0 physical copies of the checkouts |
| Registry versions vs a fresh unlocalized `npm ci` | 0 different, 0 missing; the only extras are the checkouts' own devDependencies, nested under them |
| `build-all` from the app | finds the checkouts, builds core, then the cli, then the rest: 19.7–24 s |
| typecheck gate, Vitest (1873 tests), core Jest (2116), production build, Vite dev | all pass; core comes only from the checkout (66 sources in the sourcemaps, none from `node_modules`) |
| Renovate-style pull while localized | fast-forward, hook installs, 10.5 s, clean `git status` |
| Branch switch to a different lockfile and back | 9–13 s each way, clean, still linked |
| Repeated `npm install` | "up to date" in 8–10 s (6 s without checkouts) |
| `npm ci` with checkouts present | fails safely (`EUSAGE`, lock out of sync), changes nothing |
| `node_modules` size | 0–28 MB per checkout, against 186–297 MB each in the old model |

## How it works

```
app/package.json   workspaces: [..., "packages-local/*"]        committed once
                   postinstall / dependencies: guarded lock-at-rest command
app/packages-local/<scope-name>/   git checkouts = workspace members   (gitignored)
app/packages-local/.repos/<repo>/  whole monorepo clones for --subdir (dot dir: not a member)
app/packages-local/.setup-aside/   checkouts moved aside during set-up (crash-recoverable)
app/.packages-local.parked/        delocalized checkouts                (gitignored)
<git hooks dir>/{post-merge,post-checkout,pre-commit}   marker-tagged sh shims

npm install ─► links + dedupes members ─► lock-at-rest
                                            ├─ no members / no git            → nothing
                                            ├─ a manifest ≠ HEAD              → warn, leave lockfile
                                            ├─ lockfile dirty                 → restore (index, else HEAD)
                                            └─ hidden lockfile content changed → drift report, hooks notice
```

- **The glob.** With checkouts present, `npm install` links them and hoists/dedupes their
  dependencies. Where `packages-local/` is absent or empty (CI, Docker, a fresh clone), `npm ci`
  installs exactly the tree it did before the glob was added. Dot directories (`.repos`,
  `.setup-aside`) are skipped by the `*` glob (re-measured on npm 12.2.0).
- **Lock-at-rest** (`hooks/lock-at-rest.cjs`). After every install it restores
  `package-lock.json` from the index when the staged copy has no checkout entry, else from `HEAD`.
  When any workspace manifest differs from `HEAD` it leaves the lockfile alone and warns that it must
  not be committed: dependency changes need `linked delocalize` first. `node_modules` stays linked —
  the cli and Vite never read the committed lockfile. npm pipes the `dependencies` script's output,
  so warnings also go to `/dev/tty` where there is one.
- **Git hooks.** `post-merge` and `post-checkout` (branch checkouts only, `$3 == 1`) run
  `npm install --no-audit --no-fund` when `package.json`, the lockfile or any tracked workspace
  member's `package.json` changed, and do nothing in a work tree without checkouts. `pre-commit`
  refuses a staged `package.json`/`package-lock.json` that lists a checkout, and refuses when git
  cannot show what is staged. A hook never fails a pull or a checkout.
- **Drift.** One implementation (`hooks/drift.cjs`) reads `node_modules/.package-lock.json` and the
  live manifests and reports four kinds: a range a checkout misses, a second copy of a localized
  package, a nested copy of `@_linked/core`/`@_linked/react`/`@_linked/server-utils`, and a
  checkout npm installed that is gone. It is shown by `--list`, by lock-at-rest after an install
  that changed the tree, and before `start`/`script`/`call`/`build-all`; it only fails under
  `--list --check`. npm is silent about all four: it links an app's direct dependency to a checkout
  whatever its version, nests a registry copy when one checkout misses another's range (removed
  again by the next install once the range is fixed), and `npm ci` exits 0 on a dangling link.
- **Parking.** `delocalize` moves a checkout to `.packages-local.parked/`, outside the glob, and
  reinstalls registry copies; `localize <name>` or `--parked` moves it back without cloning.
- **App set-up.** The first `linked localize` adds the glob, the guarded `postinstall` and
  `dependencies` scripts and the `.gitignore` lines, and produces the matching lockfile, so the work
  tree shows exactly the three files to commit.
- **App root.** Every command acts on the nearest ancestor whose `package.json` has `workspaces`,
  climbing further only through ancestors whose globs match the path so far (or, for a path under
  `packages-local/`, whose globs list `packages-local/*`). Commands work from inside a member or a
  `--subdir` checkout's real path, and a git worktree nested inside the app stays its own app.

## Decisions

| # | Decision | Why |
|---|---|---|
| D1 | The plan lived in this repo; the consuming app's changes went in its own PR referencing it. | Docs live with the code. |
| D2 | **Minor release.** `--relink` and `--ensure` become no-ops that exit 0; `--reinstall`, `--no-prune` and `localize --force` are removed. | No repo imports the removed modules; an app still calling the two flags keeps installing. A major would need manual Renovate approval in ~22 repos for no consumer benefit. Removed deep imports are listed in the changeset. |
| D3 | **Lock-at-rest is a plain, unbuilt `.cjs` shipped in the cli** (`hooks/`, in `files`), run by `node`, never through the `linked` bin. Scripts guard the call: `node -e "…existsSync(p)&&require(…)"`. | A fresh, unbuilt cli checkout still has it, so the old bootstrap failure (`linked: command not found` in postinstall) cannot happen; the guard keeps `npm ci --omit=dev` (Docker, production) working without the cli. Rejected: a copy per app (drifts); requiring the cli as a production dependency. |
| D4 | **Git hooks are written by `linked localize`** into the clone's own hooks directory, marker-tagged; a foreign hook is left alone and reported. Nothing is committed. **Corrected:** under `core.hooksPath` (husky, a tracked hooks dir) nothing is written — localize prints one line per hook to add by hand, ending `\|\| exit $?` so it refuses wherever it sits. In linked worktrees the hooks are shared; the members guard makes them harmless in a worktree without checkouts, and localize says they are shared. | Only clones that localize get hooks. Rejected: committed `.githooks/` + `core.hooksPath` (every clone must opt in, and they run for people who never localize); per-worktree config (needs `extensions.worktreeConfig`). |
| D5 | **The drift check lives in the cli** (one `driftProblems`), report-only except `--list --check`. A consuming app's CI runs `--list --check` after `npm ci`. | Replaces both the `$` overrides' single-copy guarantee and the old `--ensure` pre-scripts. Its own `hooks/drift.cjs` so lock-at-rest runs it in-process (no ~2 s cli spawn per install); stamped on the hidden lockfile's sha1 so it prints once per tree change. |
| D6 | **`local-packages.json` is retired.** The record is the set of directories in `packages-local/` with a `package.json`. | One source of truth that cannot drift from disk; an old file gets a one-line migration hint. |
| D7 | **Delocalize parks.** `npm ci` when no checkout remains and the lockfile is tracked and clean, else `npm install` + `npm rebuild <names>`. `--purge` deletes, fail-closed. | Parking makes un/re-localizing cheap. `npm rebuild` because an `npm install` that swaps a link for the registry copy leaves the bin without its execute bit (measured, exit 126). |
| D8 | **One-time app set-up, committed by the developer.** localize ensures the glob, guarded scripts (replacing `--relink` or the earlier unguarded hook) and `.gitignore`; it never edits `overrides`: an override key naming a package being localized refuses with exit 6, before anything is cloned. | npm fails every root override on a workspace member with `EOVERRIDE` (`$` or literal). Scoped per-parent overrides were rejected: they install but leave 18 nested copies of core when the app's range is ahead of the checkout. |
| D9 | **Build order.** `build-all` builds the cli's in-plan dependency closure first, then the cli alone, then the rest. localize builds a cloned cli with its own `npm run build`, then links its bin. | A cli checkout needs core's `lib/`. The case "cli and core both fresh, unbuilt" keeps a documented manual recipe. |
| D10 | **Docker keeps registry copies.** Compose services mount an anonymous volume over `/workspace/packages-local`. **Corrected rationale:** this is a change, not today's behaviour — the old postinstall `--relink` ran inside the container and recreated links into the bind-mounted checkouts. Localize on the host only; on Linux the mountpoint is created root-owned. | Host checkouts visible through the bind mount would make `npm ci` in the container fail. |
| D11 | **The live migration and the trial are manual.** Nothing touches a developer's current setup. | See Deferred. |

Rejected at the design stage: an outer-workspace layout around the app (it broke a dozen hard-coded
`./node_modules` paths in the consuming app and duplicated `overrides`/`allowScripts`); keeping the
`$` overrides (they make localizing those packages impossible).

## Files

| File | Responsibility |
|---|---|
| `hooks/lock-at-rest.cjs` | npm `postinstall`/`dependencies`: restore the lockfile (index-first), warn when manifests differ from `HEAD`, stamp-gated drift report, missing-hooks notice, stranded `.setup-aside/` notice |
| `hooks/git-hook.cjs` | `pre-commit` leak refusal (fail-closed, `--diff-filter=d`); `post-merge`/`post-checkout` install on manifest change, members guard, strips `GIT_*` from npm's env |
| `hooks/hook-shim.cjs` | the `sh` shim text: marker, per-hook commands, `hookLine` for `core.hooksPath`, `runsOurHook`; records the app's `--show-prefix`, makes `GIT_DIR`/`GIT_INDEX_FILE`/`GIT_WORK_TREE` absolute, `cd`s to the app |
| `hooks/manifests.cjs` | workspace globs, tracked-member pathspecs, `expandGlobs`, `globsMatch` (`*`, `?`, `**`, `!`), `localMembers`, the shared `LEAK` rule |
| `hooks/drift.cjs` | the drift implementation (`driftProblems`, `describeDrift`, the singleton list, `satisfies` via the app's `semver`, no range check without it) |
| `hooks/platform.cjs` | `npmCommand` (Windows `shell: true`), `terminalDevice` (no `/dev/tty` on win32) |
| `src/localize/localize.ts` | `runLocalize` shared by localize/adopt/`--parked`: override check → set-up (+ lockfile capture) → per name unpark/clone → hooks → one root install → builds → report |
| `src/localize/adopt.ts`, `delocalize.ts`, `list.ts` | adopt and `localizeParked`; park/purge and the `npm ci` vs install rule; `--list`/`--check` |
| `src/localize/app-setup.ts`, `setup-lockfile.ts` | `ensureAppSetup` (indent, key order and EOL kept), `conflictingOverrides`; the set-up lockfile by root-entry edit |
| `src/localize/app-root.ts` | `findWorkspaceRoot` / `findAppRoot` (shared with `build-all`) |
| `src/localize/git-hooks.ts` | `installGitHooks` → `{written, skipped, manual, hooksPath, sharedWithWorktrees}` |
| `src/localize/drift.ts`, `drift-hook.ts`, `hook-module.ts` | typed wrapper over `drift.cjs`; the report-only preAction (`DRIFT_COMMANDS`); `requireHook` (finds `hooks/` from `src/` or `lib/esm/`) |
| `src/localize/members.ts`, `resolve.ts`, `run.ts`, `fsops.ts`, `errors.ts`, `index.ts` | `LOCAL_DIR`/`PARKED_DIR`/members; registry → git URL; `deps`/`run`; directory moves and links; exit codes; programmatic API |
| `src/utils/spawn.ts` | `planCommand`, `spawnCommandSync`, `spawnCommand`, `runCommand`, `quoteCmdArg` — the one way to start `npm`/`npx`/shims |
| `src/utils/platform.ts` | `samePath`, `isPathInside`, `linkDirectory` (junction on win32), `importFile`/`importSpecifier`, `withEolOf` |
| `src/lifecycle.ts`, `src/cli-methods.ts` | `orderBuildToolFirst` → `{pre, tool, rest, start, from}`; `buildAll` builds the three groups in order, `--from` resumes across them |
| `src/vite-config.ts` | `resolve.dedupe` = the standalone pair (`@_linked/server-utils`, `@_linked/react`) when standalone, plus `react`/`react-dom` when installed (`dedupeFor`); nothing localize-derived |
| `src/utils/createPackageLocation.ts` | `create-package --location packages-local` runs the set-up and adopts |

Deleted: `prune`, `ensure`, `relink`, `provided`, `manifest`, `one-copy-hook`, `semver` (in
`src/localize/`), `src/localized-dedupe.ts`, `src/utils/relinkHooks.ts`, `readInstalledPkgSync`,
the link/snapshot half of `fsops`.

## Command surface

| Command | Behaviour |
|---|---|
| `linked localize <pkg…>` | set-up + override check; parked → move back, else clone (registry `repository`, `--repo`, `--subdir`); git hooks; one `npm install` at the app root; build each new checkout (`--build`, else `linked build`, or `npm run build` + bin relink for the cli) |
| `linked localize <pkg…> --adopt` | the same for a checkout already in `packages-local/` (`--adopt --repo` refused) |
| `linked localize --parked` | move every parked checkout back, one install |
| `linked localize` / `--list [--check]` | members, parked, branch, version, drift lines; `--check` prints only drift and exits 1 on any |
| `linked localize --relink` / `--ensure` | deprecated no-ops, exit 0 (`--ensure` prints one hint) |
| `linked delocalize [pkg…] [--purge [--force]]` | park and reinstall; `--purge` deletes when the work is saved elsewhere |

`--dir` accepts only `packages-local`. `--subdir` clones the repository whole into
`packages-local/.repos/<checkout>` and links `packages-local/<checkout>` to the package (npm 11/12
links a symlinked member); `--purge` removes the clone when nothing else links into it.

| Exit | Meaning |
|---|---|
| 0 | fine (`--relink`, `--ensure` always) |
| 1 | `--list --check` found drift |
| 2 | bad command line |
| 4 | no repository could be resolved |
| 5 | warned and skipped (failed build, name not localized, park blocked, failed `npm rebuild`) |
| 6 | a guard refused (existing directory, unpark clash, conflicting override, clone that is not the package, failed clone, unusable `package.json`, refused `--purge` — was 5) |
| 7 | `npm install`/`npm ci` at the app root failed |

3 and 8 (the record file, manifests changed) are retired and not reused. The overall code is the
highest of the per-package codes and the install's.

## Programmatic API

`@_linked/cli/localize/index.js` exports `localize`, `adopt`, `localizeParked`, `delocalize`,
`list`, `collect` (synchronous, returning an exit code; each takes `deps` —
`{appRoot, run, log, warn, error}`, built by `defaultDeps()`), `driftProblems`, `describeDrift`,
`satisfies` (`null` when it cannot tell), `LOCAL_DIR`, `PARKED_DIR`, `localMembers`,
`parkedMembers`, `ensureAppSetup`, `findAppRoot`, `resolvePackage`, `normalizeGitUrl`,
`checkoutNameFor`, `makeRun`, `DEFAULT_BUILD_COMMAND`, `LocalizeError` and the `EXIT_*` codes, with
the types `LocalizeOptions`, `ListRow`, `Drift`, `Member`, `SetupChange`, `Resolved`, `Deps`, `Run`,
`RunOptions`, `RunResult`.

## Windows

Every command in `src/cli.ts` and every hook was audited and made Windows-safe; nothing was run on
Windows (no one on the team uses it). `npm`/`npx` start as `node npm-cli.js`/`npx-cli.js` when
npm started the cli, else as `<name>.cmd` through `cmd.exe` with arguments quoted (escaped twice for
shims that re-parse `%*`); `git`, `gh`, `node` start directly. `--subdir` links are junctions;
files are imported by `file:` URL on win32; path comparisons go through `samePath`/`isPathInside`;
edited `package.json`, `.gitignore`, `.npmrc` and source files keep CRLF; `cd <dir> &&` chains,
`/dev/tty`, single-quoted shell strings and `chmod` in the cli's own build script are gone;
`getModulePackageJSON` stops at a drive root; the hook shim accepts `C:/…` as absolute. Known
limitations: the git hooks rely on Git for Windows' `sh` handing `$PWD` to `node` as a Windows
path; lock-at-rest's notices from the `dependencies` script are hidden (no `/dev/tty`); a
`--subdir` junction is absolute, so moving the app breaks it (`mklink /J` remakes it);
user-supplied command strings (`--build`, `linked all <cmd>`) run in `cmd.exe` as written; the
cli's own `test:template` script sets an env var the POSIX way.

## Bugs found and fixed during integration and reviews

| Found | Bug | Fix |
|---|---|---|
| integration | A localized cli's bin was never linked: npm skips a bin whose file is missing at install time, and `npx linked` then resolves to an unrelated registry package. | localize builds the cli first, then `npm rebuild @_linked/cli --ignore-scripts`; the bootstrap recipe gains the line. |
| integration | pre-commit let a leaked lockfile through: `execFileSync`'s 1 MB buffer threw `ENOBUFS` on a 1.05 MB lockfile, read as a staged deletion. | Larger buffer; test fails before the fix. |
| integration | A conflicting override was found only after cloning (npm `EOVERRIDE`, exit 7). | Override check before anything is cloned, exit 6, key named. |
| integration | First set-up's lockfile-only capture failed with `EALLOWREMOTE` (npm 12 fetches a `bundleDependencies` tarball without the same-registry exemption); npm 11 succeeded but added ~60 `inBundle` lines. | `setup-lockfile.ts`: edit the root entry's `workspaces` directly when it already has them, `hasInstallScript: true`, matching dependency fields and a clean JSON round-trip; npm, then the manual steps, as fallbacks. |
| integration | The drift report reprinted on every `up to date` install: npm rewrites the hidden lockfile each time, so an mtime stamp never matched. | Stamp on the content hash. |
| integration | Drift printed twice per install (`postinstall` and `dependencies`) and spawned the cli twice (~2 s). | In-process `drift.cjs`, stamp-gated. |
| review 1 | Hooks broken under `core.hooksPath` (skipped by husky, or written into a tracked dir) and run in every worktree. | Print lines instead of writing; members guard. |
| review 1 | Removing the `$` overrides dropped the app's single-copy guarantee outside localize. | `--list --check` in the app's CI reports `singleton-copy`. |
| review 1 | An app below the git top level got hooks that silently did nothing; `packages/*` was hard-coded, so a change in another workspace folder had its lockfile change discarded. | Shim records the prefix and `cd`s; pathspecs derived from the app's `workspaces`. |
| review 1 | `localize` run inside a member set up the member's `package.json`. | App-root rule. |
| review 1 | postinstall hard-failed where the cli is not installed (`--omit=dev`). | Guarded command; set-up upgrades the unguarded form. |
| review 1 | Lock-at-rest always restored from `HEAD`, silently discarding a staged lockfile change. | Index first, `HEAD` only when the staged copy leaks. |
| review 1 | First set-up needed four manual steps. | One-step set-up with lockfile capture. |
| review 1 | Fail-open guards: `--purge` deleted when git errored; pre-commit treated any `git show` error as a deletion. | Both fail closed (exit 6 / exit 1 naming the error and `--no-verify`). |
| review 2 | `findAppRoot` climbed past a git worktree nested in the app to the main checkout, so commands there would act on the main clone. | Climb only through ancestors whose globs match. |
| review 2 | Moving checkouts aside during set-up was not crash-safe (Ctrl-C stranded them outside the gitignore). | `packages-local/.setup-aside/`, restored at the start of localize/delocalize/`--list`; a clash refuses. |
| review 2 | `--purge` missed commits on a detached `HEAD`. | `git log HEAD --branches --not --remotes`. |
| review 2 | The set-up lockfile edit did not check the existing `workspaces`, so it could write a lockfile `npm ci` rejects. | Edit only on deep equality with the pre-set-up globs. |
| review 2 | A clone that never ran localize (hand bootstrap) had no hooks, and the app's CI checks are not enforced. | Lock-at-rest notice naming a checkout with `.git` and the `--adopt --build ''` line; a foreign `pre-commit` gets the exact line instead. |
| review 3 | From inside a `--subdir` checkout the app root resolved to the framework monorepo. | A path under `packages-local/` matches an ancestor listing `packages-local/*`. |
| pause | Unparking a name already a member elsewhere; `delocalize` running `npm ci` on an untracked or changed lockfile; `git clone` without `--`; `build-all` result not returned; double `[localize]` prefix. | Exit-6 refusal; `npm ci` only when tracked and clean; `--`; `return`; one prefix. |
| P15 review | A hand-added hook line only refused when it was the last line of the hook. | `hookLine` ends with `\|\| exit $?`. |
| P15 review | `isPathInside` rejected a child named `..foo`; `npm.cmd` fallback escaped once; `npm_execpath` ending in `npx-cli.js` missed the fast path. | Fixed, with tests. |
| P15 | The React Native template test overlaid only `lib/`, which now requires `hooks/drift.cjs`. | Overlays `hooks/` too. |

## Tests

`npm run test:unit`: **68 suites / 780 tests**; `npm run test:template`: 22 tests; `tsc` clean,
`npm run build` OK.

| File | Covers |
|---|---|
| `localize/hooks.test.ts` | lock-at-rest and `git-hook.cjs` spawned in real git repos: index vs `HEAD` restore, other workspace folders, app below the top level, stamp-gated drift, guarded command with and without the cli, members guard, fail-closed pre-commit (a `git` shim), staged deletions, hooks notice variants, `.setup-aside` notice, `\|\| exit $?` |
| `localize/commands.test.ts`, `adopt.test.ts` | the localize pipeline order with a fake `run`, override refusal, unpark, cli build + bin relink, set-up capture and fallback, delocalize `npm ci` vs install + rebuild, `.setup-aside` recovery and clashes |
| `localize/git-hooks.test.ts` | marker, foreign hooks, paths with spaces and quotes, relative `GIT_DIR`, a real refused commit from a subdirectory, husky `core.hooksPath`, worktree warning |
| `localize/purge.test.ts` | real git: pushed → deletes; no `.git`, failing git, dirty, unpushed branch, detached `HEAD`, stash → 6; `--force` |
| `localize/drift.test.ts`, `drift-hook.test.ts`, `semver.test.ts` | the four drift kinds; the preAction never throws; the range table |
| `localize/app-setup.test.ts`, `setup-lockfile.test.ts`, `app-root.test.ts`, `manifests.test.ts`, `members.test.ts`, `resolve.test.ts` | set-up idempotence, upgrades, CRLF; edit conditions; nested worktree, member, `--subdir` real path; glob expansion/matching; members; URL resolution |
| `localize/real-localize.test.ts` | real clone + real `npm install`: symlinked member, clean `git status`, first set-up is exactly three modified files and a one-hunk lockfile diff that `npm ci` accepts |
| `windows.test.ts` | `planCommand` posix/win32, quoting and double escapes, `samePath`/`isPathInside`, junctions, `importSpecifier`, `withEolOf`, guard command's cmd-safety, hook `sh` with `C:/…` `GIT_DIR` |
| `localizeCommand`, `buildAll*`, `viteDedupe`, `createPackageLocation`, `discoverWorkspaces*` | commander wiring and app root; `{pre, tool, rest}` order and `--from`; returned `buildAll`; standalone dedupe; create-package set-up; glob + checkout discovered once |

Mutation checks, each reverted and each caught: nine critical behaviours in review 1; eight hook
mutations (HEAD-only restore, no members guard, fail-open read, no `--diff-filter`, no stamp,
root-only pathspecs ×2, glob-only leak rule); no env fix in the shim; no set-up write-back; no
set-up edit; mtime stamp; the subdir app-root rule; the `|| exit $?`.

Integration was run twice in standalone clones of the consuming app with four checkouts (never the
developer's own checkout): install, `--list`, build-all, typecheck, Vitest, production build,
backend start, pulls/branch switches via the hooks, delocalize/`--parked`, drift, conflicting
override, `npm ci` with checkouts, migration from the old model, one-step set-up, a husky
`core.hooksPath`, purge refusals, the CI path without checkouts, and a worktree without checkouts.

## The consuming app's side

What an app commits (the first `linked localize` produces the first three):

- `"packages-local/*"` in `workspaces`, and the one-hunk lockfile change (root `workspaces`,
  `hasInstallScript`);
- `postinstall` and `dependencies` running the guarded lock-at-rest command;
- `.gitignore`: `packages-local/`, `.packages-local.parked/`;
- `$` overrides removed for every package that may be localized (npm refuses them on a member);
- `pre*` scripts calling `--ensure` and `--relink` hooks removed;
- CI: a grep failing on `"packages-local/` followed by anything but `*"` in either manifest (the
  same rule as `pre-commit`, which `--no-verify` skips), and `npx linked localize --list --check`
  after `npm ci` as the single-copy check;
- Docker: an anonymous volume over `/workspace/packages-local` in every service with the bind mount;
- any test asserting the old "localizing never touches the lockfile" model retired.

Release order: merge the cli PR → release → bump `@_linked/cli` in the app → fresh-clone `npm ci`
without `packages-local/` → merge the app's PR (its CI install fails until the release ships
`hooks/`). Then the developers' trial and migration: delete `local-packages.json` and each
checkout's own `node_modules`, `npm install`, then one `npx linked localize <names…> --adopt` (for
a localized cli: build it and relink its bin first). Migrate all checkouts in one step.

## Known limitations and remaining low gaps

- `globsMatch` honours `*`, `?`, `**` and `!`, but not npm's re-inclusion order or brace globs.
- Windows is untested; lock-at-rest notices are hidden there; `--subdir` junctions hold absolute
  paths.
- After lock-at-rest restores the lockfile, the next install reports `changed ~352 packages`
  (~11 s) before settling to `up to date` (~9 s): harmless, slower.
- A `--purge` refusal names only the first reason found (uncommitted, then unpushed, then stash).
- `npm install <dep> -w <member>` runs no root lifecycle, so lock-at-rest neither warns nor
  restores; `pre-commit` still refuses the result.
- The set-up lockfile is lost if another install runs before it is committed.
- Deep imports removed in a minor (listed in the changeset; no known consumer).
- Root overrides now apply to checkouts too (e.g. an app's Jest 29 override runs a checkout's tests
  on Jest 29); npm warns `allowScripts in workspace … is ignored` (harmless); npm runs every
  checkout's `prepare`/`postinstall` on each root install, so checkouts should keep them cheap.
- Pre-commit is skipped when `node` is not on the hook's PATH; two fresh, unbuilt checkouts of cli
  and core still need the manual recipe in `docs/localize.md`.
- Overlapping localize runs are not locked against each other.

## Deferred

- **The developers' one-week trial**, with all checkouts, both developers on different sets, one
  real Renovate Monday, adding an app dependency while localized, lockfile-changing branch
  switches and the Docker dev flow. Stop and return to the old model if a pull or branch switch
  needs manual lockfile handling, the drift check fires more than once a week, Docker breaks, or a
  lockfile with `packages-local` entries reaches a PR. Otherwise migrate.
- **An app-template change** so `create-app` scaffolds the glob, scripts and `.gitignore` (the
  template is a separate repository); until then the first `linked localize` performs the set-up.
- **Retiring `@_linked/localize` on npm** (from report 011): publish a pointer release, deprecate,
  archive the repo.

## Related documentation

- [`docs/localize.md`](../localize.md) — the user guide (set-up, commands, drift, hooks, Docker/CI,
  migration, Windows, exit codes, programmatic use).
- History: [report 007](007-localize-command.md) (the original command),
  [report 010](010-localize-adopt-and-relink-reinstall.md) (adopt and relink),
  [report 011](011-localize-one-copy.md) (the pruning model this replaces).
