---
summary: >
  Make "one copy of every package the app provides" an invariant that localize owns and that holds
  whenever the app runs — not only right after a localize command. Fixes nested duplicate copies in
  localized checkouts (core, React, siblings, localize itself) for every tool, not just Vite.
status: Tasks
repos: [cli, localize, create-now]
---

# 001 — Localize: one copy, always

## Context

`linked localize` clones or adopts a dependency into `packages-local/<scope-name>`, runs
`npm install` **inside the checkout** against the checkout's own lockfile, builds it, symlinks
`node_modules/<name>` at it, and records it in the gitignored `local-packages.json`. Since localize
0.3 it then prunes the checkout's own copies of what the app provides. The app's postinstall
`linked localize --relink` restores links after `npm install`.

It deliberately avoids workspaces, `npm link`, `file:` and `npm install <path>`: localizing must never
change a committed file (localize README; Create Now how-to "develop a linked package locally",
reports 055, 061, 071; deleted backlog 067). A workspace entry per developer leaks into the lockfile
and `npm ci` exits 0 on a dangling link; Create Now's Vite compiles anything in a workspace glob from
source; each package must stay releasable on its own lockfile.

### The problem

- Every `npm install` inside a checkout (localize's own install, relink's reinstall, a developer by
  hand) puts the checkout's own core / React / siblings / cli / localize back into its
  `node_modules`. Node resolves from the importer's real path, so the checkout loads those, not the
  app's. Pruning removes them, but only when a localize command runs; unrecorded checkouts are never
  pruned.
- Vite's `resolve.dedupe` hides this inside Vite only. `tsc` (82 type errors measured), plain Node,
  `tsx`, Jest and Vitest's externalized deps all see the duplicates (Create Now report 073,
  backlog 097).
- Bootstrap trap: the cli does `await import('@_linked/localize')` (`src/commands/localize.ts`),
  resolved from the cli's real path. A localized cli's own install brings the lockfile-pinned
  localize 0.3.0 (deprecated: published without the prune code), which can never prune itself.
- Version drift: the cli's lockfile pins localize 0.3.0; Create Now's lock pins cli 1.39.0 and
  localize 0.2.0 (no pruning) — a fresh clone gets no pruning.
- A false premise in the localize README / `localize.js`: a checkout's parent directories "contain no
  `node_modules`". Under `packages-local/` inside an app they do — a checkout only needs its own
  install for what the app does **not** provide.

### Chosen direction (architect)

Option A from the review: keep the filesystem model; make one-copy an invariant localize owns;
enforce it at run time; the cli loads localize from the app root; one derived "provided" rule.
Rejected: npm workspaces (breaks the no-committed-diff guarantee), resolve-time hooks only (do not
fix `tsc`/Jest/raw node).

