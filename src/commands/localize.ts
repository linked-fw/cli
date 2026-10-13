/**
 * `linked localize` / `linked delocalize` — develop an npm dependency from a
 * git checkout. The commander adapter over `../localize/`.
 *
 * A checkout lives in `packages-local/`, which the app lists in its
 * `workspaces` (`"packages-local/*"`), so npm links and dedupes it like any
 * workspace member; the committed lockfile is restored after every install by
 * the cli's `hooks/lock-at-rest.cjs`. localize clones (from the registry's
 * `repository`, or `--repo`/`--subdir`), adopts (`--adopt`), parks
 * (`delocalize`), takes back (`--parked`) and reports (`--list`, drift).
 *
 * Both commands act on the app root (app-root.ts): the topmost directory
 * whose `package.json` has `workspaces`, so running them inside a workspace
 * member still sets up and installs the app.
 *
 * Packages are named exactly as npm names them (`@_linked/rdfs`, `lodash`).
 * There is no short-name expansion and no org probing: a name that npm cannot
 * resolve is an error rather than a guess.
 *
 * `--relink` and `--ensure` are kept as no-ops that exit 0, so an app whose
 * `postinstall` or `pre*` scripts still call them keeps installing.
 */
import process from 'node:process';

import {findAppRoot} from '../localize/app-root.js';
import {
  adopt,
  defaultDeps,
  delocalize,
  list,
  localize,
  localizeParked,
} from '../localize/index.js';

export {DEFAULT_BUILD_COMMAND} from '../localize/index.js';

export interface LocalizeCommandOptions {
  adopt?: boolean;
  parked?: boolean;
  list?: boolean;
  check?: boolean;
  /** Deprecated: npm links checkouts now. Exits 0 with no output. */
  relink?: boolean;
  /** Deprecated: drift is reported before `linked start` and by `--list`. Exits 0 with one hint. */
  ensure?: boolean;
  dir?: string;
  repo?: string;
  subdir?: string;
  build?: string;
  force?: boolean;
  purge?: boolean;
}

/** What `--ensure` prints, once, on stderr. */
export const ENSURE_HINT =
  '[localize] --ensure is deprecated and does nothing: checkouts are workspace members, so npm ' +
  'dedupes them. Remove it from your scripts; `linked localize --list --check` reports drift.';

/**
 * `localize` reports failure through an exit code rather than by throwing, so
 * that a partial run still prints what it did. Mirror that: set `exitCode` and
 * return, instead of exiting, so pending output is flushed.
 */
export async function runLocalize(
  packages: string[] = [],
  options: LocalizeCommandOptions = {},
): Promise<void> {
  if (options.relink) {
    process.exitCode = 0;
    return;
  }
  if (options.ensure) {
    console.error(ENSURE_HINT);
    process.exitCode = 0;
    return;
  }
  const deps = defaultDeps(findAppRoot(process.cwd()));
  const usage = (message: string) => {
    console.error(`[localize] ${message}`);
    process.exitCode = 2;
  };
  if (options.adopt && packages.length === 0)
    return usage('--adopt needs at least one package name.');
  if (options.adopt && (options.subdir || options.repo))
    return usage(
      '--adopt takes no --repo or --subdir: an adopted checkout is used as it is.',
    );
  if (options.parked && (packages.length || options.adopt))
    return usage(
      '--parked takes back every parked checkout; it takes no package names.',
    );
  if (options.parked) {
    process.exitCode = localizeParked({dir: options.dir}, deps);
    return;
  }
  if (options.list || packages.length === 0) {
    process.exitCode = list({check: options.check}, deps);
    return;
  }
  // `--build ''` is how you ask for no build at all; absent means the default.
  const common = {dir: options.dir, build: options.build};
  if (options.adopt) {
    process.exitCode = adopt(packages, common, deps);
    return;
  }
  process.exitCode = localize(
    packages,
    {...common, repo: options.repo, subdir: options.subdir},
    deps,
  );
}

/**
 * Adopt one checkout that already sits in `packages-local/` under its localize
 * name: set the app up, install at the app root and build it. This is how
 * `create-package` hands a new package with its own repository to localize.
 *
 * @returns localize's exit code, rather than setting `process.exitCode`, so the
 *   caller decides what a failure means.
 */
export async function adoptPackage(
  name: string,
  options: {appRoot: string; build?: string},
): Promise<number> {
  // Exit codes are localize's public contract; EXIT_WARNED (5) is the one a
  // caller usually tolerates, meaning the build failed but the checkout is installed.
  return adopt([name], {build: options.build}, defaultDeps(options.appRoot));
}

/** `linked delocalize [packages...]` — park the checkouts; no names means all. */
export async function runDelocalize(
  packages: string[] = [],
  options: Pick<LocalizeCommandOptions, 'purge' | 'force'> = {},
): Promise<void> {
  const deps = defaultDeps(findAppRoot(process.cwd()));
  process.exitCode = delocalize(
    packages,
    {purge: options.purge, force: options.force},
    deps,
  );
}
