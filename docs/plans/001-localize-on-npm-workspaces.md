---
summary: >
  Rebuild `linked localize` on npm workspaces: the app commits `"packages-local/*"`, npm links and
  dedupes checkouts, a dependency-free hook shipped in the cli restores the committed lockfile so
  the working tree stays clean, and localize shrinks to clone/adopt/park/list plus a drift check.
  Pruning, relink, ensure, the provided rule and the localize Vite dedupe are removed. Spans this
  repo and Create Now.
status: Implementation
source: docs/backlog/009-localize-on-npm-workspaces.md
---

# 001 — Localize on npm workspaces

Source: [backlog 009](../backlog/009-localize-on-npm-workspaces.md) (the measured design, the
measurements, and the prototype scripts in `docs/backlog/009-assets/`). Read it first; this plan
does not repeat the measurements.

Repositories: **this cli** (`linked-fw/cli`) and **Create Now** (`Semantu/create-now`, "CN").
Each gets its own branch `feat/localize-on-npm-workspaces`, commits and PR.

## Chosen route

The app commits `"packages-local/*"` in its `workspaces`. With checkouts present, `npm install`
links and dedupes them; a postinstall hook restores the committed `package-lock.json`, so the
working tree is clean at rest and git pulls, merges and branch switches work unchanged. Git hooks
re-run `npm install` when dependencies changed, and refuse a lockfile that references a checkout.
`linked localize` keeps cloning (registry `repository`, `--repo`, `--subdir`) and adopting, and
gains parking (`delocalize`) and a drift check; everything that exists to keep one copy goes.

## Planning blockers (resolved)

1. Where the restore hook lives, given the cli may itself be a fresh, unbuilt checkout → D3.
2. Whether removing flags and modules forces a major release → D2.
3. How git hooks get installed without committing tooling every app must adopt → D4.
4. CN's `npm ci` in Docker would fail with host checkouts visible through the bind mount → D10.
5. `build-all` builds the cli first and alone, but a cli checkout needs core's `lib/` → D9.
6. CN's `postinstall`/`pre*` scripts call `--relink`/`--ensure` → D2, D5.

## Accepted decisions

Chosen by long-term maintainability first, then scalability, then performance.

**D1 — The plan lives here.** CN changes go in a CN PR that references this plan. Docs live with
the code.

**D2 — Minor release; `--relink` and `--ensure` become deprecated no-ops.** No repo imports the
localize modules (searched every `packages-local/` checkout; `@_linked/server` imports
`getLincdPackages`, which stays). Keeping the two flags as no-ops that exit 0 means an app still
calling them keeps installing. `--reinstall` and `--no-prune` are removed (only humans used them).
Rejected: a major (manual Renovate approval in ~22 repos for no consumer benefit).

**D3 — The lockfile restore is a plain, unbuilt `.cjs` shipped in the cli package
(`hooks/lock-at-rest.cjs`, added to `files`).** The app's `postinstall` and `dependencies` scripts
run `node node_modules/@_linked/cli/hooks/lock-at-rest.cjs`. It is in git, so a fresh, unbuilt cli
checkout still has it, and it never needs the `linked` binary: the bootstrap failure
(`linked: command not found` from postinstall) cannot happen. Rejected: a copy per app (drifts);
running it via `linked` (bootstrap).

**D4 — Git hooks are written into the clone's own hooks directory by `linked localize`.** Marked
with a header line; a hook without the marker is left alone and reported. Hooks call
`node node_modules/@_linked/cli/hooks/git-hook.cjs <hook> "$@"`. Only clones that localize get
them, and nothing is committed. Rejected: committed `.githooks/` + `core.hooksPath` (every clone
must opt in, and it would run for people who never localize).

**D5 — The drift check moves into the cli.** One function, `driftProblems(appRoot)`, reports a
second copy of a localized package, a nested copy of a singleton
(`@_linked/core`, `@_linked/react`, `@_linked/server-utils`), a declared range a checkout misses,
and a missing checkout. Shown by `linked localize --list`; `--list --check` exits 1 on any;
the existing pre-action hook before `start`/`script`/`call`/`build-all` reports them on stderr and
never fails; `lock-at-rest.cjs` runs `linked localize --list --check` when the binary exists and
ignores its exit code. CN's `pre*` `--ensure` scripts are deleted.

**D6 — `local-packages.json` is retired.** The record is the set of directories in
`packages-local/` (each with a `package.json`). If an old `local-packages.json` exists, localize
prints a one-line migration hint and ignores it.

**D7 — Delocalize parks.** `linked delocalize [pkg…]` moves the checkout to
`.packages-local.parked/<dir>` (gitignored, outside the glob), then runs `npm ci` when no checkout
remains, otherwise `npm install` followed by `npm rebuild <names>` (an `npm install` that swaps a
link for the registry copy leaves the bin without its execute bit, measured). `--purge` deletes
instead (refuses on unpushed work without `--force`). `linked localize <pkg>` takes a parked
checkout back without cloning; `linked localize --parked` takes back all of them.

**D8 — One-time app setup, committed by the developer.** `linked localize` (and `create-package
--location packages-local`) ensures, and reports what it changed:
- `"packages-local/*"` in `workspaces`;
- `postinstall` and `dependencies` run the lock-at-rest hook; an old `linked localize --relink` in
  either is replaced;
- `.gitignore` has `packages-local/`, `.packages-local.parked/`.

It never edits `overrides`: when an override key names a package being localized, it refuses with
exit 6 and says which key to remove (npm would fail with `EOVERRIDE`).

