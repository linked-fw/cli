---
summary: >
  Rebuild `linked localize` on npm workspaces: the app commits `"packages-local/*"`, npm links and
  dedupes checkouts, a dependency-free hook shipped in the cli restores the committed lockfile so
  the working tree stays clean, and localize shrinks to clone/adopt/park/list plus a drift check.
  Pruning, relink, ensure, the provided rule and the localize Vite dedupe are removed. Spans this
  repo and Create Now.
status: Plan
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
