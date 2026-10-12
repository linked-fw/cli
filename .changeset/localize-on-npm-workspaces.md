---
'@_linked/cli': minor
---

`linked localize` now builds on npm workspaces. A checkout in `packages-local/` is a workspace
member through the app's `"packages-local/*"` glob, so npm links and dedupes it; the app's
`postinstall` and `dependencies` scripts run the lock-at-rest hook (`hooks/lock-at-rest.cjs`,
shipped in this package) through a guard that does nothing where the cli is not installed
(`npm ci --omit=dev`):
`node -e "const p='node_modules/@_linked/cli/hooks/lock-at-rest.cjs';require('fs').existsSync(p)&&require(require('path').resolve(p))"`.
It restores the committed (or staged) `package-lock.json` after every install so the working tree
stays clean. `linked localize` also writes git hooks into the clone (`pre-commit`
refuses a manifest that names a checkout; `post-merge`/`post-checkout` run `npm install` when
dependencies changed) and reports drift (a range a checkout misses, a second copy of a localized
package, a nested copy of `@_linked/core`/`react`/`server-utils`, a missing checkout) from
`--list`, `--list --check` (exit 1), after an install that changed the tree (lock-at-rest) and
before `start`/`script`/`call`/`build-all`.

- **Required app set-up.** The first `linked localize` adds the glob, the two hook scripts and
  `packages-local/`, `.packages-local.parked/` to `.gitignore`, makes the matching lockfile
  (`npm install --package-lock-only` before anything is cloned, written back after the install) and
  prints what to commit: `git status` shows exactly `package.json`, `package-lock.json` and
  `.gitignore`. An app set up with the earlier unguarded hook command is upgraded. An `overrides`
  key naming a localized package is refused (exit 6). See `docs/localize.md`.
- **App root.** `localize`, `delocalize`, `--list` and the drift report act on the topmost
  directory whose `package.json` has `workspaces`, so they work from inside a member.
- **Git hooks** follow the app below the git top level, and under `core.hooksPath` (husky) nothing
  is written: localize prints the line to add to each hook. In a linked worktree it warns that the
  hooks are shared; they act only in a work tree with checkouts.
- **New:** `linked delocalize` parks checkouts in `.packages-local.parked/` (`--purge` deletes, and
  refuses with exit 6 -- was 5 -- on uncommitted changes, commits on any branch no remote has, a
  stash, a checkout without `.git` or any failing git call; `--force` overrides);
  `linked localize <name>` or `--parked` takes them back. `--subdir` clones monorepos into
  `packages-local/.repos/`.
- **Removed:** `--reinstall`, `--no-prune` and `localize --force`, together with pruning and the
  localize-derived Vite dedupe. `--dir` accepts only `packages-local`.
- **Deprecated:** `--relink` and `--ensure` do nothing and exit 0, so existing scripts keep working;
  remove them.
- **`local-packages.json` is no longer read**; the record is the directories in `packages-local/`.
  Delete it, and each checkout's own `node_modules`, when migrating.
- **`build-all`** builds the cli's own dependencies (a localized `@_linked/core`) before the cli,
  then the cli alone, then the rest; a localized cli builds with its own `npm run build`.
- **Removed deep imports** (reachable before through the `@_linked/cli/*` subpath exports; no
  known consumer):
  - `vite-config`: `localizedDedupe`;
  - `utils/createPackageLocation`: `ensureRelinkPostinstall`, `ensureRelinkHooks`,
    `RELINK_COMMAND`;
  - `installed-packages`: `readInstalledPkgSync`;
  - `lifecycle`: `BuildToolOrder.buildToolFirst` is gone (the type now has `pre` and `start`);
  - `localize/index`: `relink`, `pruneProvided`, `shouldPrune`, `providedPackages`, `ensure`,
    `reinstall`, `checkOneCopy`, `readManifest`, `writeManifest`, `manifestPath`,
    `MANIFEST_FILENAME`, `SCHEMA_VERSION`, `DEFAULT_DIR`, `EXIT_BAD_FILE`, `EXIT_MANIFEST_DIRTY`,
    and the types `Manifest`, `ManifestEntry`, `PruneOptions`, `PruneScope`, `Provided`,
    `ProvidedSkip`;
  - whole modules: `localized-dedupe`, `utils/relinkHooks`, `localize/prune`, `localize/ensure`,
    `localize/relink`, `localize/provided`, `localize/manifest`, `localize/one-copy-hook`.
