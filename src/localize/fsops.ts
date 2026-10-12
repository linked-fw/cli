/** The filesystem primitives localize shares. */
import fs from 'node:fs';
import path from 'node:path';

import {linkDirectory, samePath} from '../utils/platform.js';

export function isSymlink(p: string): boolean {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Something is at `p`: a file, a directory, or a link, dangling or not. */
export function existsOrLink(p: string): boolean {
  return fs.existsSync(p) || isSymlink(p);
}

export function isGitCheckout(p: string): boolean {
  return fs.existsSync(path.join(p, '.git'));
}

/** Is `child` at or below `parent`? Both must be absolute, real paths. */
export function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function readJson(file: string): any {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Where the link at `p` points, absolute, whether or not the target exists. */
export function linkTargetOf(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(path.dirname(p), fs.readlinkSync(p));
  }
}

/**
 * Move a checkout directory, or the link standing for one (a package inside a
 * cloned monorepo, see localize.ts). A link is written again from its new
 * place (relative, or a junction on Windows), so it still reaches the same
 * target.
 */
export function moveEntry(from: string, to: string): void {
  fs.mkdirSync(path.dirname(to), {recursive: true});
  if (isSymlink(from)) {
    const target = linkTargetOf(from);
    linkDirectory(target, to);
    fs.unlinkSync(from);
    return;
  }
  fs.renameSync(from, to);
}

/**
 * The root of the git repository a checkout belongs to -- the checkout itself,
 * or the cloned monorepo a linked package sits in -- or null when there is
 * none below the app root (the app's own repository does not count).
 */
export function checkoutRepoRoot(
  checkout: string,
  appRoot: string,
): string | null {
  let app: string;
  let dir: string;
  try {
    app = fs.realpathSync(appRoot);
    dir = fs.realpathSync(checkout);
  } catch {
    return null;
  }
  while (!samePath(dir, app) && isInside(dir, app)) {
    if (isGitCheckout(dir)) return dir;
    dir = path.dirname(dir);
  }
  return null;
}
