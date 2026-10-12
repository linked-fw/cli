/**
 * Which directory is the app: the one whose `package.json` lists the
 * workspaces, wherever in it a command runs. `linked localize` run inside
 * `packages/foo` must set up and install the app, not the member; `build-all`
 * plans from the same root.
 */
import fs from 'node:fs';
import path from 'node:path';

import {readJson} from './fsops.js';

/**
 * The topmost ancestor of `start` (or `start` itself) whose `package.json`
 * has `workspaces`, preferring one that is not itself a linked package
 * (`"linkedPackage": true`). Null when there is none.
 */
export function findWorkspaceRoot(start: string): string | null {
  let topmost: string | null = null;
  let topmostApp: string | null = null;
  let dir = path.resolve(start);
  for (;;) {
    const file = path.join(dir, 'package.json');
    const pkg: unknown = fs.existsSync(file) ? readJson(file) : null;
    if (pkg && typeof pkg === 'object' && 'workspaces' in pkg && pkg.workspaces) {
      topmost = dir;
      if (!('linkedPackage' in pkg && pkg.linkedPackage === true)) topmostApp = dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return topmostApp ?? topmost;
}

/**
 * The app root for a command run in `start`: the workspace root above it, or
 * `start` itself for an app that has no `workspaces` yet (localize's set-up
 * adds them).
 */
export function findAppRoot(start: string): string {
  return findWorkspaceRoot(start) ?? path.resolve(start);
}
