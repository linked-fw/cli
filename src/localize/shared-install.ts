/**
 * Whether an app directory runs on another checkout's install (a worktree
 * made by `linked worktree add`). The implementation is
 * `hooks/shared-install.cjs`, which the git hooks require, so the commands and
 * the hooks apply one rule.
 */
import path from 'node:path';

import {requireHook} from './hook-module.js';

export interface SharedInstall {
  /** `symlink`: `node_modules` is a symlink to the install; `farm`: a link farm into it. */
  layout: 'symlink' | 'farm';
  /** The directory that holds the real `node_modules`. */
  installRoot: string;
}

interface SharedInstallModule {
  MARKER: string;
  sharedInstall: (appRoot: string) => SharedInstall | null;
}

const hook = requireHook<SharedInstallModule>(
  'shared-install.cjs',
  (mod) => typeof mod.MARKER === 'string' && typeof mod.sharedInstall === 'function',
);

/** The file in a link farm's `node_modules` that names the install it links into. */
export const FARM_MARKER: string = hook.MARKER;

/** How `<appRoot>/node_modules` shares another checkout's install; null when it is the app's own or missing. */
export function sharedInstall(appRoot: string): SharedInstall | null {
  return hook.sharedInstall(appRoot);
}

/**
 * Whether `dir` or a directory above it shares another checkout's install: a
 * package checkout inside an agent worktree.
 */
export function insideSharedInstall(dir: string): boolean {
  let d = path.resolve(dir);
  for (;;) {
    if (sharedInstall(d)) return true;
    const parent = path.dirname(d);
    if (parent === d) return false;
    d = parent;
  }
}

/**
 * Extra `tsc` flags for building the package at `packageDir`. Inside an agent
 * worktree, the package's dependencies are links into the main checkout's
 * install, and `tsc` follows them to their real paths there; a declaration
 * that names a hoisted transitive dependency then has no portable path from
 * the worktree (TS2742 "cannot be named without a reference to
 * '…/node_modules/…'"). `--preserveSymlinks` keeps the paths under the
 * worktree's `node_modules`, which emits the same bare specifiers a build in
 * the main checkout does.
 */
export function tscFlagsFor(packageDir: string): string {
  return insideSharedInstall(packageDir) ? ' --preserveSymlinks' : '';
}
