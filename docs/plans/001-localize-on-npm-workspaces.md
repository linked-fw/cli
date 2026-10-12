---
summary: >
  Rebuild `linked localize` on npm workspaces: the app commits `"packages-local/*"`, npm links and
  dedupes checkouts, a dependency-free hook shipped in the cli restores the committed lockfile so
  the working tree stays clean, and localize shrinks to clone/adopt/park/list plus a drift check.
  Pruning, relink, ensure, the provided rule and the localize Vite dedupe are removed. Spans this
  repo and Create Now.
status: Ideation
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
