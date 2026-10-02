import fs from 'fs';
import path from 'path';

/**
 * Where `linked create-package` puts a new package, decided without touching
 * anything — the IO lives in `createPackage`.
 *
 * Inside an app there are two homes, and they mean different things:
 *
 * - `packages/` — the package is part of the app's own repository: a tracked
 *   npm workspace member, declared as a dependency like any other.
 * - `packages-local/` — the package has a repository of its own. It goes where
 *   `linked localize` keeps checkouts, under the same name localize would give
 *   it (`@_linked/foo` → `packages-local/_linked-foo`), and is handed to
 *   localize's `adopt`, so the two can never disagree about it.
 */

export const PACKAGE_LOCATIONS = ['packages', 'packages-local'] as const;
export type PackageLocation = (typeof PACKAGE_LOCATIONS)[number];

export interface CreatePackageOptions {
  location?: string;
  /** A git URL. Implies `packages-local`. */
  remote?: string;
  /** Push the initial commit. Needs `remote`. */
  push?: boolean;
}

export type TargetDecision =
  /** No app above us: the old behaviour, unchanged. */
  | {kind: 'outside'}
  | {kind: 'resolved'; location: PackageLocation; remote?: string; push: boolean}
  /** Inside an app, no flags, on a terminal: ask. */
  | {kind: 'ask'}
  | {kind: 'refuse'; message: string};

/** A refusal of create-package's own, as opposed to a crash. */
export class CreatePackageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CreatePackageError';
  }
}

/**
 * The nearest directory, from `start` upwards, whose package.json says
 * `linkedApp: true`. That is the app — whether or not it has `workspaces`,
 * which the app template does not.
 */
export function findLinkedAppRoot(start: string): string | null {
  let dir = path.resolve(start);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const pkg = JSON.parse(
        fs.readFileSync(path.join(dir, 'package.json'), 'utf8'),
      );
      if (pkg?.linkedApp === true) return dir;
    } catch {
      // no package.json here, or not one we can read: keep walking
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Flags decide everything they can. Any of `--location`, `--remote` or
 * `--push` is taken as the complete answer, so a scripted call never meets a
 * prompt; with none of them, a terminal is asked and anything else is refused.
 */
export function decideCreatePackageTarget({
  appRoot,
  options,
  isTTY,
}: {
  appRoot: string | null;
  options: CreatePackageOptions;
  isTTY: boolean;
}): TargetDecision {
  const {location, remote, push = false} = options;
  const given = location !== undefined || remote !== undefined || push;

  if (location !== undefined && !isPackageLocation(location)) {
    return refuse(
      `--location must be one of ${PACKAGE_LOCATIONS.join(', ')}, not "${location}".`,
    );
  }
  if (!appRoot) {
    return given
      ? refuse(
          `--location, --remote and --push only apply inside a linked app, and no package.json ` +
            `with "linkedApp": true was found above this directory.`,
        )
      : {kind: 'outside'};
  }
  if (push && !remote) {
    return refuse('--push needs --remote: there is nowhere to push to.');
  }
  if (remote && location === 'packages') {
    return refuse(
      `--remote gives the package a repository of its own, but packages/ is for packages that ` +
        `live in the app's repository. Use --location packages-local, or drop --remote.`,
    );
  }
  if (given) {
    return {
      kind: 'resolved',
      location: (location as PackageLocation) ?? 'packages-local',
      ...(remote ? {remote} : {}),
      push,
    };
  }
  if (isTTY) return {kind: 'ask'};
  return refuse(
    `Where should the package go? Pass --location packages (part of this app's repository) or ` +
      `--location packages-local (its own repository, optionally with --remote <git-url>).`,
  );
}

export function isPackageLocation(value: string): value is PackageLocation {
  return (PACKAGE_LOCATIONS as readonly string[]).includes(value);
}

function refuse(message: string): TargetDecision {
  return {kind: 'refuse', message};
}

/** `@scope/foo-bar` → `foo-bar`: the folder name under `packages/`. */
export function bareName(name: string): string {
  return name.match(/(@[\w\-]+\/)?([\w\-]+)/)[2];
}

/**
 * Make sure the app's `workspaces` covers `packages/*`, so a package created
 * there is a workspace member. Mutates `pkg`.
 *
 * @returns whether it changed, and a warning when it cannot tell.
 */
export function ensureWorkspaceGlob(pkg: Record<string, any>): {
  changed: boolean;
  warning?: string;
} {
  const covers = (globs: unknown[]) =>
    globs.some((g) => g === 'packages/*' || g === 'packages/**');

  if (pkg.workspaces === undefined) {
    pkg.workspaces = ['packages/*'];
    return {changed: true};
  }
  const globs = Array.isArray(pkg.workspaces)
    ? pkg.workspaces
    : Array.isArray(pkg.workspaces?.packages)
      ? pkg.workspaces.packages
      : null;
  if (!globs) {
    return {
      changed: false,
      warning: `the app's "workspaces" field has a shape this command does not edit; make sure it covers packages/*.`,
    };
  }
  if (covers(globs)) return {changed: false};
  globs.push('packages/*');
  return {changed: true};
}

export const RELINK_COMMAND = 'linked localize --relink';

/**
 * Make sure the app's `postinstall` recreates localize's links. Without it the
 * next `npm install` prunes a packages-local link as extraneous. With no
 * `local-packages.json` the hook prints nothing and exits 0, so it is safe to
 * commit for everyone. Mutates `pkg`.
 */
export function ensureRelinkPostinstall(pkg: Record<string, any>): boolean {
  pkg.scripts = pkg.scripts ?? {};
  const current: string | undefined = pkg.scripts.postinstall;
  if (current && /localize\s+--relink/.test(current)) return false;
  pkg.scripts.postinstall = current
    ? `${current} && ${RELINK_COMMAND}`
    : RELINK_COMMAND;
  return true;
}

/**
 * A git remote as npm wants it in `repository.url`: `git+https://…`, or
 * `git+ssh://git@host/path` for the scp-like `git@host:path` form.
 */
export function repositoryUrlFor(remote: string): string {
  const url = remote.trim();
  if (url.startsWith('git+')) return url;
  const scp = /^([\w.-]+@[\w.-]+):(?!\/)(.+)$/.exec(url);
  if (scp) return `git+ssh://${scp[1]}/${scp[2]}`;
  if (/^(https?|ssh):\/\//.test(url)) return `git+${url}`;
  return url;
}
