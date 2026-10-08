---
summary: >
  Make "one copy of every package the app provides" an invariant that localize owns and that holds
  whenever the app runs — not only right after a localize command. Fixes nested duplicate copies in
  localized checkouts (core, React, siblings, localize itself) for every tool, not just Vite.
status: Implementation
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

## Implementation log

### Phase 1 — done

**Changes**

- `src/localize/{localize,adopt,delocalize,list,relink,prune,resolve,manifest,fsops,run,errors,index}.ts`:
  localize 0.3.1's `src/` ported as-is, with loose types (`Deps`, `ManifestEntry`, `Manifest`,
  `LocalizeOptions`, `PruneOptions`, `Resolved`, `ListRow`, exported from `index.ts`). Behaviour,
  exit codes 3–8, the `deps` seam and the `local-packages.json` schema are unchanged.
  `provided.ts` / `ensure.ts` are phase 2 and do not exist yet.
- `semver.js` is gone: `satisfies()` now lives in `prune.ts` over the npm `semver` package (already
  a cli dependency, 7.8.5), returning `null` ("cannot tell → keep the copy") when the version is not
  valid or `validRange` is null. All 47 rows of localize's semver table give the same answer.
- `commands/localize.ts` imports `../localize/index.js`; `cli-methods.ts` (`create-package`'s
  checkout naming and `EXIT_WARNED`) imports `./localize/index.js`; `lifecycle.localizedPackageNames`
  reads through `localize/manifest.readManifest` (the hand-copied manifest filename is gone).
- User-facing hints now say `linked localize <pkg> …`, `linked localize <pkg> --adopt`,
  `linked localize --list` instead of `linked-localize …`.
- `@_linked/localize` removed from `dependencies`; lockfile loses exactly the root dependency and
  the `node_modules/@_linked/localize` entry (an `npm@11.21.0 install --package-lock-only` — the npm
  CI pins via `packageManager` — produced a byte-identical lock).
- Tests: localize's 8 node:test suites + helpers + fixture ported to jest under
  `tests/unit/localize/`. `helpers.test()` wraps jest's `test` and hands the body a `t` whose
  `t.after()` collects cleanups run after the body, so bodies stayed as they were.
  `real-localize` (real clone + real `npm install`) runs in `test:unit` with a 120 s timeout — it
  takes a few seconds, so no slow/integration split was needed and CI runs it.
  `localizeCommand.test.ts` now mocks `../../src/localize/index`.

**Deviations**

- `promises.test`: the three assertions on the retired `linked-localize` bin (`--help`/`--version`,
  unknown option → exit 2) are dropped — `linked localize` is a commander command. Its two
  behavioural tests (silent `--list`, no-op `--relink` with no manifest) now run through
  `runLocalize`, the `linked localize` entry. localize: 108 tests; ported: 106.
- `localizedPackageNames` now skips a malformed manifest entry (one missing `path`/`branch`) the
  way localize itself does, where the hand-rolled reader listed every key. It warns nothing (a
  build plan is not the place); `linked localize --list` reports the entry.

**Validation**

- `npm run test:unit`: `Test Suites: 50 passed, 50 total` / `Tests: 595 passed, 595 total`
  (ported suites alone, with `localizeCommand`: `Test Suites: 9 passed` / `Tests: 123 passed`).
- `npm run test:e2e`: `1 failed` — `Error: Log message "/Started.*Server/" not received after
  60000ms` from testcontainers' Fuseki wait, before any cli code runs. CI does not run it
  (`run-e2e: false`).
- `npx linked build`: `✔ Build successful`; `lib/esm/localize/*` emitted; `@_linked/localize`
  appears in `lib/` only in two comments.
