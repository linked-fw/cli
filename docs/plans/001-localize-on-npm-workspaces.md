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
is a change: the old postinstall `--relink` ran inside the container and re-created links into the
bind-mounted checkouts. Localizing and editing happen on the host only.

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

**Result:** Run in a standalone clone `scratchpad/p6-cn` of the CN branch (not the `wt-cn`
worktree: in a worktree `git rev-parse --git-path hooks` is the main repository's
`.git/hooks` — measured `/Users/rene/web/create_now/.git/hooks` — so localizing there would have
written hooks into the developer's live checkout; documented, not changed). `packages-local/` =
clones of the developer's core (`main` 08bf1df, 2.28.4; the live checkout was on a feature branch),
auth (`main` 1aaa261, 3.4.0), shape-ui (`main` c53b297, 2.7.0) and this branch (1.46.2). `.env` from
`.env.example` with `PORT=4343`, Fuseki on the dead port 3997. Node 22.23.3, npm 12.2.0.

Bootstrap: the real flow, `node wt-cli/lib/esm/launch.js localize <4 names> --adopt` (PATH with the
app's `.bin`, as npx gives) in a clone with no `node_modules`: install fine (37 s, lockfile restored),
then every build failed — `/bin/sh: linked: command not found` for core/auth/shape-ui and the cli's
`tsc` without core's `lib/`. The recipe in `docs/localize.md` (`npm run compile` in core, 2 s;
`npm run build` in the cli, 3 s) worked, but **`node_modules/.bin/linked` did not exist**: npm skips a
bin whose file is missing at install time, and `npx --no-install linked` then fails ("could not
determine executable") while plain `npx linked` resolves to the unrelated registry package `linked`
("tiny middleware framework"). `npm rebuild @_linked/cli --ignore-scripts` (1.1 s) links it. Fixed
(below); after the fix, re-adopting cli + shape-ui with the cli's `lib/` removed: exit 0 in 21 s, the
cli built first, its bin linked, shape-ui built with it.

| # | scenario | result |
|---|---|---|
| 1 | install | PASS. All four `node_modules/@_linked/{core,auth,shape-ui,cli} -> ../../packages-local/…`; `npm install` 9–13 s; `git status --porcelain` empty; with `--foreground-scripts`: `[lock-at-rest] restored the committed package-lock.json (packages-local/{_linked-auth,_linked-cli,_linked-core,_linked-shape-ui} stay linked in node_modules)` (npm 12 hides it otherwise, and there was no tty); hooks written to `p6-cn/.git/hooks` with the marker |
| 2 | `--list`, `--list --check` | PASS. `4 localized · no drift`, exit 0; `--check` exit 0 with no output |
| 3 | build-all, typecheck, vitest, build-app, backend | PASS. build-all 24 s: `Building @_linked/core first: @_linked/cli depends on it.` → `Building @_linked/cli alone` → the other 6. `typecheck:gate` 20 s: `No new type errors`. vitest 1873 passed / 5 skipped (40 s) — with the `.env` copied from `.env.example` 2 fail (`DOCUMENT_EXTRACTION_PROVIDER=openai` there; unrelated). `NODE_ENV=production … build-app --allow-dirty` 23 s, exit 0; 66 core sources in the sourcemaps, all `packages-local/_linked-core`, none from `node_modules`. Backend (PID-scoped, port 4343): `Up and running`, `GET /` 200, no `getLincdPackages` error. Its `@_linked/auth SESSION_COOKIE_NAME constructor failed: providerClass is not a constructor` and `Could not sort lincd packages, circular dependencies?` appear identically in a registry-only baseline clone (port 4344): pre-existing |
| 4 | git hooks | PASS after a fix. Fast-forward pull of a side-branch `npm update @_linked/server` (2.24.8 → 2.24.9, made in a clone without checkouts): `[git hook] dependency manifests changed (1c8c7cccc..e29daed0e): npm install` … `done in 20s`, links intact, server 2.24.9, status clean. Switch to a branch with the old lockfile and back: 13 s / 11 s, both clean, server version followed. **pre-commit let a leaked lockfile through** (committed); fixed, then: `pre-commit: refusing package-lock.json: it references packages-local/ …`, exit 1 |
| 5 | delocalize / `--parked` | PASS. `delocalize @_linked/shape-ui` 21 s: parked to `.packages-local.parked/`, registry 2.7.0 installed, `.bin/linked` executable and runs, `3 localized · 1 parked · no drift`. `localize --parked` 13 s: link back, `--check` 0, clean |
| 6 | drift | PASS. shape-ui's core range `^2.29.0`: `--check` exit 1, `drift: @_linked/core@2.28.4 (packages-local/_linked-core) does not satisfy dependencies "^2.29.0" of packages-local/_linked-shape-ui`; `npm install` then fails `ETARGET`. Range `2.28.3`: install nests a registry copy, `second copy of localized @_linked/core@2.28.3 at packages-local/_linked-shape-ui/node_modules/@_linked/core` + the range miss, exit 1. Recovery: revert the range, `npm install` — it removes the nested copy itself (no `rm -rf` needed), `--check` 0. A root range missing the checkout (`2.28.3`, `^2.29.0`) keeps the link, as documented |
| 7 | conflicting override | PASS after a fix. Before: `localize @_linked/dcmi` with `"@_linked/core": "$@_linked/core"` cloned dcmi, then `EOVERRIDE`, exit 7. After: `package.json "overrides" names a localized package: "@_linked/core".`, exit 6, nothing cloned |
| 8 | `npm ci` with checkouts | PASS. 2 s, `EUSAGE` `npm ci can only install packages when your package.json and package-lock.json are in sync`, then `Missing: @_linked/auth@3.4.0 from lock file` etc.; never names `packages-local`; `node_modules` untouched |
| 9 | how-to migration | PASS with an added step. Old setup made with registry cli 1.46.1 on `main` (`localize --repo` of shape-ui and the cli: per-checkout `node_modules`, `local-packages.json`, hand links), then the branch merged. As written, step 5 would run the old cli's `--adopt` (nothing reinstalled since the pull). With `npm install` first (9 s, lock-at-rest restored, clean) and, for the localized cli, build + `npm rebuild @_linked/cli --ignore-scripts`, adopt exit 0 in 20 s, hooks written, `2 localized · no drift`, clean. Building the cli checkout *before* deleting its pruned `node_modules` fails (`minimatch` has no export `minimatch`) and leaves it without `lib/` |

Fixes — cli: `1022584` fix(localize): build the cli first and link its bin after the build (+2 tests,
`docs/localize.md` recipe gains the rebuild line); `26b4baf` fix(localize): pre-commit reads lockfiles
over a megabyte (`execFileSync`'s 1 MB default threw ENOBUFS on CN's 1.05 MB lockfile, which the hook
took for a staged deletion; +1 test, fails before the fix); `d319375` fix(localize): refuse an override
on a checkout already localized (+1 test); `ee15e29` docs(localize): how npm treats a missed range
(the drift table said npm links whatever the range — true only for the app's own ranges; the nested
copy goes away on the next install) and hooks in a worktree. CN: `a1c5dac3` docs: the how-to's
migration gains "npm install first" and the localized-cli steps, the drift intro and the worktree
note are corrected. `npm run test:unit` 62 suites / 693 tests, `npm run build` exit 0.

Open findings: (a) git hooks in a `git worktree` land in the common hooks directory, shared by every
worktree (documented only; a per-worktree `core.hooksPath` needs `extensions.worktreeConfig`).
(b) The drift lines print twice per install that changes dependencies: lock-at-rest runs from both
`postinstall` and `dependencies`. (c) A localize run started as `node …/launch.js` without the app's
`.bin` on PATH cannot find `linked` for the builds; `npx linked` is fine. (d) `delocalize` does not
log its `npm rebuild` (only a failure). (e) CN's `.env.example` sets
`DOCUMENT_EXTRACTION_PROVIDER=openai`, which fails two vitest cases when copied as `.env`. (f) Two
fresh unbuilt checkouts of cli and core still need the manual recipe; the one in `docs/localize.md`
now includes the bin rebuild and was run as written.

### Deferred to review

cli `npm run test:unit` (full, including `real-localize`) and `npm run build`; CN Playwright
suites (need the real ports); the one-week trial with all checkouts and both developers.

## Review

Three parallel reviews (cli code, CN + architecture, suites + coverage). All suites pass: tsc,
cli unit 62 suites / 693 tests (incl. `real-localize`), `npm run build`, `test:template` 22 tests;
a mutation pass inverted nine critical behaviours and every one was caught. `test:e2e` skipped as
irrelevant (create-app unchanged; it runs the registry cli). Architecture: no violations; arch-03
records the approved change, arch-01/07/10 checked.

Findings (M = medium, selected for iteration 1; stale comments/docs included regardless):

1. M — D4 broken by `core.hooksPath` (husky: hooks skipped; tracked hooks dir: files written into
   the work tree) and by worktrees (hooks land in the common dir and run in every worktree).
2. M — the removed `$` overrides also guaranteed single copies outside localize; CI no longer
   checks it.
3. M — an app below the git top level gets hooks that silently do nothing.
4. M — `packages/*` is hard-coded in the hooks and the drift importers; a dependency change in
   another workspace folder has its lockfile change discarded.
5. M — `linked localize` run inside a workspace member sets up that member's `package.json`.
6. M — the postinstall hook hard-fails where `@_linked/cli` is not installed (`--omit=dev`).
7. M — lock-at-rest always restores from HEAD, discarding a staged lockfile change or an
   `npm update`/`dedupe` made while localized, silently.
8. M — the first set-up needs four manual steps.
9. M — fail-open guards: `delocalize --purge` deletes when git errors; pre-commit treats any
   `git show` error as a staged deletion.
10. M — every install spawns the full cli about twice for the drift report (~2 s).
11. M (stale) — `cli.ts` create-package help, `--purge` exit code vs `errors.ts`, the
    `git-hooks.ts` comment, the weaker CI grep in `docs/localize.md`.
12. M (docs) — arch-03 says npm never checks the range (true only for the app's own ranges);
    `docs/releasing-linked-packages.md` cites `resolutions` as the single-copy guard.
13. M (docs) — the dev container now sees an empty `packages-local/`; D10's "today's behaviour"
    is inaccurate (the old postinstall relinked inside the container); Linux creates the
    mountpoint as root.
14. M — `ci-local.sh --install` gives a misleading message when checkouts are present.
15. stale — `agents.md` worktree bullet; backlog 105/097/076 localize mentions; arch-03's Node 20
    line; `create-now.code-workspace` comment.
16. M — deep imports removed through the `@_linked/cli/*` wildcard are not listed in the changeset.

Low, left for the pause: Windows (`npm.cmd` spawn, junctions, CRLF), `--subdir` without `--repo`,
double `[localize]` prefix, `buildAll` without `return`, `git clone --`, `"packages-local/**"` in the
leak regex, unparking a name that is already a member, `delocalize` running `npm ci` without a
lockfile, export trimming and renames, comment widths, prettier at wrapup, the leak fixture
containing the glob, no real-npm test of the cli bin relink.

## Iteration 1 — Ideation

### Finding 1 of 16: hooks with `core.hooksPath` and in worktrees
Options: (a) write into whatever `--git-path hooks` returns (today); (b) when `core.hooksPath` is
set, write nothing and print the one-line call for each hook; (c) per-worktree config. **Chosen
(b)** plus a guard in `git-hook.cjs`: post-merge/post-checkout do nothing unless the current work
tree has checkouts. That makes the shared worktree hooks harmless without per-worktree config, and
never writes into a directory another tool manages or git tracks.

### Finding 2 of 16: single copies in CI
**Chosen:** a CI step after `npm ci` in CN's typecheck job: `npx linked localize --list --check`,
which reports `singleton-copy` with no checkouts present. Rejected: restoring the overrides (they
break localizing those packages).

### Finding 3 of 16: app below the git top level
**Chosen:** the hook shim `cd`s to the app directory recorded at install time
(`git rev-parse --show-prefix`), and `git-hook.cjs` uses paths relative to it
(`--relative`, cwd-relative pathspecs).

### Finding 4 of 16: hard-coded `packages/*`
**Chosen:** derive manifest pathspecs from the app's `workspaces` globs (minus `packages-local/*`),
in one helper shared by both hooks and drift.

### Finding 5 of 16: the app root
**Chosen:** resolve the app root as the topmost ancestor whose `package.json` has `workspaces`
(the rule `build-all` already uses), falling back to the current directory for an app that has no
`workspaces` yet. One exported helper.

### Finding 6 of 16: postinstall without the cli
**Chosen:** the scripts guard the call:
`node -e "const p='node_modules/@_linked/cli/hooks/lock-at-rest.cjs';require('fs').existsSync(p)&&require(require('path').resolve(p))"`.
App set-up recognises and upgrades the earlier unguarded form. Rejected: requiring the cli as a
production dependency (a rule every app must remember).

### Finding 7 of 16: what lock-at-rest restores
**Chosen:** restore from the index when the staged lockfile has no checkout entry, else from HEAD;
when the restored copy differs from what npm wrote beyond checkout entries is undetectable cheaply,
so the message always says "changes to dependencies need `linked delocalize` first".

### Finding 8 of 16: first set-up in one step
**Chosen:** when app set-up changes `package.json`, run
`npm install --package-lock-only --ignore-scripts --no-audit --no-fund` before anything is cloned,
keep that lockfile, and write it back after the main install. The work tree then shows exactly the
set-up diff to commit. If that install fails, fall back to today's message with the manual steps.

### Finding 9 of 16: fail closed
**Chosen:** `--purge` refuses (exit 6) when the checkout is not a git repo or any git call fails,
and checks uncommitted changes, commits on any branch not on a remote, and stashes. pre-commit lists
staged files with `--diff-filter=d` and refuses when reading a staged manifest fails.

### Finding 10 of 16: one drift implementation, no cli spawn
**Chosen:** `hooks/drift.cjs` (Node built-ins, plus `semver` resolved from the app, range checks
skipped if absent) is the drift implementation; `src/localize/drift.ts` loads it with
`createRequire` and keeps the types. lock-at-rest requires it directly and prints only when
`node_modules/.package-lock.json` changed since the last report (a stamp file in
`node_modules/.cache/`).

### Findings 11–15: stale text and docs
Fix in place: `--purge` refusal becomes exit 6 (a guard refusal), docs follow; the CI grep in
`docs/localize.md` matches CN's; arch-03 and the how-to state the range rule precisely; the
releasing doc points at the drift check; the how-to says localize on the host, never in the dev
container, and notes the root-owned mountpoint on Linux; D10's rationale is corrected;
`ci-local.sh --install` refuses with a "park first" message when checkouts exist.

### Finding 16 of 16: semver
**Chosen:** stay a minor (no consumer found), and list the removed deep imports in the changeset.

## Iteration 1 — Plan

- **cli hooks** (`hooks/`): `drift.cjs` (new, shared), `manifests.cjs` (new: workspace manifest
  pathspecs from `package.json`), `lock-at-rest.cjs` (index-first restore, drift via `drift.cjs`
  with a stamp, cwd-relative paths), `git-hook.cjs` (cwd = app dir, members guard, workspace
  pathspecs, `--diff-filter=d`, fail closed).
- **cli TS**: `src/localize/drift.ts` → thin typed wrapper over `drift.cjs`;
  `git-hooks.ts` (skip + print when `core.hooksPath` is set; shim `cd`s to the recorded prefix;
  warn in a linked worktree); `app-setup.ts` (guarded command; upgrade the old one);
  `members.ts` or a new `app-root.ts` (`findAppRoot`, shared with `cli-methods.ts`);
  `localize.ts` (app root; set-up lockfile capture); `delocalize.ts` (fail-closed purge, exit 6);
  `cli.ts` help text; `errors.ts` comment; changeset; `docs/localize.md`.
- **CN**: `package.json` scripts → the guarded command; `pr-checks.yml` drift step; how-to,
  arch-03, `docs/releasing-linked-packages.md`, `agents.md`, `ci-local.sh`, backlog 105/097/076,
  `create-now.code-workspace`.
- **Contracts**: `hooks/drift.cjs` exports `driftProblems(appRoot)` returning the existing `Drift`
  shape and `describeDrift(d)`; `hooks/manifests.cjs` exports `manifestPathspecs(appRoot): string[]`
  (`package.json` plus `<glob>/package.json` for each non-`packages-local` workspace glob);
  `findAppRoot(start): string`; `LOCK_AT_REST_COMMAND` is the guarded string.

## Iteration 1 — Phases

### P7 — Hooks: shared drift, manifests, restore, fail closed (CLI)
Findings 1 (members guard), 3, 4, 6 (command constant + set-up upgrade), 7, 9 (pre-commit), 10.
Tests: drift parity through the wrapper (existing `drift.test.ts` passes unchanged); manifests for
`["packages/*","apps/*","packages-local/*"]`; lock-at-rest restores from the index when the staged
lockfile is clean and from HEAD when it leaks; a dependency change under `apps/x/package.json`
leaves the lockfile alone; app in a repo subdirectory; drift printed once for two runs with an
unchanged hidden lockfile; post-merge with no checkouts does not run npm; pre-commit refuses when a
staged manifest cannot be read; a staged deletion passes; the old unguarded script is upgraded.
**Quick gate:** tsc; `tests/unit/localize`.

**Result:** `hooks/manifests.cjs` (new): `workspaceGlobs`, `trackedGlobs`, `manifestPathspecs`
(`package.json` + `<glob>/package.json` per glob; array and `{packages}` forms; `./` and trailing
`/` dropped; negations and any `packages-local/…` glob skipped), `expandGlobs` (per segment, `*`
`?` `**`), `localMembers` and the shared `LEAK` rule. `hooks/drift.cjs` (new) is the drift
implementation, ported unchanged (same `Drift` shape, rules and `describeDrift` strings); importers
are `.`, the expanded tracked globs, then the checkouts; `semver` is `require`d from the hook's
location, and without it no range is checked. `src/localize/drift.ts` is a typed wrapper that finds
`hooks/drift.cjs` upwards from itself (works from `src/` under jest and from `lib/esm/` after a
build, checked) and loads it with `createRequire`; `drift.test.ts` passes unchanged.
`lock-at-rest.cjs` runs on `require` (no `process.exit`), works from `process.cwd()` with
`--relative` diffs, checks `manifestPathspecs`, restores from the index when the staged lockfile
passes the leak rule and from HEAD when it leaks (a lockfile not in the index is left, with a
line), always adds "changes to dependencies … need `linked delocalize` first", reports drift
in-process only when `node_modules/.package-lock.json` mtime/size differ from
`node_modules/.cache/linked-localize/drift-stamp`, and opens `/dev/tty` on the first write.
`git-hook.cjs`: app dir = cwd; post-merge/post-checkout return before any git or npm call when
`packages-local/` holds no member; `manifestPathspecs` + `package-lock.json`; pre-commit uses
`--diff-filter=d --relative`, reads `:./<file>`, and refuses (exit 1, names the git error and
`--no-verify`) when listing or reading fails. `LOCK_AT_REST_COMMAND` is the guarded `node -e`
form; set-up replaces a whole `&&` step that is `[npx] linked localize --relink` or the unguarded
hook (a regex on the script, since the guard itself contains `&&`). Also: `--check`'s help and
`list.ts`'s header no longer say lock-at-rest runs it; `semver.ts`'s header points at `drift.cjs`.
Deviations: drift falls back to `packages/*` for an app with no `workspaces` (keeps
`drift.test.ts` unchanged; `manifestPathspecs` has no such fallback); pre-commit also fails closed
when it cannot list the staged files. Tests: `manifests.test.ts` (5); `hooks.test.ts` +12 (index vs
HEAD restore, `apps/*` change, app in a subdirectory for lock-at-rest/pre-commit/post-checkout,
drift once then again, guarded command via `sh -c` without and with the cli, post-merge without
checkouts, unreadable staged manifest via a `git` shim on PATH failing `show`, staged deletion, a
leak without the glob), the existing install tests now have a checkout; `app-setup.test.ts` +2.
An eight-mutation pass on the hooks (HEAD-only restore, no members guard, fail-open read, no
`--diff-filter`, no stamp, root-only pathspecs ×2, glob-only leak rule) — each caught. Validation:
`npx tsc -p tsconfig-esm.json --noEmit` exit 0; `npx jest --config jest.config.cjs
tests/unit/localize` 13 suites / 154 tests passed; `node --check` exit 0 for all four hooks; the
`require` grep lists `child_process`, `fs`, `path` and the optional `semver`; `npm run test:unit`
63 suites / 711 tests passed (11.4 s); `npm run build` exit 0, `npm pack --dry-run` lists the four
hooks. Notes for P8: the shim must `cd` to the app directory and keep `GIT_DIR`/`GIT_INDEX_FILE`
usable there (git may export a relative `GIT_DIR`); `docs/localize.md` still describes the
unguarded command, the `--list --check` call from lock-at-rest and `packages/*`.

### P8 — Commands: app root, set-up capture, purge, hooksPath, stale text (CLI)
Findings 1 (`core.hooksPath` skip + print, worktree warning), 5, 8, 9 (purge), 11, 16, and
`docs/localize.md` for all of iteration 1.
Tests: localize from `packages/foo` sets up the app root; set-up capture leaves exactly the set-up
diff (fake run + a real-npm case in `real-localize`); `core.hooksPath` set → nothing written, three
lines printed; purge refuses on git failure / no `.git` / stash / unpushed branch (exit 6).
**Quick gate:** tsc; `tests/unit/localize tests/unit/localizeCommand.test.ts tests/unit/createPackage`;
`npm run build`.

**Result:** `src/localize/app-root.ts` (new): `findWorkspaceRoot(start)` (topmost ancestor with
`workspaces`, preferring a non-`linkedPackage` one; unreadable `package.json` skipped; no 10-level
cap) and `findAppRoot(start)` (that, else `start`); `cli-methods.ts`'s private copy removed
(`build-all` keeps its null case through `findWorkspaceRoot`); `commands/localize.ts` (localize,
`--list`, delocalize) and the drift `preAction` use `findAppRoot(cwd)`. `git-hooks.ts`:
`installGitHooks` returns `{written, skipped, manual, hooksPath, sharedWithWorktrees}`; with
`core.hooksPath` set it writes nothing and returns per hook the file (`.husky/<hook>` for
husky's `.husky/_`) and a one-line subshell (`hookLine`); `--git-dir` ≠ `--git-common-dir` sets
`sharedWithWorktrees`. The shim records `--show-prefix` (single-quoted, survives spaces and
quotes), exports `GIT_WORK_TREE=$PWD` when `GIT_DIR` is set without it (measured: with a relative
`GIT_DIR` and no work tree, git took the app dir for the top level after the `cd`), makes
`GIT_DIR`/`GIT_INDEX_FILE`/`GIT_WORK_TREE` absolute against the hook's start directory, then `cd`s
to the app. `localize.ts`: `reportHooks` prints skipped hooks, the `core.hooksPath` header plus one
`file:` / line pair per hook, and one worktree warning; set-up capture (`captureSetupLockfile`)
runs `npm install --package-lock-only --ignore-scripts --no-audit --no-fund` right after
`ensureAppSetup` when it changed `package.json`, before any clone, moving an existing
`packages-local/` aside to `.packages-local.setup` for that call (adopt / create-package), and
`installAndBuild(…, setupLock)` writes it back after the install (also when the install failed)
and prints the `git add package.json package-lock.json .gitignore && git commit` line; on failure
the manual delocalize/install/commit/`--parked` steps are printed. `delocalize --purge` fails
closed (exit 6, `EXIT_REFUSED`): no `.git`, any failing git call, `status --porcelain`,
`log --branches --not --remotes`, `stash list`; `--force` overrides ("although …"); a refused park
stays 5. `errors.ts` comments, `cli.ts` help (`--location`, localize, `--purge`, `--force`),
changeset (guarded command, one-step set-up, app root, hooks, purge 5→6, removed deep imports —
each checked against `origin/main`), `docs/localize.md` (guarded command, index-first restore,
in-process drift on tree change, workspace manifests, app root, one-step set-up + manual fallback,
new "Git hooks" and "Purge" sections, CI grep = CN's, exit codes) and README. Tests:
`app-root.test.ts` (3), `purge.test.ts` (6, real git: pushed → deletes; no `.git`, failing git
shim on PATH, dirty, commit on another branch, stash → 6; `--force`), `git-hooks.test.ts` +4 (app
in `my apps/it's web`: shim run with relative `GIT_DIR`/`GIT_INDEX_FILE` and via a real
`git checkout`; real commit refused by the real pre-commit from the subdirectory; husky
`core.hooksPath` → nothing written, three lines printed, the line run under `sh -e`; worktree
warning once), `commands.test.ts` +3 (capture written back, fallback on npm failure, no capture
when set up), `adopt.test.ts` (capture with the checkout moved aside), `localizeCommand.test.ts`
+1 (from `packages/foo` all three commands get the app root), `real-localize` +1 (first localize
in an un-set-up app: `git status --porcelain` is exactly ` M .gitignore`, ` M package-lock.json`,
` M package.json`; the lockfile diff is one hunk: `hasInstallScript`, `workspaces`,
`packages-local/*`). The stubbed suites now start from a set-up app unless a test is about
set-up. Mutations (no env fix in the shim; no write-back) each caught. Validation:
`npx tsc -p tsconfig-esm.json --noEmit` exit 0; `npx jest --config jest.config.cjs
tests/unit/localize tests/unit/localizeCommand.test.ts tests/unit/createPackage tests/unit/buildAll`
20 suites / 232 tests passed; `npm run test:unit` 65 suites / 729 tests passed (11.6 s);
`npm run build` exit 0; `npx changeset status`: `@_linked/cli` minor. Notes for P10: the set-up
capture needs registry access (a lockfile-only resolve); in CN the first install prints
lock-at-rest's "package.json differs from HEAD" warning before localize writes the set-up
lockfile back — expected, and said so; check the husky lines by pasting one into a real
`.husky/post-merge`; a purge of a checkout created by `create-package` without a remote is now
refused (its first commit is on no remote).

### P9 — CN follow-ups
Findings 2, 6 (scripts), 12, 13, 14, 15. **Quick gate:** package.json parses; manifests grep; YAML
parses; stale-reference grep; `bash -n scripts/ci-local.sh`.

**Result:** One CN commit (`cb7638a2`, 12 files). `postinstall`/`dependencies` run the guarded
command (JSON equality checked; a directory without the cli exits 0); the lockfile is unchanged.
`pr-checks.yml` typecheck job runs `npx linked localize --list --check` after `npm ci` (needs the
cli release). arch-03 and `.npmrc` state the range rule precisely; arch-03's Docker line says
`node:24-bookworm` / npm 11.19.0 (measured) and notes the dev container's empty `packages-local/`;
`docs/releasing-linked-packages.md` points at the drift check; the how-to adds host-only
localizing, the Linux root-owned mountpoint, the CI drift step, a monorepo migration step;
`agents.md` adds the worktree-hooks bullet; backlog 105/097/076 and `create-now.code-workspace`
updated; `ci-local.sh --install` refuses (exit 1, lists the checkouts) before `npm ci` when
checkouts exist. Validation: leak grep empty, YAML parses, `bash -n`, `docker compose --profile
setup config -q` exit 0.

### P10 — Integration re-run
In a fresh standalone clone of the CN branch with the four checkouts: one-step set-up from an
un-set-up app (capture), install, drift printed once, husky-style `core.hooksPath` (nothing
written, lines printed), a dependency change in a second workspace folder survives, purge refusal,
`npm ci` with no checkouts and no cli hooks file (guarded command is a silent no-op), backend +
vitest smoke. **Then review again.**

**Result:** Standalone clones only (`scratchpad/p10-*`); sources = read-only clones of the
developer's core (`main` 08bf1df, 2.28.4), auth (`main` 1aaa261, 3.4.0), shape-ui (`main` c53b297,
2.7.0), dcmi (`main` 97b8482, 1.3.4) into `p10-src/`, and this branch as `_linked-cli`. CN at
`cb7638a2`. `.env` from `.env.example` with `PORT`/`SITE_ROOT` on 4343 and Fuseki on the dead port
3997. Node 22.23.3, npm 12.2.0.

| | scenario | result |
|---|---|---|
| A | one-step set-up from un-set-up `main` (`45fa522f`) | PASS after a fix. `npm install` on `main` (registry cli 1.46.1): its `linked localize --relink` postinstall printed nothing, exit 0, status clean. New cli `localize @_linked/core` → exit 6 `package.json "overrides" names a localized package: "@_linked/core"` … `Nothing was changed.` (main still has the `$` overrides; expected). `localize @_linked/dcmi`: **the capture failed** — `npm install --package-lock-only` → `EALLOWREMOTE … Refusing to fetch "https://registry.npmjs.org/@tailwindcss/oxide-wasm32-wasi/-/oxide-wasm32-wasi-4.3.3.tgz"` (CN report 074 §2.1: lockfile-only fetches a `bundleDependencies` tarball and skips npm 12's same-registry exemption); manual steps printed, and the work tree held the install's lockfile (538-line diff incl. `packages-local/_linked-dcmi`). npm 11 and `--allow-remote=all` succeed but add ~60 `inBundle` lines, so lockfile-only is never "just the set-up" on CN. Fixed (below); re-run 12.6 s, exit 0: `package-lock.json: the root entry's "workspaces" now matches package.json (the set-up's lockfile)` … `put back the set-up's lockfile`; `git status`: exactly ` M .gitignore`, ` M package-lock.json`, ` M package.json`; lockfile diff `@@ -13 +13,2 @@ -"packages/*" +"packages/*", +"packages-local/*"`; dcmi linked; three hooks in `.git/hooks`. The edited lockfile: `npm ci` exit 0 (11 s), a following `npm install` leaves it byte-identical |
| B | fresh clone + 4 checkouts, bootstrap, installs | PASS after a fix. First `npm install` 29 s: `[lock-at-rest] restored the committed package-lock.json (packages-local/_linked-auth, …-cli, …-core, …-shape-ui stay linked …)`, status clean, four links. Recipe from `docs/localize.md` as written: core `npm run compile` 2.7 s, cli `npm run build` 3.5 s, `npm rebuild @_linked/cli --ignore-scripts` 1.2 s → `.bin/linked -> ../@_linked/cli/lib/esm/launch.js`. `--list`: `4 localized · no drift`; `--check` 0. Drift (shape-ui core range `2.28.3`): the two drift lines printed once per install (not twice), **but again on an `up to date` install** — npm rewrites `node_modules/.package-lock.json` every install, so the mtime stamp never matched. Fixed (below); re-run: install 1 prints `second copy of localized @_linked/core@2.28.3 at packages-local/_linked-shape-ui/node_modules/@_linked/core` + the range miss, install 2 (`up to date in 9s`) prints none. Range reverted: nested copy removed, `--check` 0, clean |
| C | dep change in `packages/access` | PASS. `npm install is-number@7.0.0 -w packages/access`: npm runs no root lifecycle under `-w`, so lock-at-rest did not run at all; lockfile left with checkout entries. Plain `npm install` then: `WARNING: packages/access/package.json differ(s) from HEAD while checkouts are linked …`, `package-lock.json now references packages-local and must NOT be committed.`, lockfile not restored. With hooks installed, committing both: `pre-commit: refusing package-lock.json: it references packages-local/ …`, exit 1. (Before hooks were installed — see finding b — that commit went through; it was undone.) Reverted + install: clean |
| D | husky `core.hooksPath` | PASS. `hooksPath=.husky/_`, `localize @_linked/shape-ui --adopt --build ""` (re-adopting a linked member works, 16.8 s): `core.hooksPath is set (.husky/_), so no git hooks were written. Add each line below …` with `.husky/post-merge:`/`post-checkout:`/`pre-commit:` lines; `.husky/_` stayed empty. The post-merge line pasted into `.husky/post-merge` (`sh -n` ok), `hooksPath=.husky`; `git pull --ff-only` of a side branch bumping `@_linked/server` 2.24.8 → 2.24.9 (made in the no-checkout clone): `[git hook] dependency manifests changed (cb7638a2d..690b9e6ff): npm install` … `[git hook] npm install done in 9s`; server 2.24.9, core still linked, status clean (`.husky/` untracked). hooksPath unset, `.husky` removed, adopt again wrote the three hooks to `.git/hooks` |
| E | purge refusal | PASS. Disposable dcmi checkout (clone of `p10-src`), commit on branch `side` + a stash: `delocalize @_linked/dcmi --purge` exit 6 `not deleting -- it has 1 commit on a branch no remote has. Pass --force …` (1.3 s), checkout kept; `--force` exit 0 `although it has 1 commit on a branch no remote has`, removed, registry dcmi reinstalled (18 s). Stash only (fresh checkout): exit 6 `it has 1 stash entry`; `--force` deletes. The refusal names the first reason found only |
| F | CI path | PASS. Fresh clone, no `packages-local`, registry cli 1.46.1 (no `hooks/`): `npm ci` exit 0, 21 s, the guarded command printed nothing. With this branch's `hooks/` copied into `node_modules/@_linked/cli/hooks`: `npm run postinstall --silent` exit 0, 0.28 s, no output; `node wt-cli/lib/esm/launch.js localize --list --check` exit 0, 1.2 s, no output (no singleton copies) |
| G | smoke | PASS. `npx linked build-all` 23 s exit 0: `Building @_linked/core first: @_linked/cli depends on it.` → `Building @_linked/cli alone` → 6 more. `npm run typecheck:gate` 16 s: `No new type errors. 0 pre-existing errors still in the baseline.` `npx vitest run` 45 s: 236 files passed, 1873 passed / 5 skipped — with `DOCUMENT_EXTRACTION_PROVIDER=openai` commented out of `.env` for that run (the P6 caveat: with it, two `DocumentExtractionClient` provider-default cases fail), restored after. Backend `linked start --env development`: `Up and running at http://localhost:4343`, `GET /` 200, no `getLincdPackages` error (`Could not sort lincd packages, circular dependencies?` is pre-existing, P6); PIDs 89596/89624/89631/89641 stopped, 4343 free |
| H | worktree, no checkouts | PASS. `git worktree add --detach ../p10-wt` of `p10-cn2`; checkout `cb7638a2` ↔ `690b9e6f` (lockfile differs): no node_modules → 0.26 s, nothing printed. After `npm ci` + this branch's `hooks/` in the worktree's cli: both switches 0.57 s / 0.11 s, nothing printed, no install, clean. Control: with a probe member in the worktree's `packages-local/` the same switch prints `[git hook] dependency manifests changed (690b9e6ff..cb7638a2d): npm install` — the members guard is what kept it quiet |

Fixes — cli: `207bc31` fix(localize): make the set-up's lockfile by editing the root entry when it
has workspaces (`src/localize/setup-lockfile.ts`: sets `packages[""].workspaces` to
`package.json`'s when the root entry already has `workspaces` and `hasInstallScript: true`, the
dependency fields agree, and the file round-trips through `JSON.stringify` with its indent/EOL;
else `null` and npm's lockfile-only call as before; tests: `setup-lockfile.test.ts` (4), a stubbed
case in `commands.test.ts` (no `--package-lock-only` call), a real-npm case in `real-localize`
(one-hunk diff, then `npm ci` with no checkout exits 0); disabling the edit fails 2; docs +
changeset). `be7a1ac` fix(localize): stamp the drift report on the hidden lockfile's content (sha1),
not its mtime (+ a same-content/new-mtime step in `hooks.test.ts`, which fails on the old stamp;
docs). `npm run test:unit` 66 suites / 735 tests, tsc and `npm run build` exit 0. CN: none.

Open findings: (a) On `main` today, localizing core/react/server-utils is refused until the `$`
overrides go — expected (the CN branch removes them), but the set-up does not say so for a first
localize from `main`. (b) Hooks are written only by a localize run: the "both fresh, unbuilt"
recipe in `docs/localize.md` (and any clone where checkouts are put in by hand and `npm install`
run) leaves no hooks, so a leaked lockfile could be committed until
`npx linked localize <name> --adopt` is run once (measured: it writes them). Suggest one more line
in that recipe. (c) `npm install <dep> -w <member>` runs no root lifecycle, so lock-at-rest neither
warns nor restores; pre-commit still refuses the result. (d) After lock-at-rest restores the
committed lockfile, the next install reports `changed ~352 packages` (~11 s) before settling to
`up to date` (~9 s); harmless, slower. (e) The purge refusal names only the first unsaved-work
reason. (f) The un-set-up run in A used a cli newer than the app's (registry 1.46.1 has no
`hooks/`), so the hooks it wrote are inert there until the cli release is installed — as intended.
(g) The `p10-wt` worktree stays registered in `p10-cn2` (scratch only).

## Review 2

All suites pass (tsc; cli unit 66 suites / 735 tests). Review 1's findings: 14 resolved; 2 partial
(CN's drift CI step is inert until CN installs the cli release — a wrapup dependency, together with
the `hooks/` bump; D10's rationale — fixed above). New, selected for iteration 2:

1. High — `findAppRoot` climbs past a nested git worktree (`create_now/.claude/worktrees/<x>`) to
   the main checkout, so `localize`/`delocalize`/`--purge` there would act on the main clone.
2. M — moving checkouts aside to `.packages-local.setup` during set-up is not crash-safe (Ctrl-C
   strands them; not gitignored; the next run clones fresh).
3. M — `--purge` misses commits on a detached HEAD.
4. M — the set-up lockfile edit does not check that the lockfile's `workspaces` already match
   `package.json` (minus the new glob), so it can write a lockfile `npm ci` rejects.
5. M — a clone that never ran `linked localize` has no hooks (the cli/core bootstrap recipe ends
   that way); CN's CI checks are not enforced, so the CI grep is not a backstop.

Low, left for the pause: drift module loaded eagerly by every command; drift printed twice during
a localize run; `semver.ts` duplicates `drift.cjs`; an untracked new member manifest gets no
warning; misleading message on a conflicted lockfile; the set-up lockfile is lost by an install
before it is committed (docs); negation/brace globs; pre-commit skipped when `node` is missing
(docs); two doc wording items; overrides refusal could name the drift check; the extra install
round after a restore; purge names only the first reason; test gaps for the lows.

## Iteration 2 — Ideation

### Finding 1 of 5: app root in nested worktrees
**Chosen:** take the nearest ancestor with `workspaces` (R); climb to a higher ancestor only while
its `workspaces` globs match R's relative path. A worktree under `.claude/worktrees/` is not
matched by CN's globs, so it stays its own root. `build-all` gets the same rule.

### Finding 2 of 5: crash-safe move-aside
**Chosen:** move checkouts into `packages-local/.setup-aside/` (inside the gitignored directory,
skipped by the `*` glob like `.repos/`); at the start of `localize`, `delocalize` and `--list`, a
leftover `.setup-aside/` is moved back with one line saying so.

### Finding 3 of 5: purge and detached HEAD
**Chosen:** `git log --oneline HEAD --branches --not --remotes`.

### Finding 4 of 5: set-up lockfile edit
**Chosen:** edit only when the lockfile root's `workspaces` deep-equal `package.json`'s pre-set-up
globs; otherwise fall back to npm, then to the manual steps.

### Finding 5 of 5: clones without hooks
**Chosen:** lock-at-rest prints one line when checkouts exist, `core.hooksPath` is unset and the
hooks directory has no marked `pre-commit`: "run `npx linked localize <name> --adopt --build ''`
once to install the git hooks"; the bootstrap recipe in `docs/localize.md` and CN's how-to end with
that command.

## Iteration 2 — Plan and phases

### P11 — Iteration 2 fixes (CLI)
Files: `src/localize/app-root.ts` (+ `build-all`'s caller), `src/localize/localize.ts`
(`.setup-aside`, leftover recovery in localize/delocalize/list), `src/localize/delocalize.ts`
(HEAD in the purge log), `src/localize/setup-lockfile.ts` (workspaces equality),
`hooks/lock-at-rest.cjs` (missing-hooks notice), `docs/localize.md`, changeset if wording changes.
Tests: `findAppRoot` for a worktree nested under the app (not matched by its globs) and for a
member under `packages/` (matched); leftover `.setup-aside/` restored; purge refuses a commit on a
detached HEAD; set-up edit returns null when lockfile `workspaces` differ; lock-at-rest prints the
hooks notice once when members exist and no marked pre-commit, nothing when the hook exists or
`core.hooksPath` is set.
**Quick gate:** tsc; `tests/unit/localize tests/unit/localizeCommand.test.ts tests/unit/buildAll`;
`npm run test:unit`; `npm run build`.

**Result:** (1) `findWorkspaceRoot` takes the nearest ancestor with `workspaces`, then climbs
through each higher one with `workspaces` whose globs match the root so far, stopping at the first
that does not; of that chain the topmost non-linked-package wins. Matching is the new
`globsMatch(globs, rel)` in `hooks/manifests.cjs` (segment-wise like `expandGlobs`: `*`/`?`, `**`,
no dot or node_modules under a wildcard, `!` negations), loaded from TS through the new
`src/localize/hook-module.ts` (`requireHook`, now also used by `drift.ts`), so one implementation.
`build-all` already took `findWorkspaceRoot`, so it follows. Tests: worktree at
`<app>/.claude/worktrees/wt` → itself (and its member → it); `<app>/packages/bar` → `<app>`;
negation and `**`. (2) Set-up moves every non-dot entry of `packages-local/` into
`packages-local/.setup-aside/` (plain renames, so a `.repos` link keeps its text) and back;
`restoreSetAside` at the start of `runLocalize` (localize/adopt/`--parked`), `delocalize` and
`list` moves a leftover back with one line (`moved 1 checkout back from
packages-local/.setup-aside/ into packages-local/, where an interrupted set-up left it.`), or
refuses exit 6 naming the clashing `packages-local/<dir>` and moving nothing. Dot dirs skipped,
re-measured on npm 12.2.0: `packages-local/.setup-aside/package.json` and
`.setup-aside/x/package.json` present, `npm install --package-lock-only` → lockfile lists only
`"packages-local/*"` and `"packages-local/vis"`. Tests: leftover restored by list/delocalize/
localize; clash refused; adopt sees the checkout in `.setup-aside/` during the lock-only call.
(3) purge: `git log --oneline HEAD --branches --not --remotes`; message now `N commit(s) no
remote has`. Test: commit on a detached HEAD → exit 6. (4) `setupLockfileByEdit(lock, pkg,
workspacesBefore)`: null unless `isDeepStrictEqual(root.workspaces, workspacesBefore)`;
`runLocalize` reads `workspaces` before `ensureAppSetup`. Tests: extra glob, none before,
reordered → null. (5) lock-at-rest: inside the stamp-gated report (so once per install that
changed the tree, quiet for the second script and no-op installs; shows on first install), when
members exist, it is a work tree, `core.hooksPath` is unset and `<git-path hooks>/pre-commit`
lacks `# managed by linked localize`: `[lock-at-rest] git hooks are not installed in this clone:
run \`npx linked localize <first member> --adopt --build ''\` once`. Tests: notice once, again
for a foreign pre-commit; none after `installGitHooks`, under `core.hooksPath`, or with no
members. (6) `docs/localize.md`: app-root rule, `.setup-aside/` + recovery, edit condition, purge
`HEAD`, bootstrap recipe ends with `npx linked localize @_linked/cli --adopt --build ''`, a
"clone without the hooks" paragraph; changeset wording (app root, notice, purge). Gate: `npx tsc
-p tsconfig-esm.json --noEmit` exit 0; `npx jest --config jest.config.cjs tests/unit/localize
tests/unit/localizeCommand.test.ts tests/unit/buildAll` → `Test Suites: 19 passed, 19 total`,
`Tests: 217 passed, 217 total`; `npm run test:unit` → `Test Suites: 66 passed, 66 total`,
`Tests: 744 passed, 744 total`; `npm run build` exit 0.

### P12 — CN how-to line
`docs/how-to/develop-a-linked-package-locally.md`: the bootstrap/migration steps end with
`npx linked localize <name> --adopt --build ''` to install hooks; mention the lock-at-rest notice.
**Quick gate:** grep shows the line; no other change.

**Result:** CN commit `e0a1bbef` (`docs/how-to/develop-a-linked-package-locally.md` only, +15/−1).
Migration step 7 now says that when the adopt-all run is skipped (cli and core built by hand, or
checkouts put in another way) the steps end with `npx linked localize <name> --adopt --build ''`
for any one checkout, to install the git hooks; "Pulling and switching branches" quotes the
lock-at-rest notice and the same command. Gate: `grep -n "adopt --build ''"` → lines 110 and 258;
`git diff --stat` → that one file.
