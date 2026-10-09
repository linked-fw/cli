/**
 * `linked localize` / `linked delocalize` — develop an npm dependency from a
 * git checkout.
 *
 * All of the work lives in `../localize/` (once the separate
 * `@_linked/localize` package), which knows nothing about this framework on
 * purpose: it resolves a package's repository from the registry, clones it,
 * installs inside the checkout and symlinks it into `node_modules`, without
 * touching `package.json` or `package-lock.json`. This module is the commander
 * adapter over it.
 *
 * The one thing it deliberately does not know is how to build what it cloned.
 * That is the seam this module fills: `@_linked/cli` passes `build: 'linked
 * build'`, because in this ecosystem that is what building a package means.
 * A failing build only warns — a package whose build is broken is usually
 * exactly what you localized it to fix.
 *
 * Packages are named exactly as npm names them (`@_linked/rdfs`, `lodash`).
 * There is no short-name expansion and no org probing: the repository comes
 * from the registry's `repository` field, so a name that npm cannot resolve is
 * an error rather than a guess.
 *
 * A checkout's own install leaves its own copies of `@_linked/core`, React and
 * any localized sibling in its `node_modules`, and Node loads those instead of
 * the app's: a localized package then never sees a localized sibling, and core
 * loads once per copy. localize removes those copies by default wherever the
 * app's version satisfies the checkout's ranges (`--no-prune` turns it off for
 * that checkout, and is recorded so the run-time check honours it too).
 * What the app provides is one rule, `providedPackages` (localize/provided.ts),
 * shared with the run-time check (`--ensure`, and before `linked start` etc.)
 * and Vite's dedupe.
 *
 * `--adopt` is the exception to "clone from the registry": it links a git
 * checkout that is already in `packages-local/` under its localize name, with
 * no clone and no lookup — a package created locally, or a clone put there by
 * hand. It takes no `--subdir`: an adopted checkout is the package itself.
 */
import process from 'node:process';

import {
  adopt,
  checkOneCopy,
  defaultDeps,
  delocalize,
  list,
  localize,
  reinstall,
  relink,
} from '../localize/index.js';

/** The build command `localize` runs inside a fresh checkout by default. */
export const DEFAULT_BUILD_COMMAND = 'linked build';

export interface LocalizeCommandOptions {
  adopt?: boolean;
  list?: boolean;
  check?: boolean;
  relink?: boolean;
  /** Check every checkout for a copy of what the app provides and prune it; exit 0. No names. */
  ensure?: boolean;
  /** `npm install` in this package's checkout, then prune it. */
  reinstall?: string;
  dir?: string;
  repo?: string;
  subdir?: string;
  build?: string;
  force?: boolean;
  purge?: boolean;
  /** Commander's `--no-prune` sets this to false; absent means on. */
  prune?: boolean;
}

/** localize's prune options for a run: on unless explicitly turned off. */
export function pruneOptions(prune: boolean | undefined = true): {
  prune: boolean;
} {
  return {prune: prune !== false};
}

/**
 * `localize` reports failure through an exit code rather than by throwing, so
 * that a partial run still prints what it did. Mirror that: set `exitCode` and
 * return, instead of exiting, so pending output is flushed.
 */
export async function runLocalize(
  packages: string[] = [],
  options: LocalizeCommandOptions = {},
): Promise<void> {
  const deps = defaultDeps(process.cwd());
  const prune = pruneOptions(options.prune);

  if (options.relink) {
    process.exitCode = relink(deps, prune);
    return;
  }
  if (options.ensure) {
    if (packages.length) {
      // A name would read as "check only these", which it is not: say so
      // rather than ignore it.
      console.error(
        '[localize] --ensure takes no package names: it checks every recorded checkout ' +
          '(one localized with --no-prune is skipped). To reinstall one checkout and prune it: ' +
          '`linked localize --reinstall <package>`.',
      );
      process.exitCode = 2;
      return;
    }
    // `--ensure --no-prune` asks for nothing: a no-op, so a script can turn
    // the check off without removing the hook.
    if (prune.prune) checkOneCopy(deps.appRoot, deps);
    // Run from an app's npm `pre*` scripts, so it never fails the script it
    // guards (`checkOneCopy` never throws; it warns instead).
    process.exitCode = 0;
    return;
  }
  if (options.reinstall) {
    process.exitCode = reinstall(options.reinstall, prune, deps);
    return;
  }
  if (options.adopt && packages.length === 0) {
    console.error('[localize] --adopt needs at least one package name.');
    process.exitCode = 2;
    return;
  }
  if (options.adopt && options.subdir) {
    console.error(
      '[localize] --adopt takes no --subdir: an adopted checkout is the package itself.',
    );
    process.exitCode = 2;
    return;
  }
  if (options.list || packages.length === 0) {
    process.exitCode = list({check: options.check}, deps);
    return;
  }
  // `--build ''` is how you ask for no build at all.
  const build =
    options.build === undefined ? DEFAULT_BUILD_COMMAND : options.build;
  if (options.adopt) {
    process.exitCode = adopt(
      packages,
      {
        force: options.force,
        dir: options.dir,
        repo: options.repo,
        build,
        ...prune,
      },
      deps,
    );
    return;
  }
  process.exitCode = localize(
    packages,
    {
      force: options.force,
      dir: options.dir,
      repo: options.repo,
      subdir: options.subdir,
      build,
      ...prune,
    },
    deps,
  );
}

/**
 * Adopt one checkout that already sits in `packages-local/` under its localize
 * name: install inside it, build it, link it and record it. This is how
 * `create-package` hands a new package with its own repository to localize.
 *
 * @returns localize's exit code, rather than setting `process.exitCode`, so the
 *   caller decides what a failure means.
 */
export async function adoptPackage(
  name: string,
  options: {appRoot: string; build: string; repo?: string},
): Promise<number> {
  // Exit codes are localize's public contract; EXIT_WARNED (5) is the one a
  // caller usually tolerates, meaning the build failed but the link is in place.
  return adopt(
    [name],
    {
      build: options.build,
      repo: options.repo,
      ...pruneOptions(),
    },
    defaultDeps(options.appRoot),
  );
}

/** `linked delocalize [packages...]` — unlink and forget; no names means all. */
export async function runDelocalize(
  packages: string[] = [],
  options: Pick<LocalizeCommandOptions, 'purge' | 'force'> = {},
): Promise<void> {
  const deps = defaultDeps(process.cwd());
  process.exitCode = delocalize(
    packages,
    {purge: options.purge, force: options.force},
    deps,
  );
}
