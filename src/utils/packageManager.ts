import fs from 'fs';
import path from 'path';

export type DetectedPackageManager = 'npm' | 'yarn';

/** Files that mark a directory as the root of a yarn project. */
const YARN_MARKERS = ['yarn.lock', '.yarnrc.yml', '.yarnrc'];
/** Files that mark a directory as the root of an npm project. */
const NPM_MARKERS = ['package-lock.json', 'npm-shrinkwrap.json'];

/**
 * Work out which package manager owns the project that `startDir` lives in.
 *
 * npm is the default: every scaffold the CLI produces is an npm project, and
 * plain `npm`/`npx` is the only thing guaranteed to be on PATH next to node.
 * yarn is only used when the tree actually says so — a `yarn.lock`,
 * `.yarnrc.yml` or a vendored `.yarn/releases/` in this directory or an
 * ancestor. That keeps existing yarn monorepos (create_now pins yarn 3.6.1)
 * working without assuming yarn anywhere else.
 *
 * The nearest marker wins, so an npm package checked out inside a yarn
 * workspace still builds with npm.
 *
 * @param exists injectable for tests; defaults to `fs.existsSync`.
 */
export function detectPackageManager(
  startDir: string = process.cwd(),
  exists: (p: string) => boolean = fs.existsSync,
): DetectedPackageManager {
  let dir = path.resolve(startDir);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (NPM_MARKERS.some((m) => exists(path.join(dir, m)))) return 'npm';
    if (YARN_MARKERS.some((m) => exists(path.join(dir, m)))) return 'yarn';
    if (exists(path.join(dir, '.yarn', 'releases'))) return 'yarn';
    const parent = path.dirname(dir);
    if (parent === dir) return 'npm';
    dir = parent;
  }
}

/** The command that runs a package.json script with `pm`. */
export function runScriptCommand(
  pm: DetectedPackageManager,
  script: string,
): string {
  return pm === 'yarn' ? `yarn ${script}` : `npm run ${script}`;
}

/** The command that runs a locally installed binary with `pm`. */
export function execBinCommand(
  pm: DetectedPackageManager,
  binAndArgs: string,
): string {
  return pm === 'yarn'
    ? `yarn exec ${binAndArgs}`
    : `npx --no-install ${binAndArgs}`;
}
