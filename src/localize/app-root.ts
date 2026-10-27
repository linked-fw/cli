/**
 * Which directory is the app: the one whose `package.json` lists the
 * workspaces, wherever in it a command runs. `linked localize` run inside
 * `packages/foo` must set up and install the app, not the member; `build-all`
 * plans from the same root.
 *
 * Only a directory that is a workspace of the one above it belongs to it. A
 * git worktree nested in an app (`<app>/.claude/worktrees/<wt>`) has its own
 * `package.json` with `workspaces`, and none of the app's globs match it: it
 * is its own app, and a command run there must not act on the main checkout.
 */
import fs from 'node:fs';
import path from 'node:path';

import {readJson} from './fsops.js';
import {requireHook} from './hook-module.js';
import {isLinkedPackageJson} from '../installed-packages.js';

interface ManifestsModule {
  workspaceGlobs: (appRoot: string) => string[] | null;
  globsMatch: (globs: string[], rel: string) => boolean;
}

let manifests: ManifestsModule | undefined;

/** `hooks/manifests.cjs`: the glob matching the hooks use, loaded on first use. */
function manifestsModule(): ManifestsModule {
  manifests ??= requireHook<ManifestsModule>(
    'manifests.cjs',
    (mod) =>
      typeof mod.workspaceGlobs === 'function' &&
      typeof mod.globsMatch === 'function',
  );
  return manifests;
}

interface Manifest {
  workspaces: boolean;
  isPackage: boolean;
}

function manifestAt(dir: string): Manifest | null {
  const file = path.join(dir, 'package.json');
  const pkg: unknown = fs.existsSync(file) ? readJson(file) : null;
  if (!pkg || typeof pkg !== 'object') return null;
  return {
    workspaces: 'workspaces' in pkg && !!pkg.workspaces,
    isPackage: isLinkedPackageJson(pkg),
  };
}

/**
 * The workspace root for `start`: the nearest ancestor (or `start` itself)
 * whose `package.json` has `workspaces`, then each higher ancestor with
 * `workspaces` whose globs match the root found so far -- the first one that
 * does not ends the climb. Of that chain, the topmost that is not itself a
 * linked package (`isLinkedPackageJson`), else the topmost. Null when there
 * is none.
 */
export function findWorkspaceRoot(start: string): string | null {
  const nearest = nearestWithWorkspaces(path.resolve(start));
  if (!nearest) return null;
  let topmost = nearest.dir;
  let topmostApp: string | null = nearest.isPackage ? null : nearest.dir;
  for (let above = path.dirname(topmost); ; above = path.dirname(above)) {
    const m = manifestAt(above);
    if (m?.workspaces) {
      const {workspaceGlobs, globsMatch} = manifestsModule();
      const rel = path.relative(above, topmost).split(path.sep).join('/');
      const globs = workspaceGlobs(above) ?? [];
      if (!globsMatch(globs, rel) && !underPackagesLocal(globs, rel)) break;
      topmost = above;
      if (!m.isPackage) topmostApp = above;
    }
    if (path.dirname(above) === above) break;
  }
  return topmostApp ?? topmost;
}

/**
 * A `--subdir` checkout is a symlink `packages-local/<name>` into
 * `packages-local/.repos/<mono>/…`, and a command run in it sees the real
 * path, which `packages-local/*` does not match: the climb would stop at the
 * framework monorepo and localize would set it up. So anything under
 * `packages-local/` (`.repos/`, `.setup-aside/` too) belongs to an app whose
 * globs list `packages-local/*`.
 */
function underPackagesLocal(globs: string[], rel: string): boolean {
  return (
    rel.startsWith('packages-local/') && globs.includes('packages-local/*')
  );
}

function nearestWithWorkspaces(
  start: string,
): {dir: string; isPackage: boolean} | null {
  for (let dir = start; ; dir = path.dirname(dir)) {
    const m = manifestAt(dir);
    if (m?.workspaces) return {dir, isPackage: m.isPackage};
    if (path.dirname(dir) === dir) return null;
  }
}

/**
 * The app root for a command run in `start`: the workspace root above it, or
 * `start` itself for an app that has no `workspaces` yet (localize's set-up
 * adds them).
 */
export function findAppRoot(start: string): string {
  return findWorkspaceRoot(start) ?? path.resolve(start);
}
