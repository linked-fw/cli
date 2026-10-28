---
date: 2026-10-25
summary: >
  An agent worktree's `node_modules` is a link farm into the main checkout's install instead of
  one symlink: the `--with` packages link to the worktree's checkouts, so `tsc` and Node load them
  as Vite already did. New `linked worktree relink` rebuilds the farm and migrates old worktrees;
  hooks, localize and the Vite cache dir recognise the farm by its marker; `linked build` in a
  worktree passes `--preserveSymlinks` (no TS2742) and sets bin modes. Minor.
---

# 031 — Worktree `node_modules` as a link farm

## Why

`linked worktree add` symlinked `<wt>/node_modules` to the main checkout's. Vite loaded the
worktree's `packages-local/` checkouts through its workspace table (`doctor resolve`: `overlay`),
but `tsc` and Node followed the symlink to the main checkout's copies. Measured in a CN worktree
with a primitives worktree that adds `@_linked/primitives/components/RelativeTime`:
`npm run typecheck:gate` → 17 new `TS2307 Cannot find module '@_linked/primitives/components/RelativeTime'`.
Building the primitives worktree with `linked build` failed with `TS2742 The inferred type of 'Menu'
cannot be named without a reference to '../../../../../../create_now/node_modules/@radix-ui/react-context/dist'`.

## Design

Considered: (a) a link farm; (b) a generated `tsconfig` with `paths` (only `tsc`, and only for
scripts that name it); keeping the symlink and teaching every resolver. (a) is the only one that
fixes every resolver at once without an install, so:

- `<wt>/node_modules` is a real directory. Each entry links to the main checkout's entry of the same
  name; a package with a checkout in `<wt>/packages-local/` links to it, and its `@scope` becomes a
  real directory with per-entry links (other scopes stay one link). `.bin` is a real directory of
  the same relative links, so an overlay's bin is the worktree's. The hidden lockfile (npm would
  write through a link) and `.vite`/`.vite-temp`/`.cache` are left out.
- `node_modules/.linked-worktree.json` records `installRoot` and the overlays.
  `hooks/shared-install.cjs` reads it (or a symlinked `node_modules`), and is the one rule for the
  git hook's install skip, drift's lockfile root, `refuseSharedInstall` and `viteCacheDir`.
- The farm is built next to the old `node_modules` and swapped in by rename. A `node_modules` of
  the worktree's own is never replaced; removal uses `rm` without following links.
- Overlays are whatever `<wt>/packages-local/*/package.json` names, so `add`, `relink` and a
  package added by hand agree without stored state.
- With `tsc` following farm links to real paths in the main checkout, a declaration naming a hoisted
  transitive dependency has no portable path from the worktree. TypeScript only learns symlinked
  directories at package level, so a farm alone does not fix TS2742; `linked build` passes
  `--preserveSymlinks` when the package is inside a shared install, which emits the same
  `import("@radix-ui/react-context")` as the main checkout's build.
- npm sets the execute bit when it links a bin; the farm bypasses npm, and `linked build` rewrote
  `lib/` without it (`Permission denied` for `.bin/linked`). `linkNodeModules` and a new build step
  set it on the package's `bin` files.

## What changed

- `src/commands/worktree-node-modules.ts` (new): `planFarm` (pure), `readListing`, `overlaysOf`,
  `linkNodeModules`, `removeFarm`, `farmStaleness`, `worktreeLinkHints`.
- `src/commands/worktree.ts`: `add` makes the farm after the package worktrees; `remove` deletes it
  (and rebuilds it if `git worktree remove` fails); new `worktreeRelink`; `findAppWorktree` shared
  by `remove` and `relink`. `src/cli.ts`: `worktree relink [agent] [--dir]`, updated help.
- `hooks/shared-install.cjs` (new), `src/localize/shared-install.ts` (new: also
  `insideSharedInstall`, `tscFlagsFor`); `hooks/git-hook.cjs`, `hooks/drift.cjs`,
  `src/localize/localize.ts`, `src/vite-config.ts` use it.
- `src/utils/bin-modes.ts` (new); `src/cli-methods.ts`: "Marking bin files executable" step and
  `--preserveSymlinks` in the ESM/CJS compile.
- `src/commands/doctor.ts`: prints the relink hint (symlinked `node_modules` with overlays, or a stale farm).
- Docs: README, `docs/integration-branches-and-worktrees.md`, `docs/architecture/vite-runtime-config.md`.
- Tests: `tests/unit/worktreeNodeModules.test.ts` (new); farm cases in `worktree.test.ts`
  (add/remove/relink, migration, manual package, own install refused), `hooks.test.ts`,
  `drift.test.ts`, `viteCacheDir.test.ts`; `esmSpecifiers.test.ts` lists the new build step.

## Gate

On the CN worktree `wt/ontology-mgr` (primitives and cli worktrees), after `linked worktree relink`:

- `npm run typecheck:gate` → `No new type errors. 0 pre-existing errors still in the baseline.`
- `doctor resolve` → `@_linked/primitives  ontology-mgr/packages-local/_linked-primitives  ontology-mgr/packages-local/_linked-primitives  yes`
  (no flag), `@_linked/cli  external  ontology-mgr/packages-local/_linked-cli  no`, exit 0.
- `npx linked build` in the primitives worktree → `✔ Build successful`; `Menubar.d.ts` imports
  `import("@radix-ui/react-context")`, as the main checkout's build does.
- `npx vitest run src/features/document-studio/components/DocumentHistory.test.tsx` → `Tests  5 passed (5)`.
- Backend restarted on :4310: `/models/ontologies` → `200`, no `Cannot find module` in the log.
- The main checkout: `git status --short` empty, `node_modules` listing unchanged.
- `npm run test:unit` → all suites pass.

## Limitations

- A package installed in the main checkout that imports an overlaid package resolves it from its
  own real path, so it gets the main checkout's copy in Node and `tsc` (Vite gives it the worktree's).
- The app's own `packages/*` still link to the main checkout's (the worktree has no build of them)
  and show as `overlay`.
- A package the main checkout installs after the farm was made is missing until `relink`.
