---
'@_linked/cli': minor
---

`linked localize` now builds on npm workspaces. A checkout in `packages-local/` is a workspace
member through the app's `"packages-local/*"` glob, so npm links it and dedupes everything below
it; nothing is installed inside a checkout, pruned or symlinked by hand any more. A lock-at-rest
hook keeps the committed `package-lock.json` clean while checkouts are linked, git hooks stop a
leaked lockfile from being committed, and a drift report says when the linked tree is not what
the app declares. The full guide is `docs/localize.md`.

**To adopt it**

1. Update `@_linked/cli`.
2. Run `npx linked localize <pkg>` once. Its first run sets the app up and prints what changed:
   `"packages-local/*"` in `workspaces`, `postinstall` and `dependencies` scripts that run the
   lock-at-rest hook, `packages-local/` and `.packages-local.parked/` in `.gitignore`, and the
   matching `package-lock.json`. Commit exactly those three files (`package.json`,
   `package-lock.json`, `.gitignore`); `git status` shows nothing else. An app that already has the
   earlier unguarded hook command is upgraded in place.
3. Remove `linked localize --ensure` from `pre*` scripts and `--relink` from `postinstall` (the
   set-up replaces it).
4. Migrating checkouts made by the old localize: delete `local-packages.json` and each checkout's
   own `node_modules`, then take them all in with one `npx linked localize <names…> --adopt`. See
   "Migrating from the old localize" in `docs/localize.md`.

The hook scripts run through a guard that does nothing where the cli is not installed, so
`npm ci --omit=dev` (Docker, production) is unaffected. `npm ci` itself refuses while checkouts are
present; use `npm install` then.

**Commands and flags**

- **Changed:** `linked delocalize [names…]` (no names: every checkout) now parks checkouts in
  `.packages-local.parked/` and reinstalls the registry copies itself;
  `linked localize <name>` or the new `linked localize --parked` takes them back. `--purge`
  deletes instead, and refuses unless the work is saved elsewhere: uncommitted changes, commits no
  remote has (on any branch or a detached `HEAD`), a stash, a checkout without `.git` or any
  failing git call all refuse; `--force` overrides.
- **New:** `--subdir` clones a monorepo whole into `packages-local/.repos/` and links the package
  inside it.
- **New:** `linked localize --list --check` prints only the drift and exits 1 when there is any,
  for CI.
- **Removed:** `--reinstall`, `--no-prune` and `localize --force`, with pruning and the Vite dedupe
  localize used to derive. `--dir` accepts only `packages-local` (exit 2 otherwise).
- **Deprecated:** `--relink` and `--ensure` do nothing and exit 0, so existing scripts keep
  installing. Remove them.
- `local-packages.json` is no longer read; the record is the directories in `packages-local/`.
- Every command acts on the app root: the nearest directory whose `package.json` has `workspaces`,
  climbing further only through ancestors whose globs match it. They work from inside a member, and
  a git worktree nested in the app stays its own app.

**Exit codes.** 1: `--list --check` found drift. 2: bad command line. 6: any guard refusal,
including a refused `--purge` (was 5) and an `overrides` key naming a localized package (npm
refuses those with `EOVERRIDE`; localize names the key and changes nothing). 7: `npm install` at
the app root failed. 3 (unusable record file) and 8 (manifests changed during the run) are retired
and not reused.

**Git hooks.** localize writes `pre-commit` (refuses a staged `package.json` or
`package-lock.json` that lists a checkout, and refuses when git cannot show what is staged) and
`post-merge`/`post-checkout` (`npm install` when the dependency manifests changed; nothing in a
work tree without checkouts). They work for an app below the git top level and in linked
worktrees (which share them; localize says so). Under `core.hooksPath` (husky) nothing is written:
localize prints the one line to add to each hook, which refuses wherever in the file it sits. A
hook file you wrote is left alone. A clone that has checkouts but no hooks gets a one-line notice
from lock-at-rest naming the command that writes them.

**Lock-at-rest.** After every install it restores the committed (or deliberately staged)
`package-lock.json`. While `package.json` differs from `HEAD` it leaves the lockfile alone and
warns that it must not be committed: change dependencies with `linked delocalize` first.

**Drift.** Reported by `--list`, by lock-at-rest after an install that changed the tree, and
before `start`, `script`, `call` and `build-all`: a range a checkout misses, a second copy of a
localized package, a nested copy of `@_linked/core`, `@_linked/react` or `@_linked/server-utils`,
and a checkout npm installed that is gone. It only reports, except under `--list --check`.

**`build-all`** builds the cli's own dependencies (a localized `@_linked/core`) first, then the
cli alone, then the rest; a localized cli builds with its own `npm run build`.

**Windows (written for it, not yet run there).** `npm`, `npx` and `.bin` shims start through one
helper (`node npm-cli.js` when npm started the cli, else the `.cmd` through `cmd.exe` with every
argument quoted), in the commands and in the `post-merge`/`post-checkout` hook. `--subdir` links
are junctions; files are imported by `file:` URL; POSIX-only shell use (`cd <dir> &&` chains,
`/dev/tty`, single-quoted strings, `chmod` in the cli's own build) is gone; edited
`package.json`, `.gitignore`, `.npmrc` and source files keep CRLF. README "Windows" lists what is
left.

**Removed deep imports** (reachable before through the `@_linked/cli/*` subpath exports; no known
consumer):

- `vite-config`: `localizedDedupe`;
- `utils/createPackageLocation`: `ensureRelinkPostinstall`, `ensureRelinkHooks`, `RELINK_COMMAND`;
- `installed-packages`: `readInstalledPkgSync`;
- `lifecycle`: `BuildToolOrder.buildToolFirst` (the type now has `pre` and `start`);
- `commands/localize`: `pruneOptions`;
- `localize/index`: `relink`, `pruneProvided`, `shouldPrune`, `providedPackages`, `ensure`,
  `reinstall`, `checkOneCopy`, `readManifest`, `writeManifest`, `manifestPath`,
  `MANIFEST_FILENAME`, `SCHEMA_VERSION`, `DEFAULT_DIR`, `EXIT_BAD_FILE`, `EXIT_MANIFEST_DIRTY`, and
  the types `Manifest`, `ManifestEntry`, `PruneOptions`, `PruneScope`, `Provided`, `ProvidedSkip`
  (`satisfies` stays, now drift's range check);
- `localize/localize`: `forEachName`, `installLinkAndRecord`, `guardForeignLink`, `declaredRange`,
  `assertManifestsUntouched`, and the types `OneName`, `OneResult`;
- `localize/fsops`: `linkTarget`, `writeLink`, `scanLinks`, `MANIFEST_FILES`,
  `snapshotManifests`, `diffManifests`, `isGitCheckout`;
- `localize/errors`: `EXIT_BAD_FILE`, `EXIT_MANIFEST_DIRTY`;
- whole modules: `localized-dedupe`, `utils/relinkHooks`, `localize/prune`, `localize/ensure`,
  `localize/relink`, `localize/provided`, `localize/manifest`, `localize/one-copy-hook`.