## Accepted decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | **Merge localize into the cli** and deprecate `@_linked/localize` (pointing at `@_linked/cli`). Localize becomes a cli module; `linked localize` is the only entry; the `linked-localize` bin goes. | Removes the bootstrap / version-drift class entirely (no separately versioned copy to nest). One release; the "provided" rule, prune and Vite dedupe live together. Rejected: keep separate (fence, not fix); monorepo with two packages (adds tooling, keeps the nesting). |
| D2 | **Install, then prune, as one step (`ensure`).** Every checkout install goes through it: localize, relink's reinstall, and a new `linked localize --reinstall <pkg>` replacing a hand-run `npm install` in a checkout. | Reuses the shipped prune; copies exist only transiently. Rejected for now: peer-dependency convention + `--omit=peer` (fleet migration), temp-dir install (reimplements npm). |
| D3 | **Run commands enforce it.** `linked start`, `script`, `build-all` and the test entry points run a cheap check (any recorded checkout holding a package the app provides?) and prune with one line of output. The server's "installed N times" warning stays as the backstop. | Covers an in-checkout install and the postinstall `npm install <name>` skips. Safe to auto-fix: prune only removes copies the app provides at versions satisfying every range. Rejected: warn-only; status quo. |
| D4 | **One rule: the localized packages plus their dependencies that the app provides** — the derivation the cli's Vite config already uses (`src/localized-dedupe.ts`). Pruning and the run-time check use the same rule, scoped to localized packages only (no "every installed linked package" list). Create Now's hand-written `resolve.dedupe` (`vite.config.ts:148`, `[...linkedFrameworkDependencies, 'react', 'react-dom']`) is deleted. The server's duplicate warning stays as an independent cross-check. | One source of truth, already proven in Vite. Note: this widens prune's candidates from "siblings, peers, provided list" to every dependency of a localized checkout that the app provides — still guarded by "the app's version satisfies every range that resolves to that copy". Rejected: rule in core (couples runtime to tooling); hand-kept list in app config (how Create Now's drifted). |
| D5 | **Every checkout in `packages-local/` is localized.** The unrecorded `_linked-*` checkouts are a leftover of the old set-up; adopt them all (one-off migration step: each on `main` = `origin/main`, version compatible with the app's range, built), so `local-packages.json` lists everything in `packages-local/`. `linked localize --list` flags any directory in `packages-local/` without a record. | The architect's set-up intent; no half-converted state. Consequence: the app runs every checkout's source — the adoption step must verify versions and run the full validation. |

## Open questions (ideation)

None blocking. For plan mode: check that the derived Vite list covers everything Create Now's
hand list does today (`linkedFrameworkDependencies` + react/react-dom); confirm each leftover
checkout's version against the app's range before adopting.

## Test surfaces

- localize (to be merged): `node --test test/*.test.js` (`test:fast` skips `slow:`); its suites move into the cli.
- cli: `npm test` (jest).
- Create Now: `npm run typecheck:gate`, `npm run test:unit`, an integration boot (`project-config`)
  checking for "installed N times".

## Plan

### Plan-level decisions (from measured findings)

| # | Decision | Why |
|---|---|---|
| P1 | **D5 exception: `@_linked/localize` is retired, not adopted.** After the merge Create Now delocalizes it and the `_linked-localize` checkout is removed (its repo archived). | It stops being a dependency of anything. |
| P2 | **Semver: the npm `semver` package, with "cannot tell" semantics kept** — an unreadable range (`validRange` null) keeps the copy. localize's own `semver.js` subset goes. | One implementation; never prune on a range we can't read. |
| P3 | **The D4 rule = localized packages + their declared runtime dependencies (dependencies, peer, optional) that the app provides at a version satisfying every localized range, plus react/react-dom.** One function `providedPackages()` in `src/localize/provided.ts`. The "a registry install nests its own copy" exclusion (full `node_modules` walk) stays in the Vite consumer only. The candidate gap vs today's `appProvidedPackages` (a linked package hoisted in a checkout only transitively) is accepted: under D5 every linked package is localized, and the server's "installed N times" warning is the backstop. | One rule, cheap; prune's per-copy range guard still protects the checkout. |
| P4 | **Run-time check (D3) is stat-only**: for each recorded checkout and candidate, `existsSync(checkout/node_modules/<name>)` with a realpath different from the app's copy → prune (never runs npm), one line of output. Hooked via a commander `preAction` for `start`, `script`, `call`, `build-all`; exposed as `linked localize --ensure` for npm `pre*` scripts (the cli has no test command). | ~10–20 ms; no install on the hot path. |
| P5 | **`ensure(entry)` = `npm install` in the checkout, then prune with P3** — called from localize's install step, relink's reinstall and the new `linked localize --reinstall <pkg>`. | D2. |
| P6 | **Module layout:** `src/localize/{localize,adopt,delocalize,list,relink,prune,provided,ensure,resolve,manifest,fsops,run,errors,index}.ts`; `commands/localize.ts` stays the commander adapter; `lifecycle.localizedPackageNames` uses `localize/manifest` (one manifest reader). Exit codes 3–8, the `deps` seam `{appRoot, run, log, warn, error}` and the `local-packages.json` schema are kept as-is (public contract). User-facing hints `linked-localize …` → `linked localize …`. | Mechanical port; same contracts. |
| P7 | **Tests:** port the 8 node:test suites to jest under `tests/unit/localize/` (`test()` + `node:assert` work under jest; replace `t.after` with cleanup lists); `real-localize` (git clone + npm install from a `file:` tarball) gets a long timeout. `tests/unit/localizeCommand.test.ts` stops mocking `@_linked/localize`. | `require-tests: true` in cli CI. |
| P8 | **`--list` flags directories in `packages-local/` without a record** (D5 guard). | Keeps the converted state honest. |
| P9 | **Releases:** cli minor (changeset). Then localize 0.4.0 = README pointer + bin that prints "use `linked localize` (`@_linked/cli` ≥ <ver>)" and exits non-zero; `npm deprecate "@_linked/localize@*" "merged into @_linked/cli — use linked localize"`; archive `linked-fw/localize`. | D1. |
| P10 | **Create Now** (commits on its current shared branch, noted in its open PR): bump `@_linked/cli` to the new minor (lock drops localize 0.2.0); delete `resolve.dedupe` at `vite.config.ts:148` (keep `linkedFrameworkDependencies` for `optimizeDeps.exclude`); add `pretest:unit` / `pretypecheck:gate`-style hooks calling `linked localize --ensure`; delocalize `@_linked/localize` and remove the checkout; update `docs/how-to/develop-a-linked-package-locally.md` and `agents.md`. | Measured: deleting the hand dedupe loses nothing (react/react-dom are always added; dropped names have no duplicates). |
| P11 | **D5 adoption:** every remaining checkout → `main` = `origin/main` (fetch + ff), then `npx linked localize <name> --adopt`. Known flags: `_linked-server` must move off `fix/native-import-for-installed-backends` to main (≥2.24.2); `_linked-auth` fetch first (CN installs 3.0.2); `semantu-cli` (`@semantu/cli`) has a `yarn.lock` and no build script — adopt with `--build ''`, and if the in-checkout `npm install` would create an untracked `package-lock.json`, stop and report; `_linked-rdfs` is not installed at the app root (only nested under owl) — adopt anyway (prune then removes owl's nested copy). | The architect's set-up intent. |

### Contracts

```ts
// src/localize/provided.ts
providedPackages(appRoot: string): {names: string[]; skipped: {name: string; reason: string}[]}
// src/localize/ensure.ts
ensure(entry: ManifestEntry, deps: Deps): Promise<number>        // npm install + prune
checkOneCopy(appRoot: string, deps: Deps): {pruned: string[]}   // stat-only, used by preAction and --ensure
```
CLI: `linked localize --ensure` (check + prune, exit 0), `linked localize --reinstall <pkg>`, `--list` shows unrecorded directories.

### Pitfalls

- Bootstrap: until Create Now runs the merged cli, the cli checkout's nested localize 0.3.0 still loads — the first `ensure` with the merged cli prunes it.
- Open cli PR #214 touches `lifecycle.ts` (`readEnvNamesFromArgv`) — expect a small rebase.
- Never run npm from the preAction hook.
- Adopting ~20 checkouts makes Create Now run their source: build-all + full validation is part of the adoption phase.
- Another session works in the cli/localize/CN repos: stage and commit with `git commit --only -- <paths>`.

## Phases

Dependency graph: `1 → 2 → 3 → 4 (release) → {5 localize retire, 6 CN} → 7 (D5 adoption + validation)`. Sequential.

### Phase 1 — port localize into the cli (D1, P2, P6, P7)
- **Validation:** cli `npm test` (all suites incl. ported localize suites), `npx linked build`, `linked localize --list` / `--relink` smoke against Create Now (cli localized).
### Phase 2 — one rule, ensure, run-time check (D2–D4, P3–P5, P8)
- **Validation:** new unit tests (rule parity with `localizedDedupe`; ensure prunes after install; check is stat-only and prunes a planted duplicate; `--list` flags an unrecorded dir); `npm test`; Create Now smoke: plant a nested `@_linked/core` in a checkout → `linked start`/`--ensure` removes it.
### Phase 3 — docs, hints, changeset
- **Validation:** grep for `linked-localize` / `@_linked/localize` in cli src/docs → only intended mentions; changeset `minor`.
### Phase 4 — release the cli
- PR → checks → merge → release bot publishes; verify `npm view @_linked/cli version`.
### Phase 5 — retire `@_linked/localize` (P9)
- 0.4.0 pointer release, `npm deprecate`, archive repo. **Validation:** `npm view @_linked/localize deprecated`.
### Phase 6 — Create Now (P10)
- **Validation:** typecheck gate, `npm run test:unit`, integration boot with no "installed N times", `npm ls @_linked/localize` empty.
### Phase 7 — adopt every checkout (D5, P11) + full validation
- **Validation:** `linked localize --list` shows every directory recorded, none unrecorded; `npx linked build-all`; typecheck gate; `test:unit`; full integration; e2e relation-fields; no "installed N times".
