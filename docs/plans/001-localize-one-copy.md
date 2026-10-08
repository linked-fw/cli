---
summary: >
  Make "one copy of every package the app provides" an invariant that localize owns and that holds
  whenever the app runs — not only right after a localize command. Fixes nested duplicate copies in
  localized checkouts (core, React, siblings, localize itself) for every tool, not just Vite.
status: Ideation
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

## Open questions (ideation)

4. One "provided" rule: where it lives and who consumes it (prune, Vite dedupe, server duplicate
   warning).
5. Unrecorded checkouts in `packages-local/`: adopt, warn, or prune too?

## Test surfaces

- localize: (to confirm) its test command and suites.
- cli: `npm test` (jest).
- Create Now: `npm run typecheck:gate`, `npm run test:unit`, an integration boot (`project-config`)
  checking for "installed N times".
