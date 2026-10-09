---
date: 2026-10-09
summary: >
  `@_linked/localize` is merged into the cli (`linked localize` is the only entry), and "one copy of
  every package the app provides" is now an invariant localize owns rather than a side effect of
  running a localize command: one rule (`providedPackages`) shared by pruning, a run-time check and
  Vite's dedupe; every in-checkout install goes through `ensure` (install, then prune); `linked
  start`/`script`/`call`/`build-all` and `linked localize --ensure` remove a planted duplicate in
  ~40 ms, keep copies whose own resolution would change, and honour a recorded `--no-prune`.
  Released in 1.42.0 and 1.44.0. Retiring the `@_linked/localize` package is still open.
---

# 011 — Localize: one copy, always

## The problem

`linked localize` clones (or adopts) a dependency into `packages-local/<scope-name>`, runs
`npm install` **inside the checkout** against the checkout's own lockfile, builds it, symlinks
`node_modules/<name>` at it and records it in the gitignored `local-packages.json`. The app's
postinstall `linked localize --relink` restores the links after every `npm install`.

It deliberately avoids workspaces, `npm link`, `file:` and `npm install <path>`, because localizing
must never change a committed file. The recorded reasons: a per-developer workspace entry leaks
into the lockfile, and `npm ci` exits 0 on a dangling link; a Vite app compiles anything matched by
a workspace glob from source instead of the installed copy; and each package must stay releasable
on its own lockfile.

The cost of that model is nested duplicates:

- Every `npm install` inside a checkout — localize's own, relink's reinstall, a developer's by
  hand — puts the checkout's own copies of core, React, localized siblings, the cli and localize
  back into its `node_modules`. Node resolves from the importer's **real** path, so the checkout
  loads those, not the app's: a localized package never sees a localized sibling, and a package
  holding a class registry (or React) loads once per copy. Measured: three copies of
  `@_linked/core` in one process.
- Pruning those copies existed (localize 0.3), but only ran when a localize command ran, and never
  for unrecorded checkouts.
- Vite's `resolve.dedupe` hid the problem in Vite only. `tsc` (82 type errors measured in the
  consuming app), plain Node, `tsx`, Jest and Vitest's externalized dependencies all saw the
  duplicates.
- Bootstrap trap: the cli loaded localize with `await import('@_linked/localize')`, resolved from
  the cli's real path. A localized cli's own install brought the lockfile-pinned localize 0.3.0
  (published without the prune code), which could never prune itself.
- Version drift: the cli's lockfile pinned localize 0.3.0, the consuming app's pinned an older cli
  and localize 0.2.0 (no pruning at all) — a fresh clone got no pruning.
- A false premise in localize's docs: that a checkout's parent directories contain no
  `node_modules`. Under `packages-local/` inside an app they do, so a checkout only needs its own
  install for what the app does **not** provide.

Rejected directions: npm workspaces (breaks the no-committed-diff guarantee); resolve-time hooks
only (do not fix `tsc`, Jest or raw Node). Chosen: keep the filesystem model, make one-copy an
invariant localize owns, enforce it at run time, and derive "provided" from one rule.

## Decisions

| # | Decision | Why |
|---|---|---|
| D1 | **Merge localize into the cli**; `linked localize` is the only entry, the `linked-localize` bin goes, `@_linked/localize` is to be deprecated. | Removes the bootstrap and version-drift class: there is no separately versioned copy left to nest. The rule, pruning and the Vite dedupe live in one release. Rejected: keep separate (a fence, not a fix); a two-package monorepo (more tooling, same nesting). |
| D2 | **Install then prune is one step, `ensure`.** localize's install, relink's reinstall and a new `linked localize --reinstall <pkg>` (replacing a hand-run `npm install` in a checkout) all go through it. | Copies an install puts back exist only until it returns. Rejected for now: a peer-dependency convention with `--omit=peer` (fleet migration); a temp-dir install (reimplements npm). |
| D3 | **Run commands enforce it** with a cheap check that prunes and says so in one line. The server's "installed N times" warning stays as the backstop. | Covers a developer's in-checkout install and the cases relink skips. Safe to auto-fix: prune only removes what the app provides at a version satisfying every range. Rejected: warn-only. |
| D4 | **One rule for "provided"**, the derivation the cli's Vite config already used, scoped to localized packages. The consuming app's hand-written `resolve.dedupe` list is deleted. | One source of truth, already proven in Vite; a hand list is how the app's drifted. Widens prune's candidates (see P3), still guarded per copy. |
| D5 | **Every checkout in `packages-local/` is localized**; `--list` flags a directory without a record. | No half-converted state. Consequence: the app runs every checkout's source, so adoption needs full validation. |

| # | Plan-level decision | Why / amendment |
|---|---|---|
| P1 | `@_linked/localize` is retired, not adopted (exception to D5). | It is no longer a dependency of anything. |
| P2 | Semver is npm's `semver`, keeping "cannot tell" semantics: an unreadable range keeps the copy. localize's own `semver.js` subset is gone. | One implementation; never prune on a range that cannot be read. All 47 rows of localize's semver table give the same answer. |
| P3 | The rule = localized packages + their runtime dependencies (`dependencies`, `peerDependencies`, `optionalDependencies`) the app has at a version satisfying every localized range, + `react`/`react-dom`. One function, `providedPackages()`. The "a registry install nests its own copy" exclusion stays Vite-only. | Cheap and shared. devDependencies are not candidates. **Amended by R6:** candidates are taken per owner, not pooled. |
| P4 | The run-time check is a stat-level plan, hooked as a commander `preAction` for `start`, `script`, `call`, `build-all`, and exposed as `linked localize --ensure` for npm `pre*` scripts. Never runs npm. | **Amended by R1:** the plan mirrors prune's whole guard so kept copies never reach the prune. |
| P5 | `ensure(entry)` = in-checkout `npm install`, then prune that checkout. | D2. Implemented synchronously (all of localize is `spawnSync`); throws `LocalizeError(EXIT_INSTALL_FAILED)` so each caller adds its own context; returns `EXIT_WARNED` when only the prune failed. |
| P6 | Module layout `src/localize/*.ts`; `commands/localize.ts` stays the commander adapter; one manifest reader. Exit codes 3–8, the `deps` seam `{appRoot, run, log, warn, error}` and the `local-packages.json` schema (version 1) are kept as the public contract. Hints say `linked localize …`. | Mechanical port, same contracts. |
| P7 | localize's 8 node:test suites ported to jest under `tests/unit/localize/`; `real-localize` (real clone + real `npm install`) runs in `test:unit`. | The cli's CI requires tests. A helper wraps jest's `test` and hands the body a `t` with `t.after()`, so bodies stayed as written. |
| P8 | `--list` shows `UNRECORDED` directories (counted, does not fail `--check`). | Keeps D5 honest. |
| P9 | Releases: cli minor; then localize 0.4.0 as a pointer, `npm deprecate`, archive the repo. | D1. The localize half is **not done** (see Deferred). |
| P10 | Consuming app: bump the cli, delete the hand dedupe, add `pre*` hooks running `linked localize --ensure`, delocalize `@_linked/localize`. | Measured: deleting the hand dedupe lost nothing. |
| P11 | Adopt every remaining checkout (each on `main` = `origin/main`, version compatible with the app's range, built). | D5. |

## How it works now

### One rule

`providedPackages(appRoot, localizedNames?)` in `src/localize/provided.ts` returns
`{names, skipped, localized, dependencies}`:

- every localized package the app has installed — always, whatever a range says: the live
  checkout is the point of localizing it;
- every runtime dependency a localized checkout declares that the app has at a version satisfying
  **every** localized checkout's range for it; a missed or unreadable range leaves it out as
  `skipped`, with who asks what;
- `react` and `react-dom` when the app has them.

It reads only the manifest, one `package.json` per localized package and one per dependency it
names, because the run-time check calls it before every run command. Pruning passes the entries it
is working on, so a checkout being localized counts before the manifest records it. Vite's dedupe
(`src/localized-dedupe.ts`) consumes the same result and adds only its own exclusion (a name some
registry install nests its own copy of — a dedupe checks no version, so it would hand that
package the wrong one).

### Pruning (`src/localize/prune.ts`)

`planPrune(entries, deps, scope?, cache?)` decides every copy without touching disk and returns
`{remove, keep, outside}`; `pruneProvided` applies the plan.

- **Per-owner candidates (R6).** A copy is a candidate in checkout O when the rule provides it
  *and* it is a localized sibling, `react`/`react-dom`, or one of O's own runtime dependencies.
  O's devDependencies are O's tooling, whatever another checkout declares at runtime. Candidates
  are looked up directly, never by listing `node_modules`.
- **Range guard.** A sibling is always removed (a range it misses is reported as drift, never acted
  on). Anything else is removed only when the app's version satisfies the owner's own range
  (checked first — no index needed) and every range that would load that copy.
- **Requirement index (R1).** "Every range that would load `<nm>/<dep>`" comes from one index per
  `node_modules`, built at most once per call, read from npm's hidden lockfile
  `node_modules/.package-lock.json` (npm rewrites it on every install in that tree). Measured over
  21 checkouts: parsing all lockfiles ~45 ms, against 0.8 s warm / 3.4 s cold to walk the same
  16,800 `package.json` files. A tree without one is walked once. Requirers are checked against
  disk when asked, so what an earlier prune removed asks nothing.
- **Keep on context change (R3).** A copy stays when any of its `dependencies`,
  `peerDependencies`, `optionalDependencies` — **or the `@types/` companion TypeScript would take
  for it** — resolves from the copy's place in the checkout to a different package than from the
  app's copy (a different real path that is not the same `name@version`, or nothing at all).
  Measured failure it prevents: a checkout kept its React 18 and `@types/react` 18 (its range),
  lost `prism-react-renderer` (in range), and the app's copy of that resolved React — and its
  types — to 19, so the checkout's own `tsc` saw both type sets. The same version at another path
  is the same code and does not count, otherwise nearly every copy with a dependency would be kept.
- **Fixed point (R5).** A removal can make another copy removable, so `pruneProvided` plans and
  removes again until a pass removes nothing (`MAX_PRUNE_PASSES` = 5): one call converges.
- **`prune: false`.** `--no-prune` at localize/adopt records `"prune": false` on the manifest
  entry (optional field, schema stays 1); prune, `ensure`, relink and the run-time check leave
  that checkout alone, and localizing again without the flag turns pruning back on.
- Never removed: a copy in a checkout outside the app root (the upward search would never reach the
  app's `node_modules`). A package with a `bin` is not exempt — npm puts every ancestor's
  `node_modules/.bin` on the PATH, measured — and its `.bin` links go with it.
- Kept copies are reported as one summary line per checkout (`kept N own copies … \`linked
  localize --list\` says why`); `explainKept` gives the full reason.

### `ensure` and the run-time check (`src/localize/ensure.ts`)

- `ensure(entry, deps, opts?)` — the only way a checkout gets installed. Siblings come from the
  manifest, the package name from the checkout's `package.json`.
- `reinstall(name, opts, deps)` — `linked localize --reinstall <pkg>`.
- `checkOneCopy(appRoot?, deps?)` → `{pruned}` — runs `planPrune` and calls `pruneProvided` only
  when the plan removes something (scoped to those owners and names, sharing the cache). One line
  on stderr when it removes; silent otherwise; no-op with no manifest; never runs npm; never
  throws (a run command must not fail over a developer's private checkout state). Prune's own
  kept-copy warnings are silenced here — they belong to localize/relink/reinstall, not every
  `linked start`.
- The preAction lives in `src/localize/one-copy-hook.ts` (`ONE_COPY_COMMANDS`,
  `installOneCopyHook`), apart from `cli.ts` so a test can install it on its own program.

Timings in the consuming app (21 checkouts, 53 kept copies): the old check took 6.6 s and removed
nothing; `planPrune` 37–41 ms warm, `checkOneCopy` 39–52 ms in a fresh process (5 index builds).
`linked localize --ensure` via the bin 1.01–1.07 s against 0.96–0.99 s for a bare `linked` — the
rest is cli startup; `npx` adds ~0.3 s.

### `--list`

Linked rows show `kept N own copies` or `prune: off`; the reasons follow the table; the summary
counts kept copies and `UNRECORDED` directories (a directory in `packages-local/` that no entry
records and no untracked link points at).

## Files

| File | Role |
|---|---|
| `src/localize/{localize,adopt,delocalize,list,relink,resolve,manifest,fsops,run,errors}.ts` | localize 0.3.1 ported; install step goes through `ensure` |
| `src/localize/provided.ts` | the rule |
| `src/localize/prune.ts` | `planPrune`, `pruneProvided`, requirement index, context check, reporting |
| `src/localize/ensure.ts` | `ensure`, `reinstall`, `checkOneCopy` |
| `src/localize/one-copy-hook.ts` | the preAction and its command set |
| `src/localize/index.ts` | programmatic API |
| `src/commands/localize.ts` | commander adapter (`--ensure`, `--reinstall`, `--no-prune`) |
| `src/cli.ts` | options, help text, `installOneCopyHook(program)` |
| `src/localized-dedupe.ts` | Vite dedupe over `providedPackages` |
| `src/installed-packages.ts` | `readInstalledPkgSync`; `appProvidedPackages` removed |
| `src/client-dep-includes.ts` | `DEFAULT_DENY` = `['typescript', 'react-native']` |
| `src/lifecycle.ts`, `src/cli-methods.ts` | read the manifest / exit codes through `localize/` |
| `docs/localize.md` | the user guide (moved from localize's README, rewritten) |
| `docs/reports/010-…` | localize's own report 001, kept as history |

## Public API

`@_linked/cli/localize/index.js` exports `localize`, `adopt`, `delocalize`, `list`, `collect`,
`relink`, `pruneProvided`, `satisfies`, `shouldPrune`, `providedPackages`, `ensure`, `reinstall`,
`checkOneCopy`, `resolvePackage`, `normalizeGitUrl`, `checkoutNameFor`, `readManifest`,
`writeManifest`, `manifestPath`, `MANIFEST_FILENAME`, `SCHEMA_VERSION`, `DEFAULT_DIR`,
`defaultDeps`, `makeRun`, `LocalizeError` and the `EXIT_*` codes, plus the types `PruneOptions`,
`PruneScope`, `Provided`, `ProvidedSkip`, `LocalizeOptions`, `ListRow`, `Resolved`, `Manifest`,
`ManifestEntry`, `Deps`, `Run`, `RunOptions`, `RunResult`.

CLI: `linked localize <pkg…> [--adopt] [--repo] [--subdir] [--dir] [--build <cmd>] [--force]
[--no-prune]`, `--list [--check]`, `--relink`, `--ensure` (no names — exit 2 with a pointer to
`--reinstall`; `--ensure --no-prune` is a no-op; always exits 0), `--reinstall <package>`;
`linked delocalize [pkg…] [--purge] [--force]`.

Removed in a minor: the `appProvidedPackages` / `providedByApp` exports and
`PruneOptions.provided` (the `@scope/*` match patterns and the peer-specific candidate rule).

## Review findings

| # | Sev | Finding | Resolution |
|---|---|---|---|
| R1 | high | The run-time check ignored prune's guard, so every copy prune keeps triggered a full prune that walked whole trees: 3.7–6.4 s per run command, removing nothing. | `planPrune` mirrors the guard; requirement index from the hidden lockfile; prune only runs on real removals. ~40 ms. |
| R2 | high | `--no-prune` could not be kept: the check always pruned. | Recorded as `prune: false`, honoured everywhere. |
| R3 | high | Pruning a dependency moved its own resolution into the app's context while the checkout kept its own copies of what failed the guard → a checkout's build failed on mixed React 18/19 types. | Keep on context change, `@types/` companion included. |
| R4 | medium | The client dependency scan picked up `react-native` from a localized checkout's devDependencies (Flow source esbuild cannot parse). | Added to `DEFAULT_DENY`; the app's own deny line removed. |
| R5 | medium | `--ensure` needed several runs to converge. | Fixed-point passes in one call. |
| R6 | medium | Candidates were pooled across owners, so one checkout's runtime dependency made another's devDependency a candidate. | Per-owner candidates. |
| R7 | medium | Untested: which commands fire the preAction, the realpath comparison for symlinked siblings, "kept copies don't re-walk". | `one-copy.test.ts` (below). |
| R8 | medium | Docs claimed `@_linked/localize` "is deprecated" (not yet) and told users to look for `kept …` after `--ensure` (which is silent); adopt printed 253 `kept …` lines. | One summary line per checkout; docs say "being retired"; point at `--list` / `--relink` / `--reinstall`. |

## Tests

`npm run test:unit`: 52 suites, **629 tests**. The localize suites (129 tests):
`commands` 16, `prune` 10, `semver` 47 (localize's table), `promises` 4, `adopt` 8, `ensure` 13,
`manifest` 8, `resolve` 10, `one-copy` 10, `real-localize` 3 (real clone and `npm install` from a
`file:` tarball, run with a scrubbed npm env). Also `localizeCommand` 20, `clientDepIncludes` 20,
`viteDedupe` 10 (unchanged and green).

- `ensure.test.ts`: rule parity against the previous `localizedDedupe` (kept verbatim as an
  oracle) on a fixture hitting every branch; ensure prunes after install, honours
  `{prune:false}`, throws on install failure; `--reinstall` routes through ensure; `checkOneCopy`
  prunes a planted duplicate in one line with a `run` that throws, is silent when clean, never
  throws; `--list` flags an unrecorded directory.
- `one-copy.test.ts`: the preAction fires for exactly `start`/`script`/`call`/`build-all`, and
  `cli.ts` installs it; a symlinked sibling is no hit; kept copies never reach `pruneProvided`
  (spy count 0) and read ≤3 dirs / <40 files over a 400-package tree, <500 ms; without a lockfile
  the index is built once and only when needed; context keep (peer React 18 vs 19); the `@types/`
  companion counts, the same version at another path does not; per-owner candidates; one call
  converges; `prune: false` recorded, honoured by check/relink/reinstall/`--list`, cleared by
  re-adopt, still a sibling for others.
- Mutation checks, each reverted: check always pruning, no context check, no `@types/` companion,
  pooled candidates, one pass, ignoring `prune: false`, walk instead of lockfile, paths compared
  without realpath, `DEFAULT_DENY` without react-native — each fails at least one test.

## Releases

- [linked-fw/cli#222](https://github.com/linked-fw/cli/pull/222) — merge, rule, `ensure`, run-time
  check, guide → **1.42.0** (1.43.x, from another change, includes it).
- [linked-fw/cli#228](https://github.com/linked-fw/cli/pull/228) — R1–R8 → **1.44.0**.
- [linked-fw/cli#230](https://github.com/linked-fw/cli/pull/230) — the plan's final log.

## Migrating a consuming app

1. Bump `@_linked/cli` to `^1.44.0` everywhere it is declared; the lockfile drops
   `@_linked/localize`.
2. Delete any hand-written `resolve.dedupe` list (the cli derives it) and any
   `clientDepIncludes: {deny: ['react-native']}` (now default).
3. Add `pre*` hooks for test and typecheck scripts: `"pretest:unit": "linked localize --ensure"`.
   `linked start`/`script`/`call`/`build-all` already run the check.
4. Delocalize `@_linked/localize` and remove its checkout.
5. Adopt every checkout in `packages-local/`: each on `main` = `origin/main`, version within the
   app's range, then `npx linked localize <name> --adopt`; `--list` should show no `UNRECORDED`
   rows. Validate with `npx linked build-all`, the typecheck, unit, integration and an e2e run, and
   look for "installed N times" in the server log.

Done in the reference app: 20 checkouts adopted; skipped one whose `main` is outside the app's
range and one with a `yarn.lock` (an in-checkout `npm install` would write an untracked lockfile).
Final validation: 27 packages built, typecheck clean, unit and integration green, no
"installed N times", one `@_linked/core`.

## Known limitations (low, left open)

- The preAction can prune the running cli's own checkout (narrow `ENOENT` risk mid-run).
- The install-time prune reads the registry copy of the package being localized; the global prune
  after linking corrects it.
- `providedPackages` and the app-copy lookup can disagree on the root for an app nested inside a
  workspace.
- With nothing localized, the derived Vite dedupe is React-only, so an app that relied on a hand
  list as a safety net for non-localized builds now relies on the server's duplicate warning.
- A `pretest:unit` hook does not cover a test runner's watch mode.
- `--ensure` is silent about kept copies; `--list` is where they are explained.

## Deferred

- **Retire `@_linked/localize`** (P9): publish 0.4.0 as a README pointer with a bin that prints
  "use `linked localize` (`@_linked/cli` ≥ 1.42.0)" and exits non-zero; `npm deprecate
  "@_linked/localize@*" "merged into @_linked/cli — use linked localize"`; archive
  `linked-fw/localize`. Not done — blocked on permissions. npm still shows 0.3.1, not deprecated.
- `@_linked/schema` and `@_linked/server` list `typescript` in `dependencies`, which accounts for
  21 of the kept copies; it belongs in devDependencies.
- `@types/node` 24 drift between checkouts and the app keeps further copies.
- `@_linked/schema` and `@_linked/sioc` use React without declaring the `react` peer; schema's
  React types should align to 19 regardless.

## Related documentation

- [`docs/localize.md`](../localize.md) — the user guide.
- [Report 010](010-localize-adopt-and-relink-reinstall.md) — `adopt` and the relink reinstall
  (written for `@_linked/localize` 0.2.0).
- [Report 007](007-localize-command.md) — the original `linked localize` command.
