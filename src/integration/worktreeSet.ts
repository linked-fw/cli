/**
 * A worktree set: a git worktree of the app with a worktree of each framework
 * repository it changes nested in its `packages-local/`. Vite's workspace
 * table maps those names to the nested checkouts and every other package to
 * the main checkout's, through the `node_modules` the set links to.
 *
 * Shared by `linked branch start` (the integration set) and `linked worktree
 * add` (an agent's set).
 */
import fs from 'node:fs';
import path from 'node:path';

import {isInside} from '../localize/fsops.js';
import {requireHook} from '../localize/hook-module.js';
import type {Run} from '../localize/run.js';
import {git} from './repos.js';

interface ManifestsModule {
  workspaceGlobs: (appRoot: string) => string[] | null;
  globsMatch: (globs: string[], rel: string) => boolean;
}

let manifests: ManifestsModule | undefined;
function manifestsModule(): ManifestsModule {
  manifests ??= requireHook<ManifestsModule>(
    'manifests.cjs',
    (mod) => typeof mod.workspaceGlobs === 'function' && typeof mod.globsMatch === 'function',
  );
  return manifests;
}

/** Real path of `p`, or of its nearest existing ancestor joined with the rest. */
function realpathLoose(p: string): string {
  const abs = path.resolve(p);
  try {
    return fs.realpathSync(abs);
  } catch {
    const parent = path.dirname(abs);
    return parent === abs ? abs : path.join(realpathLoose(parent), path.basename(abs));
  }
}

/**
 * Why `dir` cannot hold a new worktree set, or null. It must not exist, and
 * must not lie in a workspace glob of any of `appRoots` (or below a directory
 * one matches): npm and Vite would take it for a second package of the same
 * name. A nested worktree (`.claude/worktrees/x`) matches no glob.
 */
export function refuseDir(dir: string, appRoots: string[]): string | null {
  if (fs.existsSync(dir) || isSymlinkLoose(dir)) return `${dir} already exists.`;
  const real = realpathLoose(dir);
  for (const root of appRoots) {
    const realRoot = realpathLoose(root);
    if (!isInside(real, realRoot)) continue;
    const globs = manifestsModule().workspaceGlobs(realRoot) ?? [];
    const segments = path.relative(realRoot, real).split(path.sep);
    for (let i = 1; i <= segments.length; i++) {
      const rel = segments.slice(0, i).join('/');
      if (manifestsModule().globsMatch(globs, rel))
        return `${dir} is inside the workspace glob that matches ${rel} in ${root}: npm and Vite would see a second copy of the package there.`;
    }
  }
  return null;
}

function isSymlinkLoose(p: string): boolean {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

function isIgnored(run: Run, dir: string, name: string): boolean {
  return git(run, dir, ['check-ignore', '-q', '--no-index', name]).status === 0;
}

/** Keep `name` out of `git status` in the worktree at `dir` (the repository's shared `info/exclude`). */
function excludeInRepo(run: Run, dir: string, name: string): void {
  if (isIgnored(run, dir, name)) return;
  const r = git(run, dir, ['rev-parse', '--git-common-dir']);
  if (r.status !== 0) return;
  const common = path.resolve(dir, r.stdout.trim());
  const file = path.join(common, 'info', 'exclude');
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const line = `/${name}`;
  if (current.split('\n').includes(line)) return;
  fs.appendFileSync(file, `${current && !current.endsWith('\n') ? '\n' : ''}${line}\n`);
}

/** The `.env` files a worktree shares with `root`: `.env`, `.env.local`, `.env.*.local`, when gitignored there. */
export function sharedEnvFiles(run: Run, root: string): string[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(root);
  } catch {
    return [];
  }
  return entries
    .filter((n) => n === '.env' || n === '.env.local' || /^\.env\..+\.local$/.test(n))
    .filter((n) => isIgnored(run, root, n))
    .sort();
}

/** Gitignored private keys at the top of `root`: never linked, only named. */
export function privateKeys(run: Run, root: string): string[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(root);
  } catch {
    return [];
  }
  return entries.filter((n) => n.endsWith('.pem') && isIgnored(run, root, n)).sort();
}

/**
 * Link `node_modules` and the shared `.env` files of `root` into the worktree
 * at `dir`, each to its real path (so the link outlives an intermediate
 * worktree). Returns the names linked.
 */
export function linkShared(run: Run, root: string, dir: string): string[] {
  const linked: string[] = [];
  const names = ['node_modules', ...sharedEnvFiles(run, root)];
  for (const name of names) {
    const from = path.join(root, name);
    if (!fs.existsSync(from)) continue;
    const at = path.join(dir, name);
    if (fs.existsSync(at) || isSymlinkLoose(at)) continue;
    fs.symlinkSync(fs.realpathSync(from), at, name === 'node_modules' ? 'dir' : 'file');
    excludeInRepo(run, dir, name);
    linked.push(name);
  }
  return linked;
}

/** Remove the links `linkShared` made (symlinks only), so `git worktree remove` sees a clean tree. */
export function unlinkShared(dir: string): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (name !== 'node_modules' && !name.startsWith('.env')) continue;
    const at = path.join(dir, name);
    if (isSymlinkLoose(at)) fs.unlinkSync(at);
  }
}
