/**
 * `--adopt` and `--parked` -- the localize run for checkouts that need no
 * clone.
 *
 * `adopt` takes a checkout that is ALREADY in `packages-local/` -- a package
 * created locally and never published (`create-package --location
 * packages-local`), or a clone put there by hand -- and runs the rest of
 * localize on it: app setup, git hooks, the root `npm install`, its build. No
 * registry lookup, no clone, no pull. It is found by its name among the
 * members, else at `packages-local/<checkoutName>`, so `localize` and `adopt`
 * agree about where a package lives.
 *
 * `localizeParked` takes back every checkout `linked delocalize` parked.
 */
import fs from 'node:fs';
import path from 'node:path';

import {EXIT_REFUSED, LocalizeError} from './errors.js';
import {checkoutRepoRoot, readJson} from './fsops.js';
import {runLocalize, unpark} from './localize.js';
import type {LocalizeOptions, Prepared} from './localize.js';
import {LOCAL_DIR, localMembers, parkedMembers} from './members.js';
import {checkoutNameFor} from './resolve.js';
import type {Deps} from './run.js';

/**
 * @param names  full npm package names
 * @returns the process exit code, as `localize` returns it.
 */
export function adopt(
  names: string[],
  opts: Pick<LocalizeOptions, 'dir' | 'build'>,
  deps: Deps,
): number {
  return runLocalize(names, opts, deps, prepareAdopt);
}

/** Move every parked checkout back, then one install. No builds: each is as it was. */
export function localizeParked(
  opts: Pick<LocalizeOptions, 'dir'>,
  deps: Deps,
): number {
  const names = parkedMembers(deps.appRoot).map((m) => m.name);
  if (!names.length) {
    deps.log('[localize] nothing is parked.');
    return 0;
  }
  return runLocalize(names, opts, deps, (name) => {
    const parked = parkedMembers(deps.appRoot).find((m) => m.name === name);
    return parked ? unpark(parked, deps) : null;
  });
}

function prepareAdopt(
  name: string,
  _opts: LocalizeOptions,
  deps: Deps,
): Prepared {
  const member = localMembers(deps.appRoot).find((m) => m.name === name);
  const relDir = member?.dir ?? `${LOCAL_DIR}/${checkoutNameFor(name)}`;
  const pkgDir = path.join(deps.appRoot, relDir);

  if (!fs.existsSync(pkgDir)) {
    const parked = parkedMembers(deps.appRoot).some((m) => m.name === name);
    throw new LocalizeError(
      `there is nothing to adopt at ${relDir}.\n` +
        (parked
          ? `${name} is parked. To take it back:\n  linked localize ${name}`
          : `adopt installs a checkout that is already there. To clone a published package instead:\n` +
            `  linked localize ${name}`),
      EXIT_REFUSED,
    );
  }
  if (!checkoutRepoRoot(pkgDir, deps.appRoot)) {
    throw new LocalizeError(
      `${relDir} is not a git checkout. Run \`git init\` in it first -- a checkout in ` +
        `${LOCAL_DIR}/ is its own repository, never part of the app's.`,
      EXIT_REFUSED,
    );
  }

  const declared = readJson(path.join(pkgDir, 'package.json'))?.name;
  if (declared !== name) {
    throw new LocalizeError(
      declared
        ? `${relDir} declares itself as "${declared}", not "${name}".`
        : `${relDir} has no package.json naming it, so it is not the package "${name}".`,
      EXIT_REFUSED,
    );
  }

  deps.log(`[localize] adopting ${relDir}`);
  return {name, dir: relDir, build: true};
}
