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
 *
 * The other framework knowledge it supplies is what an app PROVIDES. A
 * checkout's own install leaves its own copies of `@_linked/core`, React and
 * any localized sibling in its `node_modules`, and Node loads those instead of
 * the app's: a localized package then never sees a localized sibling, and core
 * loads once per copy. `pruneProvided` (on by default here, `--no-prune-provided`
 * turns it off) has localize remove those copies wherever the app's version
 * satisfies the checkout's range; see `PROVIDED_BY_APP`.
 *
 * `--adopt` is the exception to "clone from the registry": it links a git
 * checkout that is already in `packages-local/` under its localize name, with
 * no clone and no lookup — a package created locally, or a clone put there by
 * hand. It takes no `--subdir`: an adopted checkout is the package itself.
 */
import process from 'node:process';

/** The build command `localize` runs inside a fresh checkout by default. */
export const DEFAULT_BUILD_COMMAND = 'linked build';

/**
 * What a linked app provides to its localized checkouts: every framework
 * package, and React. Each one either holds module-level state that must
 * exist once (core's shape registry, React's dispatcher, the context objects
 * in server-utils and react) or is a localized sibling the checkout should
 * reach live. localize itself also treats every localized sibling and a
 * checkout's peerDependencies as provided, and never removes a package that
 * declares a `bin`, so `@_linked/cli` in a checkout's devDependencies stays.
 */
export const PROVIDED_BY_APP = ['@_linked/*', 'react', 'react-dom'];

export interface LocalizeCommandOptions {
  adopt?: boolean;
  list?: boolean;
  check?: boolean;
  relink?: boolean;
  dir?: string;
  repo?: string;
  subdir?: string;
  build?: string;
  force?: boolean;
  purge?: boolean;
  /** Commander's `--no-prune-provided` sets this to false; absent means on. */
  pruneProvided?: boolean;
}

/** localize's prune options for a run: on unless explicitly turned off. */
export function pruneOptions(pruneProvided: boolean | undefined = true): {
  pruneProvided: boolean;
  provided: string[];
} {
  return {pruneProvided: pruneProvided !== false, provided: PROVIDED_BY_APP};
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
  const {defaultDeps, localize, adopt, list, relink} =
    await import('@_linked/localize');
  const deps = defaultDeps(process.cwd());
  const prune = pruneOptions(options.pruneProvided);

  if (options.relink) {
    process.exitCode = relink(deps, prune);
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
  const {defaultDeps, adopt} = await import('@_linked/localize');
  // Exit codes are localize's public contract; EXIT_WARNED (5) is the one a
  // caller usually tolerates, meaning the build failed but the link is in place.
  return adopt(
    [name],
    {build: options.build, repo: options.repo, ...pruneOptions()},
    defaultDeps(options.appRoot),
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