- Create Now (`@_linked/cli` → this checkout), with an ESM resolve hook logging every module URL
  containing "localize": `npx linked localize --list` → `2 linked · 0 not linked · 6 untracked link`,
  `npx linked localize --relink` → exit 0. Both resolved only `_linked-cli/lib/esm/localize/*` and
  `lib/esm/commands/localize.js` — never the checkout's nested `node_modules/@_linked/localize`
  nor `_linked-localize`. The relink, with the merged prune, then removed that nested copy itself:
  `[localize] packages-local/_linked-cli: removed its own copies of what the app provides —
  @_linked/core@2.25.0 (app: 2.26.0), @_linked/localize@0.3.0 (app: localized, 0.3.1)` (the
  bootstrap pitfall, resolved as predicted).

### Phase 2 — done

**Changes**

- `src/localize/provided.ts`: `providedPackages(appRoot, localizedNames?)` — P3's rule, synchronous
  (`readInstalledPkgSync`, new in `installed-packages.ts`, same walk as `readInstalledPkg`). Returns
  `{names, skipped, localized, dependencies}`; `skipped` is `{name, reason: 'range', asks, appVersion}`.
- `src/localized-dedupe.ts` consumes it and keeps only the Vite-only "a registry install nests its
  own copy" exclusion (applied to `dependencies`, never to a localized package or react/react-dom).
  Output shape unchanged; `viteDedupe.test.ts` untouched and green.
- `prune.ts`: candidates are `candidatesFor(entries)` = the rule over the entries being pruned plus
  every entry (sibling). The per-copy range guard and "cannot tell → keep" are unchanged. Gone:
  `PruneOptions.provided`, the `@scope/*` `matches` patterns, the peer-specific candidate rule,
  `appProvidedPackages` (`installed-packages.ts`) and `providedByApp` (`commands/localize.ts`);
  `pruneOptions()` is now `{prune}` only. `pruneProvided` takes an optional
  `scope {owners?, deps?}`.
- `src/localize/ensure.ts`: `ensure(entry, deps, opts)` (in-checkout `npm install`, then prune that
  checkout), `reinstall(name, opts, deps)` (`--reinstall`), `checkOneCopy(appRoot, deps)` (P4).
  `installLinkAndRecord` (localize + adopt) and relink's reinstall go through `ensure`.
- `src/cli.ts`: `linked localize --ensure` (exit 0) and `--reinstall <package>`; a `program.hook
  ('preAction')` runs `checkOneCopy(process.cwd())` before `start`, `script`, `call`, `build-all`.
  `--no-prune` help describes the new rule.
- `list.ts` (P8): a directory in the manifest's `dir` that no entry records and no untracked link
  points at is a row `UNRECORDED … directory not in local-packages.json`, counted in the summary;
  it does not fail `--check`.
- Tests: `tests/unit/localize/ensure.test.ts` (13): rule parity against the previous
  `localizedDedupe` (kept verbatim in the test as the oracle) on a fixture hitting every branch;
  ensure prunes after a stubbed install / `{prune:false}` / install failure; `--reinstall` routes
  through ensure; `checkOneCopy` prunes a planted duplicate in one line with a `run` that throws, is
  silent when clean, a no-op with no manifest, quiet when the guard keeps a copy, never throws;
  `--list` flags an unrecorded directory. `localizeCommand.test.ts`: `--ensure` / `--reinstall`
  routing; the `provided` expectations removed.

**Deviations**

- `ensure` is **synchronous** and returns `number` (the contract said `Promise<number>`): all of
  localize is `spawnSync` with sync exit-code entry points (`localize`, `adopt`, `relink`); an
  async `ensure` would turn those public APIs async for no gain. It **throws**
  `LocalizeError(EXIT_INSTALL_FAILED)` on a failed install so each caller adds its own context
  (localize: "nothing was linked"; relink: warn + "retry with `linked localize --reinstall <pkg>`");
  it returns `EXIT_WARNED` when only the prune failed. It takes a third `opts` (`--no-prune`) and
  reads the package name from the checkout's `package.json`.
