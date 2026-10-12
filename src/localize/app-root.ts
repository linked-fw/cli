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
  linkedPackage: boolean;
}

function manifestAt(dir: string): Manifest | null {
  const file = path.join(dir, 'package.json');
  const pkg: unknown = fs.existsSync(file) ? readJson(file) : null;
  if (!pkg || typeof pkg !== 'object') return null;
  return {
    workspaces: 'workspaces' in pkg && !!pkg.workspaces,
    linkedPackage: 'linkedPackage' in pkg && pkg.linkedPackage === true,
  };
}

/**
 * The workspace root for `start`: the nearest ancestor (or `start` itself)
 * whose `package.json` has `workspaces`, then each higher ancestor with
 * `workspaces` whose globs match the root found so far -- the first one that
 * does not ends the climb. Of that chain, the topmost that is not itself a
 * linked package (`"linkedPackage": true`), else the topmost. Null when there
 * is none.
 */
export function findWorkspaceRoot(start: string): string | null {
  const nearest = nearestWithWorkspaces(path.resolve(start));
  if (!nearest) return null;
  let topmost = nearest.dir;
  let topmostApp: string | null = nearest.linkedPackage ? null : nearest.dir;
  for (let above = path.dirname(topmost); ; above = path.dirname(above)) {
    const m = manifestAt(above);
    if (m?.workspaces) {
      const {workspaceGlobs, globsMatch} = manifestsModule();
      const rel = path.relative(above, topmost).split(path.sep).join('/');
      if (!globsMatch(workspaceGlobs(above) ?? [], rel)) break;
      topmost = above;
      if (!m.linkedPackage) topmostApp = above;
    }
    if (path.dirname(above) === above) break;
  }
  return topmostApp ?? topmost;
}

function nearestWithWorkspaces(
  start: string,
): {dir: string; linkedPackage: boolean} | null {
  for (let dir = start; ; dir = path.dirname(dir)) {
    const m = manifestAt(dir);
    if (m?.workspaces) return {dir, linkedPackage: m.linkedPackage};
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
