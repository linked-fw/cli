/**
 * `linked localize` / `linked delocalize` — develop an npm dependency from a
 * git checkout.
 *
 * All of the work lives in `@_linked/localize`, which is dependency-free and
 * knows nothing about this framework on purpose: it resolves a package's
 * repository from the registry, clones it, installs inside the checkout and
 * symlinks it into `node_modules`, without touching `package.json` or
 * `package-lock.json`.
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
 */
import process from 'node:process';

/** The build command `localize` runs inside a fresh checkout by default. */
export const DEFAULT_BUILD_COMMAND = 'linked build';

export interface LocalizeCommandOptions {
  list?: boolean;
  check?: boolean;
  relink?: boolean;
  dir?: string;
  repo?: string;
  subdir?: string;
  build?: string;
  force?: boolean;
  purge?: boolean;
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
  const {defaultDeps, localize, list, relink} =
    await import('@_linked/localize');
  const deps = defaultDeps(process.cwd());

  if (options.relink) {
    process.exitCode = relink(deps);
    return;
  }
  if (options.list || packages.length === 0) {
    process.exitCode = list({check: options.check}, deps);
    return;
  }
  process.exitCode = localize(
    packages,
    {
      force: options.force,
      dir: options.dir,
      repo: options.repo,
      subdir: options.subdir,
      // `--build ''` is how you ask for no build at all.
      build:
        options.build === undefined ? DEFAULT_BUILD_COMMAND : options.build,
    },
    deps,
  );
}

/** `linked delocalize [packages...]` — unlink and forget; no names means all. */
export async function runDelocalize(
  packages: string[] = [],
  options: Pick<LocalizeCommandOptions, 'purge' | 'force'> = {},
): Promise<void> {
  const {defaultDeps, delocalize} = await import('@_linked/localize');
  const deps = defaultDeps(process.cwd());
  process.exitCode = delocalize(
    packages,
    {purge: options.purge, force: options.force},
    deps,
  );
}