- `providedPackages` takes an optional second argument (pruning passes the entries it prunes, so
  a checkout being localized counts before the manifest records it) and also returns `localized` /
  `dependencies` (the Vite consumer needs to know which names are a checkout's dependency).
- A name the rule **skips** (a localized range misses the app's version) is never removed, but a
  checkout that declares it and holds a copy still gets prune's "kept … Align the ranges" warning —
  that keeps the existing warning test and says out loud what the rule left out.
- `checkOneCopy` silences prune's per-checkout report and kept/drift warnings and prints only its
  own one line of removals: kept copies are reported by localize / relink / ensure, not on every
  `linked start`.
- devDependencies are no longer candidates (P3 is runtime fields only). `prune.test`'s "only
  candidates go … a bin is no exemption" now declares `@fw/cli` in `dependencies`.
- In localize's install step the prune now runs right after the install, before the build (D2:
  one step); the global prune over every checkout after linking stays.

**Validation**

- Housekeeping: `git diff --stat package-lock.json` → `Bin 466004 -> 464869 bytes`, and no
  changed line other than a `"libc"` field → restored with `git checkout -- package-lock.json`.
  The stray `packages-local/` and `local-packages.json` at the repo root are untouched and
  unstaged; jest's `roots` is `tests/unit` and the adapter test mocks `src/localize/index`, so no
  run reads them.
- `npm run test:unit`: `Test Suites: 51 passed, 51 total` / `Tests: 609 passed, 609 total`.
- Mutation check (each reverted): `checkOneCopy` comparing `realOrSelf(copy) === real` →
  `✕ checkOneCopy removes a planted duplicate, says so in ONE line, and never runs anything`;
  `ensure` without its prune → `✕ ensure installs inside the checkout, then prunes …` and
  `✕ --reinstall <pkg> goes through ensure …`; dedupe dropping a nested react-dom →
  `✕ rule parity: localizedDedupe gives exactly what it gave …`.
- `npx linked build`: `✔ Build successful`.
- preAction: a scratch app with a recorded checkout holding an older `@fw/core`, `linked
  build-all` → `[localize] one copy: removed packages-local/fw-a/node_modules/@fw/core@2.20.0 — the
  app provides it.` before the build output; a second run prints nothing extra.
- Create Now (cli localized), planted `@_linked/core` 2.26.0 in `packages-local/_linked-cli`,
  `npx linked localize --ensure` → exit 0, one line: `[localize] one copy: removed
  packages-local/_linked-cli/node_modules/@_linked/core@2.26.0, …/@tailwindcss/vite@4.3.3,
  …/@types/node@20.19.43, …/@types/react@19.3.0, …/@types/react-dom@19.3.0,
  …/@vitejs/plugin-react@4.7.0, …/colors@1.4.0, …/commander@11.1.0, …/copyfiles@2.4.1,
  …/create-esm-loader@0.2.5, …/depcheck@1.4.7, …/env-cmd@10.1.0, …/esbuild@0.28.2,
  …/find-nearest-package-json@2.0.1, …/fs-extra@11.4.1, …/glob@10.5.0, …/ora@8.2.0,
  …/require-extensions@0.0.4, …/rimraf@5.0.10, …/staged-git-files@1.3.0, …/tailwindcss@4.3.3,
  …/tsconfig-to-dual-package@1.2.0, …/typescript@5.9.3, …/typescript-plugin-css-modules@5.2.0,
  …/vite@6.4.3 — the app provides them.` The other 24 are D4's widening (runtime dependencies of a
  localized checkout the app has in range), never candidates before. Afterwards the cli checkout's
  `npm run test:unit` (609 passed) and `npx linked build` (`✔ Build successful`) still pass,
  resolving those from the app root.
- Clean `npx linked localize --ensure`: silent, exit 0; wall 1.68 / 1.22 / 1.25 s via `npx`,
  0.94 / 0.94 / 0.92 s via `node …/launch.js` — against 0.87 s for the cli to start and reject an
  unknown option, i.e. the cost is cli startup. `checkOneCopy` itself: 7.5 ms cold, then
  2.0 / 1.7 / 2.1 / 2.1 ms.
- `npx linked localize --list` → `2 linked · 0 not linked · 6 untracked link · 22 unrecorded
  directories` (`_linked-auth` … `_linked-xsd`, `semantu-cli`; Phase 7's adoption list).
