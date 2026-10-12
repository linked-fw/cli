---
'@_linked/cli': minor
---

`linked localize` now builds on npm workspaces. A checkout in `packages-local/` is a workspace
member through the app's `"packages-local/*"` glob, so npm links and dedupes it; the app's
`postinstall` and `dependencies` scripts run `node node_modules/@_linked/cli/hooks/lock-at-rest.cjs`
(shipped in this package), which restores the committed `package-lock.json` after every install so
the working tree stays clean. `linked localize` also writes git hooks into the clone (`pre-commit`
refuses a manifest that names a checkout; `post-merge`/`post-checkout` run `npm install` when
dependencies changed) and reports drift (a range a checkout misses, a second copy of a localized
package, a nested copy of `@_linked/core`/`react`/`server-utils`, a missing checkout) from
`--list`, `--list --check` (exit 1) and before `start`/`script`/`call`/`build-all`.

- **Required app set-up.** The first `linked localize` adds the glob, the two hook scripts and
  `packages-local/`, `.packages-local.parked/` to `.gitignore`, and prints what it changed. Commit it
  with a lockfile from an install with no checkout present: `linked delocalize`, `npm install`,
  commit, `linked localize --parked`. An `overrides` key naming a localized package is refused
  (exit 6). See `docs/localize.md`.
- **New:** `linked delocalize` parks checkouts in `.packages-local.parked/` (`--purge` deletes);
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