**D9 — Build order.** `build-all` builds the build tool's in-plan dependency closure first (in
dependency order), then the cli alone, then the rest. `localize`, after cloning the cli, builds it
with the checkout's own `npm run build` (tsc), not `linked build`. The case "cli and core both
fresh, unbuilt checkouts" keeps the documented manual recipe.

**D10 — Docker keeps registry copies.** CN's compose services mount an anonymous volume over
`/workspace/packages-local`, so the glob matches nothing in the container and `npm ci` works. This
is today's behaviour: host links never reached the container's `node_modules` volume.

**D11 — The live migration and the trial are manual.** Nothing here touches a developer's current
setup. Moving existing checkouts and the one-week trial (backlog 009, Plan step 1) happen after
review, by the developers.

## Remaining open questions

- CN's `jest ^29.7.0` override now applies to checkouts (core's own CI uses Jest 30). Left as is;
  recorded in the CN how-to.
- npm warns `allowScripts in workspace … is ignored` for checkouts. Harmless; documented, not
  silenced.
- npm runs every checkout's `prepare`/`postinstall` on every root install. None is expensive
  today; the localize doc asks checkouts to keep it that way.
- `linked create-app` clones `linked-fw/app-template`, a separate repository, so new apps get the
  glob and hooks only when that template changes. Proposed as a follow-up backlog item; until
  then the first `linked localize` in an app performs the setup (D8).

## Plan

### Architecture

```
app/package.json  workspaces: ["packages/*", "packages-local/*"]      (committed once, D8)
                  postinstall/dependencies: node node_modules/@_linked/cli/hooks/lock-at-rest.cjs
app/packages-local/<scope-name>/   git checkouts = workspace members   (gitignored)
app/.packages-local.parked/        delocalized checkouts               (gitignored)
.git/hooks/{post-merge,post-checkout,pre-commit}  marker-tagged, call hooks/git-hook.cjs (D4)

npm install ──► links + dedupes members ──► postinstall: lock-at-rest.cjs
                                              ├─ no members / no git        → exit 0
                                              ├─ package.json ≠ HEAD        → warn, leave lockfile
                                              ├─ lockfile dirty             → git checkout -- package-lock.json
                                              └─ linked bin present         → linked localize --list --check (report only)
```

The cli splits into three layers:

- **`hooks/*.cjs`** — dependency-free CommonJS, unbuilt, shipped in `files`. Must run with only
  Node and git: no imports from `lib/` or `node_modules`.
- **`src/localize/`** — the TypeScript commands (clone, adopt, park, list, drift, app setup, hook
  installation).
- **callers** — `cli.ts` (commander wiring and the report-only pre-action hook), `lifecycle.ts` /
  `cli-methods.ts` (build-all), `vite-config.ts`, `cli-methods.ts` create-package.

### Contracts

```ts
// src/localize/members.ts — the record (D6)
export const LOCAL_DIR = 'packages-local';
export const PARKED_DIR = '.packages-local.parked';
export interface Member { name: string; version: string; dir: string /* app-relative */ }
export function localMembers(appRoot: string): Member[];          // dirs with a package.json
export function parkedMembers(appRoot: string): Member[];

// src/localize/drift.ts — D5
export type Drift =
  | {kind: 'second-copy'; name: string; version: string; at: string}
  | {kind: 'singleton-copy'; name: string; version: string; at: string}
  | {kind: 'range-miss'; name: string; version: string; dir: string; range: string; field: string; importer: string}
  | {kind: 'missing-dir'; dir: string};
export const SINGLETONS: readonly string[];                     // core, react, server-utils
export function driftProblems(appRoot: string): Drift[];         // reads node_modules/.package-lock.json + live manifests
export function describeDrift(d: Drift): string;                 // one line

// src/localize/app-setup.ts — D8
export interface SetupChange { file: 'package.json' | '.gitignore'; what: string }
export function ensureAppSetup(appRoot: string): SetupChange[];  // idempotent
export function conflictingOverrides(appRoot: string, names: string[]): string[]; // override keys naming a localized package

// src/localize/git-hooks.ts — D4
export const HOOK_MARKER = '# managed by linked localize';
export function installGitHooks(appRoot: string): {written: string[]; skipped: string[]};

// src/localize/semver.ts — moved out of prune.ts unchanged
export function satisfies(version: string, range: string): boolean;
```

`hooks/git-hook.cjs <hook> [args]`:
- `pre-commit`: exit 1 when the staged `package-lock.json` or `package.json` contains
  `"packages-local/` followed by anything but `*"`.
- `post-merge` (`ORIG_HEAD`..`HEAD`) / `post-checkout` (`$1`..`$2`, only when `$3 == 1`): when
  `package.json`, `package-lock.json` or `packages/*/package.json` differ, run
  `npm install --no-audit --no-fund`; never fail the git command.

`hooks/lock-at-rest.cjs`: the prototype in `docs/backlog/009-assets/lock-at-rest.cjs`, with the
drift step replaced by `node_modules/.bin/linked localize --list --check` (skipped when absent,
exit code ignored), and every git call tolerant of a missing or unusable git (Docker, worktrees).

Command surface after the change:

| command | behaviour |
|---|---|
| `linked localize <pkg…>` | app setup (D8) + override check; parked checkout → move back, else clone (`--repo`, `--subdir`); install git hooks; `npm install` at the app root; build the new checkouts (`linked build`, or the cli's own `npm run build`; `--build` overrides) |
| `linked localize <pkg…> --adopt` | same, for a checkout already in `packages-local/` |
| `linked localize --parked` | move every parked checkout back, then one `npm install` |
| `linked localize` / `--list` | members, parked, branch, drift lines; `--check` exits 1 on drift |
| `linked localize --relink` / `--ensure` | deprecated: exit 0; `--ensure` prints one hint line |
| `linked delocalize [pkg…]` | park; `npm ci` if none remain, else `npm install` + `npm rebuild <names>`; `--purge` deletes (guarded) |

Exit codes keep their numbers: 0, 1 (`--check`), 2, 4, 5, 6 (guard / conflicting override),
7 (`npm install` failed). 3 and 8 (manifest file, manifests changed) are retired.

### Files expected to change

**cli** (`wt-cli`)
- add `hooks/lock-at-rest.cjs`, `hooks/git-hook.cjs`; `package.json` `files` += `hooks`
- add `src/localize/{members,drift,app-setup,git-hooks,semver}.ts`
- rewrite `src/localize/{localize,adopt,delocalize,list,index}.ts`, `src/commands/localize.ts`,
  `src/localize/one-copy-hook.ts` (report drift instead of pruning)
- delete `src/localize/{prune,ensure,relink,provided,manifest,fsops (unused parts)}.ts`,
  `src/localized-dedupe.ts`, `src/utils/relinkHooks.ts`; `readInstalledPkgSync`/`isWorkspaceRootSync`
  in `src/installed-packages.ts`
- `src/cli.ts` (options), `src/vite-config.ts` (dedupe = standalone pair only),
  `src/lifecycle.ts` (`localizedPackageNames` → `localMembers`; build-tool closure first; stale
  comments), `src/cli-methods.ts` (`buildAll`, create-package messages),
  `src/utils/createPackageLocation.ts` (`ensureWorkspaceGlob` adds `packages-local/*` for that
  location; relink re-exports go)
- tests: replace `tests/unit/localize/{prune,ensure,one-copy,promises,manifest}.test.ts` with tests
  for the new modules; update `commands`, `adopt`, `localizeCommand`, `real-localize`,
  `viteDedupe`, `buildAllBuildToolFirst`, `buildAllDiscovery`, `createPackageLocation`; keep
  `resolve`, `semver`
- docs: `docs/localize.md` rewritten, `README.md` localize section; changeset (minor);
  `docs/backlog/009-*` consumed at wrapup

**CN** (`wt-cn`)
- `package.json`: workspaces += `packages-local/*`; `postinstall`/`dependencies` → lock-at-rest;
  delete `pretest:unit`, `pretypecheck`, `pretypecheck:gate`; delete the three `$` overrides;
  `@_linked/cli` range → the release carrying `hooks/` (wrapup, after the cli release)
- `package-lock.json`: the one root `workspaces` hunk (and the cli bump at wrapup)
- `.gitignore` (+`.packages-local.parked/`, rewritten comment); `docker-compose.yml` (anonymous
  volume over `/workspace/packages-local` in `setup`, `dev`, `deps`, `backend`)
- `.github/workflows/pr-checks.yml`: a `manifests` job grepping both files; header comment
- delete `tests/integration/localize-lockfile-untouched.spec.ts`
- docs: `CLAUDE.md` + `agents.md`, `readme.md`, `docs/how-to/develop-a-linked-package-locally.md`
  (rewrite), `docs/architecture/03-packages-and-governance.md` (§CN workspace model, §Local
  development; the overrides note), `docs/ARCHITECTURE.md`, `docs/architecture/01-domain-model.md`
  mentions, `scripts/ci-local.sh` comment, `vite.config.ts` comment,
  `docs/runbooks/contabo-staging-vps.md` mentions

### Small examples

```jsonc
// CN package.json after
"workspaces": ["packages/*", "packages-local/*"],
"postinstall":  "node node_modules/@_linked/cli/hooks/lock-at-rest.cjs",
"dependencies": "node node_modules/@_linked/cli/hooks/lock-at-rest.cjs",
```

```yaml
# docker-compose.yml, each service with the repo bind mount
volumes:
  - ${HOST_WORKSPACE:-.}:/workspace
  - node_modules_root:/workspace/node_modules
  - /workspace/packages-local          # empty: Docker uses registry copies
```

```yaml
# pr-checks.yml
manifests:
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
    - run: |
        if grep -nE '"packages-local/[^*]' package.json package-lock.json; then
          echo "::error::a localized checkout leaked into the manifests"; exit 1; fi
```

### Pitfalls

- **Bootstrap.** Nothing on the install path may need `lib/`: `hooks/*.cjs` require only Node
  built-ins. `lock-at-rest` must exit 0 when git is absent, the directory is not a work tree, or
  git refuses (`safe.directory` in Docker).
- **`npm ci` with checkouts present fails** (`EUSAGE`, lock out of sync). Localize never runs
  `npm ci` while members remain; docs say "use `npm install`".
- **The `dependencies` script's output is piped by npm.** The warning must also go to `/dev/tty`
  when it opens.
- **`post-checkout` fires for `git checkout -- package-lock.json`** (lock-at-rest's own restore):
  act only when `$3 == 1`.
- **Discovery double-count.** With the glob, `build-all` and Vite find checkouts through the
  workspace path; `checkLocalPackagesDir` and `discoverWorkspaces` already dedupe by path/name —
  keep a test.
- **`@_linked/server`'s `getLincdPackages`** will include checkouts once they are globbed. That is
  correct (they are workspace members); verify the backend starts in the integration phase.
- **CN cannot merge before the cli release** that ships `hooks/`: CI's `postinstall` would fail on
  a missing file. CN's PR bumps `@_linked/cli` at wrapup.
- **Ordering inside `localize`:** clone → app setup → hooks → `npm install` → build. Build after
  install, because a checkout's dependencies arrive with the root install.

### Architecture compliance

- **cli:** `docs/architecture/vite-runtime-config.md` (no localize content; the Vite dedupe change
  keeps the standalone pair, which that doc does not cover). `docs/localize.md` is the user doc and
  is rewritten. Reports 007/010/011 are historical and not edited.
- **CN:** `docs/architecture/03-packages-and-governance.md` — §"CN workspace model" (`packages/*` is
  tracked members only) and §"Local development: `linked localize`, and why it is outside every
  glob". **Approved change:** `packages-local/*` joins the globs; the guarantee "localizing never
  changes a committed file" becomes "the committed manifests are restored after every install, and
  hooks plus CI refuse a leaked checkout". `01-domain-model.md` mentions of localize symlinks are
  updated. Checked with `npx semantu-agents docs architecture` and a grep for `localize`,
  `packages-local`, `node_modules` and `docker compose`: `07-infrastructure-and-execution.md`
  (local dev topology) mentions compose only for ports and Fuseki, so the Docker volume (D10)
  needs no change there; `12-starter-template-and-cli_draft.md` (CLI consolidation) does not cover
  localize. No other doc covers dependency installation.

### Test strategy

| repo | quick gate (per phase, 1–2 min) | full (review) | source |
|---|---|---|---|
| cli | `npx tsc -p tsconfig-esm.json --noEmit`; `npx jest --config jest.config.cjs tests/unit/localize tests/unit/localizeCommand.test.ts tests/unit/buildAll* tests/unit/viteDedupe.test.ts tests/unit/createPackageLocation.test.ts` | `npm run test:unit` (all, incl. `real-localize`), `npm run build` | `package.json` scripts |
| CN | `node -e` parse of package.json; `docker compose config -q`; manifests grep; `npx vitest run` (~35 s) | integration phase: install, `npx linked build-all`, `npm run typecheck:gate`, `npx vitest run`, `NODE_ENV=production npx linked build-app --env production --allow-dirty`, the git scenarios | `package.json`, CLAUDE.md |

Deferred and why: CN Playwright integration/e2e (needs a backend + Fuseki on the real ports; the
spec touching this area is being deleted); cli `test:e2e` and `test:template` (Docker, minutes,
create-app does not change). Both worktrees need their own `npm ci` first (cli) / the integration
setup (CN).

## Phases

Paths: `CLI` = the cli worktree (`.../scratchpad/wt-cli`), `CN` = the CN worktree
(`.../scratchpad/wt-cn`). Neither is the developer's live checkout; never run anything in
`/Users/rene/web/create_now` or its `packages-local/`. One commit per phase, code and this plan
together, no `Claude` in messages.

### Dependency graph

```
P0 (CLI install) ─► P1 (contracts, hooks/*.cjs) ─┬─► P2 (Vite dedupe + build-all order)
                                                  └─► P3 (commands rewrite + removals) ─► P4 (cli docs, changeset)
P4 ─► P5 (CN changes) ─► P6 (integration: CN + cli checkout)
```

P2 and P3 touch disjoint files except `src/localize/provided.ts` (P2 stops importing it, P3 deletes
it) and could run in parallel; they run in sequence here because they share one worktree. P5 needs
P1's hook path and P3's command surface fixed, not their code. P6 is the integration phase.

### P0 — CLI dependencies

- `cd CLI && npm ci` (its own lockfile; standalone repo).
- **Validation:** `npx tsc -p tsconfig-esm.json --noEmit` exits 0 and
  `npx jest --config jest.config.cjs tests/unit/localize/resolve.test.ts` passes on the untouched
  tree (baseline). Record the quick-gate runtime. No commit.

**Result:** npm ci OK; tsc clean (2.5 s); baseline quick-gate set 16 suites / 209 tests passed in ~12 s.

### P1 — Contracts and the dependency-free hooks (CLI)

Tasks:
1. `src/localize/semver.ts`: move `satisfies` out of `prune.ts` unchanged; `prune.ts` re-imports
   it (deleted in P3).
2. `src/localize/members.ts`: `LOCAL_DIR`, `PARKED_DIR`, `Member`, `localMembers`,
   `parkedMembers` (contracts above). A directory counts when it has a readable `package.json`
   with a `name`; sorted by name.
3. `src/localize/drift.ts`: `SINGLETONS`, `Drift`, `driftProblems`, `describeDrift`. Port
   `docs/backlog/009-assets/check-local.cjs`: read `node_modules/.package-lock.json` `packages`;
   members from `localMembers`; importers = `.`, `packages/*`, `packages-local/*` with live
   manifests; `missing-dir` for a lock entry `packages-local/<x>` without a directory. No hidden
   lockfile → `[]` (nothing installed yet is not drift).
4. `src/localize/app-setup.ts`: `ensureAppSetup`, `conflictingOverrides`. Preserve the
   `package.json` indentation and key order; replace a script that is exactly
   `linked localize --relink`, append with `&&` to any other existing script, leave one that
   already runs the hook. `.gitignore`: append missing lines under a `# linked localize` comment.
5. `src/localize/git-hooks.ts`: `HOOK_MARKER`, `installGitHooks`. Hooks dir from
   `git rev-parse --git-path hooks` (works in worktrees); write `post-merge`, `post-checkout`,
   `pre-commit` (mode 0755) as `#!/bin/sh\n<marker>\nexec node "<app>/node_modules/@_linked/cli/hooks/git-hook.cjs" <hook> "$@"`
   — the path resolved relative to `git rev-parse --show-toplevel` at run time, not baked in.
   Existing file with the marker → rewrite; without → skip and report.
6. `hooks/lock-at-rest.cjs` and `hooks/git-hook.cjs` from the prototypes in
   `docs/backlog/009-assets/` with the contract changes above; CommonJS, Node built-ins only.
   `package.json` `files` += `"hooks"`.
7. Export the new modules from `src/localize/index.ts`.

Tests (jest, `tests/unit/localize/`, temp dirs via the existing helpers):
- `members.test.ts`: dirs with/without `package.json`; parked dir; sorted; missing `packages-local/` → `[]`.
- `drift.test.ts` with hand-written hidden lockfiles: clean → `[]`; nested
  `packages-local/b/node_modules/@x/a` where `@x/a` is a member → `second-copy`; nested
  `node_modules/foo/node_modules/@_linked/core` (not a member) → `singleton-copy`; root range
  `^2.28.4` vs member 2.28.3 → `range-miss` with `importer: '<root>'`; lock entry without dir →
  `missing-dir`; no hidden lockfile → `[]`.
- `app-setup.test.ts`: adds the glob once (idempotent: second call returns `[]`); replaces
  `linked localize --relink`; appends to `"postinstall": "foo"` as `foo && node …`; gitignore lines
  added once; `conflictingOverrides` finds `@_linked/core` in `{"@_linked/core": "$@_linked/core"}`
  and in a nested scoped override; keeps 2-space indentation and a trailing newline.
- `git-hooks.test.ts` (real `git init` in a temp dir): writes three executable hooks with the
  marker; a foreign `pre-commit` is skipped and reported; second run rewrites ours.
- `hooks.test.ts` (spawns `node hooks/*.cjs` in a temp git repo):
  `lock-at-rest`: no members → exit 0 nothing changed; members + dirty lockfile + clean
  `package.json` → lockfile restored (`git status --porcelain` empty); `package.json` changed →
  lockfile left dirty, stderr contains `delocalize`; not a git repo → exit 0.
  `git-hook pre-commit`: staged lockfile with `"packages-local/a"` → exit 1; with only
  `"packages-local/*"` → exit 0. `post-checkout` with `$3=0` → does nothing (no npm spawned: run
  with `PATH` lacking npm and assert exit 0 and no error output).

**Validation — quick gate:** `npx tsc -p tsconfig-esm.json --noEmit` exits 0; the new test files
plus `tests/unit/localize` all pass; `node -e "require('./hooks/lock-at-rest.cjs')"` is not run
(side effects) — instead `node --check hooks/*.cjs` exits 0. `grep -E "require\\(['\"][^.]" hooks/*.cjs`
lists only Node built-ins.

**Result:** Done as listed: `semver.ts` (`prune.ts` and `index.ts` re-export from it), `members.ts`,
`drift.ts`, `app-setup.ts`, `git-hooks.ts`, `hooks/{lock-at-rest,git-hook}.cjs`, `files` += `hooks`,
exports in `index.ts`; tests `members` (3), `drift` (7), `app-setup` (8), `git-hooks` (5), `hooks`
(11). Deviations, each smaller than the contract or a safety the contract left open:
`satisfies` keeps its `boolean | null` (moved unchanged; drift counts only `false` as a miss, so a
tag or `workspace:` range is never drift). `lock-at-rest` decides on `git diff HEAD` rather than
`git status` (an untracked lockfile is not restored) and restores with `git checkout HEAD --` (a
staged leak goes too); the drift check's output is captured and written to stderr and `/dev/tty`
like the warnings. The installed hook exits 0 when `git-hook.cjs` or `node` is missing, so a clone
without the cli installed is never blocked. `git-hook.cjs` drops `GIT_DIR`/`GIT_INDEX_FILE`/… from
the environment of `npm install`, so a checkout's lifecycle scripts never run git against the app's
repository. `ensureAppSetup` also replaces a `[npx] linked localize --relink` step inside an `&&`
chain, creates `workspaces` when absent, and refuses (exit 6) a missing or unparsable
`package.json` or an unknown `workspaces` shape. `second-copy` also covers a top-level registry
copy of a member. `conflictingOverrides` reports nested keys as `a > b`; `installGitHooks` returns
absolute paths and does nothing outside a work tree. Validation: `tsc -p tsconfig-esm.json --noEmit`
exit 0 (2.0 s); `jest tests/unit/localize` 16 suites / 192 tests passed in 5.4 s; the full quick-gate
set 21 suites / 243 tests in 5.9 s; `node --check` exit 0 for both hooks; the `require` grep lists
only `child_process`, `fs`, `path`.

### P2 — Vite dedupe and build-all order (CLI)

Tasks:
1. `src/vite-config.ts`: `resolve.dedupe` = the standalone pair only; remove the
   `localizedDedupe` import, re-export and `describeSkipped` warning. Delete `src/localized-dedupe.ts`.
   Remove `readInstalledPkgSync`/`isWorkspaceRootSync` from `src/installed-packages.ts` if nothing
   else uses them (`provided.ts` stays until P3 — keep them until P3 if it still imports them).
2. `src/lifecycle.ts`: `localizedPackageNames()` → names from `localMembers(appRoot)`; refresh the
   `LOCAL_PACKAGES_DIR` / discovery comments (the directory is now a glob).
3. Build order: `orderBuildToolFirst` returns `{pre, tool, rest}` where `pre` is the tool's
   transitive in-plan `dependencies` closure in dependency order; `buildAll` builds `pre`
   (dependency order), then the tool alone, then `rest`. `--from` resumes across the three groups
   in that order.
4. Tests: `viteDedupe.test.ts` keeps only the standalone cases; `buildAllBuildToolFirst.test.ts`:
   plan with cli → core: `pre = [core]`, tool = cli, `rest` excludes core; plan without core in it
   → `pre = []`; `--from` inside `pre`, at the tool, inside `rest`. `buildAllDiscovery.test.ts`:
   a `packages-local/*` glob plus a checkout is discovered once (source `workspace`).

**Validation — quick gate:** tsc exits 0; `npx jest --config jest.config.cjs tests/unit/viteDedupe.test.ts tests/unit/buildAll tests/unit/discoverWorkspaces tests/unit/localize`
passes.

**Result:** `resolve.dedupe` is `['@_linked/server-utils', '@_linked/react']` standalone and `[]`
otherwise (React is no longer listed: npm dedupes members like any workspace); `localized-dedupe.ts`,
its re-export and the skipped-range warning are gone, as is the SSR loader fixture only its test
used. `provided.ts` stays until P3 (prune and the localize index still import it), so
`readInstalledPkgSync`/`isWorkspaceRootSync` stay too; its header no longer names Vite.
`localizedPackageNames` keeps its name and now returns `localMembers(appRoot)` names, so every
checkout in `packages-local/` counts as localized (a leftover `local-packages.json` is ignored).
`orderBuildToolFirst(packages, from?, dependenciesOf?)` returns `{pre, tool, rest, start, from}`:
`start` (`'pre' | 'tool' | 'rest'`) replaces `buildToolFirst`, `from` applies inside `start`, a name
in no group goes to `rest` (which reports it, as before); the closure is depth-first over
`dependencies` and cuts a cycle back to the cli. `buildAll` is now `async` and builds `pre`, then
the cli alone ("Building @_linked/cli alone: …", was "first"), then `rest`; `buildInDependencyOrder`
resolves to whether all were built and, for a group with more to follow, prints the summary only
on failure, followed by a stop note naming the cli. Comments that said `packages-local/` is in no
glob now say "in an app not set up yet" (`lifecycle.ts`, `vite-config.ts`, two discovery tests).
Deviations: `ensure.test.ts` lost its parity test against `localizedDedupe` (the module it compared
is gone; the file goes in P3); `buildAllDiscovery`'s "dependency tree" skip moved to a new
workspace member `@w/unrelated`, since an undeclared checkout is now built; a glob-plus-checkout case
was also added to `discoverWorkspaces.localized.test.ts` (Vite's discovery). Validation: `tsc -p
tsconfig-esm.json --noEmit` exit 0; quick gate (incl. `localizeCommand`, `createPackageLocation`)
24 suites / 254 tests passed in ~9–18 s; full `npm run test:unit` 66 suites / 752 tests passed in
12.2 s.

### P3 — Commands rewrite and removals (CLI)

Tasks:
1. Rewrite `src/localize/localize.ts` (`localize(names, opts, deps)`) per the command table:
   app setup + `conflictingOverrides` (exit 6, message names the key) → for each name: parked →
   move back; else existing dir → refuse with an `--adopt` hint; else resolve + clone (`--repo`,
   `--subdir` as today) → `installGitHooks` → one `npm install --no-audit --no-fund` at the app
   root (exit 7 on failure, nothing else attempted) → build each new checkout (`--build`; for
   `@_linked/cli` its own `npm run build`) — a failing build warns (exit 5).
2. `adopt.ts`: same pipeline without clone; `--parked`: every parked member.
3. `delocalize.ts` per D7, incl. `--purge` guard (uncommitted or unpushed work refuses unless
   `--force`).
4. `list.ts`: rows for members (name, dir, branch, version) and parked; drift lines from
   `driftProblems`; `--check` exits 1 on drift; an old `local-packages.json` → one migration hint.
5. `src/commands/localize.ts` and `src/cli.ts`: options per the table; `--relink` → exit 0 silent;
   `--ensure` → one stderr hint, exit 0; remove `--reinstall`, `--no-prune`, `--dir` stays.
6. `one-copy-hook.ts` → `drift-hook.ts`: before `start`/`script`/`call`/`build-all`, print
   `describeDrift` lines on stderr; never throw.
7. `createPackageLocation.ts` / `cli-methods.ts` create-package: `--location packages-local`
   calls `ensureAppSetup` + adopt; `ensureWorkspaceGlob` adds `packages-local/*` for that location;
   messages drop `local-packages.json`.
8. Delete `prune.ts`, `ensure.ts`, `relink.ts`, `provided.ts`, `manifest.ts`, `utils/relinkHooks.ts`,
   unused `fsops.ts` parts, and their tests (`prune`, `ensure`, `one-copy`, `promises`,
   `manifest`); update `commands`, `adopt`, `localizeCommand`, `createPackageLocation`,
   `createPackageScaffold`, `real-localize` tests to the new behaviour.
9. `errors.ts`: drop codes 3 and 8.

Tests (named cases, fake `run` via `Deps`):
- `localize clones, sets up, installs once at the root, then builds` — assert call order
  `git clone`, `npm install` (cwd = app root), `linked build` (cwd = checkout).
- `localize refuses a conflicting override` — `overrides: {"@_linked/core": "$@_linked/core"}` →
  exit 6, nothing cloned.
- `localize takes a parked checkout back` — dir moves from `.packages-local.parked/` to
  `packages-local/`, no clone.
- `localize builds the cli with npm run build`.
- `delocalize the last checkout runs npm ci`; `delocalize one of two runs npm install then npm rebuild <name>`;
  `delocalize --purge refuses on unpushed commits`.
- `--list` shows members, parked and a `range-miss` line; `--list --check` exits 1 then.
- `--relink` exits 0 with no output; `--ensure` exits 0 with one hint line.
- `drift hook prints on stderr and never throws` (drift present; command still runs).
- `real-localize.test.ts` (slow): clone a fixture repo into an app with the glob, real
  `npm install`, assert `node_modules/<name>` is a symlink into `packages-local/` and
  `git status --porcelain` of the fixture app is empty after the hook.

**Validation — quick gate:** tsc exits 0; `npx jest --config jest.config.cjs tests/unit/localize tests/unit/localizeCommand.test.ts tests/unit/createPackage`
passes; `grep -rn "local-packages\|providedPackages\|pruneProvided\|relinkHooks" src` returns
only the migration hint.

**Result:** Done as listed. `localize.ts` is one run shared by `localize`, `adopt` and `--parked`
(`runLocalize(names, opts, deps, prepare)`): override check (exit 6, keys named, nothing changed)
→ `ensureAppSetup`, reported as "set up this app for checkouts (commit these):" plus one line per
change → per name (parked → moved back; an existing directory or a member of that name → exit 6
with the `--adopt` hint; else resolve + clone) → `installGitHooks` (a foreign hook is warned about)
→ one `npm install --no-audit --no-fund` at the root (exit 7) → builds (`--build`, else `linked
build`, else `npm run build` for `@_linked/cli`; a failure is exit 5) → one line per checkout
(`<name> -> <dir> (branch <b>)`) and any drift as warnings. `delocalize` parks (`npm ci` when none
remain, else `npm install` + `npm rebuild <names>`), `--purge` checks uncommitted work and unpushed
commits (`@{u}..HEAD`, or `--branches --not --remotes` without an upstream). `--list` prints
`name dir branch version [(parked)]`, `drift: …` lines and `N localized · N parked · N drift`;
`--list --check` prints only the drift lines (stderr) and exits 1 on any, so the lock-at-rest hook
stays quiet on a clean install. `--relink` exits 0 silently, `--ensure` prints one stderr line and
exits 0. `drift-hook.ts` (`installDriftHook`, `reportDrift`, `DRIFT_COMMANDS`) replaces the
one-copy hook. create-package `--location packages-local` runs `ensureAppSetup` (also with
`--skip-install`) and adopt; `ensureWorkspaceGlob(pkg, location)` takes the location. Deleted
`prune`, `ensure`, `relink`, `provided`, `manifest`, `utils/relinkHooks` and their tests,
`readInstalledPkgSync`/`isWorkspaceRootSync`, and the link/snapshot parts of `fsops`; `errors.ts`
drops 3 and 8 and adds `EXIT_DRIFT` (1) and `EXIT_USAGE` (2); `LOCAL_PACKAGES_DIR` aliases
`LOCAL_DIR`. `src/localize` is 1727 lines, was 3721. Also fixed a P2 regression: `resolve.dedupe`
is again `react`/`react-dom` in every mode when the app has them installed (main's rule), after
the standalone pair (`dedupeFor`). Deviations: **`--subdir`** clones the repository whole into
`packages-local/.repos/<checkout>` (a dot directory the glob skips) and makes
`packages-local/<checkout>` a relative link to the package; npm 11/12 links a symlinked member
(measured, and in `real-localize`), parking rewrites the link, `--purge` removes the clone when no
other checkout links into it. A clone whose `package.json` is not the package is removed again
(it would otherwise become a member). **`--dir`** is kept but accepts only `packages-local` (exit 2
otherwise): the glob, the hooks and drift all name it. **`--force` on `localize`** is removed (it
guarded hand-written links); it stays on `delocalize --purge`. **`--adopt --repo`** is refused
(exit 2): there is no record to write it to. A member already present under that name refuses
rather than re-running the install. The lifecycle discovery source value `'local-packages-dir'`
is kept (public `LocalPackage['source']` type), so the validation grep also lists it.
Validation: `tsc -p tsconfig-esm.json --noEmit` exit 0; the quick gate (`tests/unit/localize`,
`localizeCommand`, `createPackage*`, `viteDedupe`, `buildAll*`) 18 suites / 196 tests passed in
7.8 s; `npm run test:unit` 62 suites / 689 tests passed in 9.8 s; `npm run build` exit 0 and
`node lib/esm/launch.js localize --help` lists `--parked`, no `--reinstall`/`--no-prune`/`--force`.
Note for P4/P6: committing the first setup — `package.json` then differs from HEAD, so lock-at-rest
leaves a lockfile that lists the checkout; the setup commit needs the lockfile from an install with
no checkout present (P5 does this for CN).

### P4 — CLI docs and changeset

Tasks: rewrite `docs/localize.md` (problem, how it works, set-up, commands, drift, parking,
Docker/CI notes, what it never does, exit codes); update `README.md` localize section and
create-package `--location` text; add a changeset (`minor`) summarising the new model and the
deprecated flags.
**Validation:** `grep -n "prune\|relink\|local-packages\|--ensure" docs/localize.md README.md`
mentions only the deprecation notes; every command and flag in `src/cli.ts`'s localize/delocalize
options appears in `docs/localize.md`; `npx changeset status` lists `@_linked/cli` minor.

**Result:** `docs/localize.md` rewritten (problem, how it works, set-up, commands, monorepos,
building incl. the cli/core bootstrap, drift with a fix per kind, changing dependencies while
localized, pulls and branch switches, `npm ci` with checkouts, Docker/CI with the leak grep, a
checkout's own lockfile, migration, what it never does, exit codes, programmatic use — `index.ts`
still exports `localize`/`adopt`/`localizeParked`/`delocalize`/`list`/`defaultDeps`/drift). README's
localize section and create-package `packages-local` bullet updated; the `-ont` E404 text (:48) is
unchanged because create-package still leaves that entry out. Changeset
`.changeset/localize-on-npm-workspaces.md` (`minor`). The set-up commit sequence was measured in a
scratch app against this build: `localize --repo` (set-up printed, lockfile left listing
`packages-local/x-dep`) → `delocalize` (`npm ci` exits 0 but does not rewrite the lockfile) →
`npm install` (diff: root `workspaces` += `"packages-local/*"` and `hasInstallScript: true`) →
commit → `localize --parked` → `git status` clean; a `range-miss` showed in `--list` and
`--list --check` exited 1. Deviations: the bootstrap recipe for two unbuilt checkouts uses core's
`npm run compile` (plain `tsc`) and was not run; the doc prefers localizing core first in its own
command. Found, not changed (code, not docs): a refused `--purge` exits 5 (`delocalize` returns
`EXIT_WARNED`) while `errors.ts` lists "unpushed work" under 6 — the doc states 5; `cli.ts`'s
create-package `--location` help (~:160) still says "linked and recorded by `linked localize`".
Validation: the grep lists only deprecation/migration lines (README:296; localize.md:93, 141,
142, 324–336, 356); all 12 options from `localize --help`/`delocalize --help` appear in
`docs/localize.md`; `npx changeset status` lists `@_linked/cli` at minor.

### P5 — CN changes

Tasks (in `CN`): everything under "Files expected to change → CN" except the `@_linked/cli` range
bump (wrapup, after the cli release). The lockfile change is produced by `npm install` in a
checkout with no `packages-local/` and must be exactly the root `workspaces` hunk.
**Validation — quick gate:**
- `git diff origin/main -- package-lock.json` shows only the `workspaces` hunk.
- `grep -nE '"packages-local/[^*]' package.json package-lock.json` finds nothing.
- `docker compose config -q` exits 0; the four services list the `/workspace/packages-local` volume.
- `grep -rn "localize --relink\|localize --ensure\|local-packages.json" CLAUDE.md agents.md readme.md docs/how-to docs/architecture scripts .github package.json`
  finds only historical notes explicitly marked as such.
- `npx vitest run` passes (after P6's install; recorded there if not runnable before).

**Result:** One CN commit (`1c8c7ccc`, after rebasing onto origin/main `45fa522f` — the worktree
was one merge behind, #84). `package.json`: `workspaces` += `"packages-local/*"`;
`postinstall`/`dependencies` run the lock-at-rest hook; `pretest:unit`, `pretypecheck`,
`pretypecheck:gate` and the three `$@_linked/*` overrides deleted; `@_linked/cli` stays `^1.46.1`
(bumped at wrapup). The lockfile was produced with `npm install --ignore-scripts` and no
`packages-local/` (the registry cli 1.46.1 has no `hooks/`, so the new postinstall cannot run yet);
its diff against origin/main is exactly the root `workspaces` hunk (+2/−1) — removing the overrides
changed nothing. `.gitignore` += `.packages-local.parked/`; `docker-compose.yml` mounts an
anonymous `/workspace/packages-local` in `setup`, `dev`, `deps`, `backend`; `pr-checks.yml` gains a
`manifests` job (grep `'"packages-local/([^*]|\*[^"])'`, the same rule as `git-hook.cjs`);
`localize-lockfile-untouched.spec.ts` deleted. Docs: `agents.md` (CLAUDE.md is a symlink to it),
`readme.md`, the how-to rewritten (680 → ~230 lines), arch-03's two sections rewritten as the
approved change plus an overrides note, `docs/ARCHITECTURE.md`, arch-01, `ci-local.sh`,
`vite.config.ts`, the runbook, `create-now.code-workspace`. Validation: package.json parses; the
leak grep is empty on the repo and matches a leak sample but not the glob; `docker compose
--profile setup config -q` exits 0 with four volume targets; `pr-checks.yml` parses; the stale
reference grep finds only migration/history notes. **Until the cli release ships `hooks/`, CN's CI
install fails** — the wrapup bump is a hard dependency. Deferred to P6: vitest, the how-to's
migration steps, and the quoted `npm ci` / lock-at-rest output.

### P6 — Integration (CN + cli checkout)

Setup: `CN/packages-local/` = clones of core, auth, shape-ui (from the developer's checkouts,
read-only `git clone`, `main`) and of `CLI` at this branch (so CN runs the new cli as a checkout).
Bootstrap the cli/core pair with the documented recipe if needed and record it.
Scenarios (quote output):
1. `npm install`: links all four, lockfile restored, `git status` clean; drift report clean.
2. `npx linked localize --list` and `--list --check` (exit 0).
3. `npx linked build-all` builds core before cli; `npm run typecheck:gate`; `npx vitest run`;
   `NODE_ENV=production npx linked build-app --env production --allow-dirty` with core only from
   the checkout; the backend starts on a non-default port and logs no `getLincdPackages` error
   (PID-scoped start/stop; never ports 4040/3030).
4. Git: a commit on a side branch bumping an in-range dependency, then merge it → hooks run
   `npm install`, clean status; branch switch and back → clean; staging a lockfile with a
   checkout entry → pre-commit refuses.
5. `npx linked delocalize @_linked/shape-ui` → parked, `npm install` + `npm rebuild`, `linked` bin
   executable; `npx linked localize --parked` → back, clean.
6. Drift: shape-ui requiring a core version above the checkout → `--list --check` exits 1 with a
   `range-miss`/`second-copy` line.
7. A conflicting override added locally → `linked localize` exits 6 with the key named.
**Validation:** every scenario passes as stated, or the failure is recorded here with its output
and fixed in this phase. Commit the CN worktree's phase result separately from the CLI plan update.

### Deferred to review

cli `npm run test:unit` (full, including `real-localize`) and `npm run build`; CN Playwright
suites (need the real ports); the one-week trial with all checkouts and both developers.
