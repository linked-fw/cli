/**
 * The repos of an app and the integration branch they share.
 *
 * An app's repos are its root plus every git checkout in `packages-local/`.
 * A piece of work runs on an integration branch (`overhaul`) whose target
 * (`main`, `dev`, ...) is stored per repo in git config as
 * `branch.<integration>.linked-target`. Agents work on local branches named
 * `<integration>--<agent>`.
 *
 * Every git call goes through a `Run` (see `../localize/run.ts`), so tests can
 * fake git; by default it is the real one.
 */
import fs from 'node:fs';
import path from 'node:path';

import {makeRun, type Run} from '../localize/run.js';

export interface RepoInfo {
  /** Absolute path of the checkout. */
  dir: string;
  /** Path relative to the app root: `.` for the root, `packages-local/<dir>` otherwise. */
  rel: string;
  /** `name` from the checkout's `package.json`, when it has one. */
  packageName?: string;
  /** The checked-out branch; null when HEAD is detached. */
  branch: string | null;
  /** The commit HEAD points at. */
  head: string;
  /** Whether the work tree has uncommitted or untracked changes. */
  dirty: boolean;
}

export interface Integration {
  branch: string;
  target: string;
}

/** Run git in `cwd` and return its trimmed stdout; throws with git's own message when it fails. */
export function git(run: Run, cwd: string, args: string[]): string {
  const r = run('git', args, {cwd});
  if (r.status !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed in ${cwd}: ${(r.stderr || r.stdout).trim()}`,
    );
  }
  return r.stdout.trim();
}

/** The checked-out branch in `dir`, or null when HEAD is detached. */
export function currentBranch(run: Run, dir: string): string | null {
  const r = run('git', ['symbolic-ref', '--short', '-q', 'HEAD'], {cwd: dir});
  const branch = r.stdout.trim();
  return r.status === 0 && branch ? branch : null;
}

function readPackageName(dir: string): string | undefined {
  try {
    const pkg: unknown = JSON.parse(
      fs.readFileSync(path.join(dir, 'package.json'), 'utf8'),
    );
    if (pkg && typeof pkg === 'object' && 'name' in pkg) {
      const name = (pkg as {name: unknown}).name;
      return typeof name === 'string' ? name : undefined;
    }
  } catch {
    // No package.json, or not JSON: the checkout simply has no package name.
  }
  return undefined;
}

function repoInfo(run: Run, appRoot: string, dir: string): RepoInfo {
  const rel = path.relative(appRoot, dir).split(path.sep).join('/') || '.';
  const status = git(run, dir, ['status', '--porcelain']);
  return {
    dir,
    rel,
    packageName: readPackageName(dir),
    branch: currentBranch(run, dir),
    head: git(run, dir, ['rev-parse', 'HEAD']),
    dirty: status !== '',
  };
}

/**
 * The app root plus every `packages-local/*` directory that is a git
 * checkout (has a `.git` directory, or a `.git` file for a worktree), in
 * directory-name order.
 */
export async function listRepos(
  appRoot: string,
  run: Run = makeRun(appRoot),
): Promise<RepoInfo[]> {
  const repos = [repoInfo(run, appRoot, appRoot)];
  const local = path.join(appRoot, 'packages-local');
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(local, {withFileTypes: true});
  } catch {
    // No packages-local/: the root is the only repo.
  }
  const dirs = entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
    .map((name) => path.join(local, name))
    .filter((dir) => fs.existsSync(path.join(dir, '.git')));
  for (const dir of dirs) repos.push(repoInfo(run, appRoot, dir));
  return repos;
}

/** The target recorded for `branch` in `repoDir`, or null when none is. */
export async function getTarget(
  repoDir: string,
  branch: string,
  run: Run = makeRun(repoDir),
): Promise<string | null> {
  // `git config --get` exits 1 when the key is unset.
  const r = run('git', ['config', '--get', `branch.${branch}.linked-target`], {
    cwd: repoDir,
  });
  const target = r.stdout.trim();
  return r.status === 0 && target ? target : null;
}

/** Record `target` as the branch `branch` lands in, in `repoDir`. */
export async function setTarget(
  repoDir: string,
  branch: string,
  target: string,
  run: Run = makeRun(repoDir),
): Promise<void> {
  git(run, repoDir, ['config', `branch.${branch}.linked-target`, target]);
}

/**
 * How many commits `a` has that `b` lacks (`ahead`), and the reverse
 * (`behind`).
 */
export async function aheadBehind(
  repoDir: string,
  a: string,
  b: string,
  run: Run = makeRun(repoDir),
): Promise<{ahead: number; behind: number}> {
  const out = git(run, repoDir, [
    'rev-list',
    '--left-right',
    '--count',
    `${a}...${b}`,
  ]);
  const [ahead, behind] = out.split(/\s+/).map((n) => Number.parseInt(n, 10));
  if (!Number.isFinite(ahead) || !Number.isFinite(behind)) {
    throw new Error(`unexpected git rev-list output in ${repoDir}: ${out}`);
  }
  return {ahead, behind};
}

/**
 * The integration branch the app root is on: its current branch when that
 * branch has a target. Null when the root is detached or on a branch without
 * one, such as the target itself.
 */
export async function integrationOf(
  appRoot: string,
  run: Run = makeRun(appRoot),
): Promise<Integration | null> {
  const branch = currentBranch(run, appRoot);
  if (!branch) return null;
  const target = await getTarget(appRoot, branch, run);
  return target ? {branch, target} : null;
}

/**
 * The local branch an agent works on: `<integration>--<agent>`. The agent
 * name must not contain `/` or `--`, so the integration branch can be read
 * back from it unambiguously.
 */
export function agentBranch(integration: string, agent: string): string {
  if (!agent || agent.includes('/') || agent.includes('--')) {
    throw new Error(
      `invalid agent name "${agent}": it must be non-empty and contain neither "/" nor "--"`,
    );
  }
  return `${integration}--${agent}`;
}
