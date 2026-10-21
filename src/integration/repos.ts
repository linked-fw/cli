/**
 * The repositories of an app checkout and the integration branch they share.
 *
 * An app checkout is the app's own repository plus every git checkout in its
 * `packages-local/`. In a worktree set (`linked branch start`, `linked
 * worktree add`) those are git worktrees: `.git` is then a file, not a
 * directory. An integration branch is a branch with a recorded target,
 * `git config branch.<name>.linked-target <target>`; git keeps that in the
 * repository's one config, so every worktree of the repository reads it. An
 * agent's branch is `<integration>--<agent>`: git cannot hold both `x` and
 * `x/agent`.
 *
 * Every git call goes through the `run` seam (./localize/run.ts), so tests can
 * fake it. Everything here is synchronous, like the seam.
 */
import fs from 'node:fs';
import path from 'node:path';

import {readJson} from '../localize/fsops.js';
import {LOCAL_DIR} from '../localize/members.js';
import {makeRun, type Run, type RunResult} from '../localize/run.js';

export interface RepoInfo {
  /** Absolute path of the checkout. */
  dir: string;
  /** Relative to the app root, `/`-separated: `.` or `packages-local/_linked-core`. */
  rel: string;
  /** `name` from the checkout's `package.json`, when it has one. */
  packageName?: string;
  /** The checked-out branch, or null when HEAD is detached. */
  branch: string | null;
  head: string;
  /** Uncommitted changes or untracked files. */
  dirty: boolean;
}

export interface Integration {
  /** The integration branch. */
  branch: string;
  target: string;
  /** Set when the root is on an agent branch `<branch>--<agent>`. */
  agent?: string;
}

export const AGENT_SEPARATOR = '--';

/** `git <args>` in `dir`. */
export function git(run: Run, dir: string, args: string[]): RunResult {
  return run('git', args, {cwd: dir});
}

function gitOut(run: Run, dir: string, args: string[]): string | null {
  const r = git(run, dir, args);
  return r.status === 0 ? r.stdout.trim() : null;
}

/** Whether `dir` is the top of a git checkout: `.git` is a directory, or a file in a worktree. */
export function isCheckout(dir: string): boolean {
  return fs.existsSync(path.join(dir, '.git'));
}

/** The branch checked out in `dir`, or null when HEAD is detached. */
export function currentBranch(run: Run, dir: string): string | null {
  return gitOut(run, dir, ['symbolic-ref', '--short', '-q', 'HEAD']) || null;
}

export function isDirty(run: Run, dir: string): boolean {
  const r = git(run, dir, ['status', '--porcelain']);
  return r.status !== 0 || r.stdout.trim() !== '';
}

export function repoInfo(
  run: Run,
  appRoot: string,
  dir: string,
): RepoInfo {
  const rel = path.relative(appRoot, dir).split(path.sep).join('/') || '.';
  const pkg = readJson(path.join(dir, 'package.json'));
  const info: RepoInfo = {
    dir,
    rel,
    branch: currentBranch(run, dir),
    head: gitOut(run, dir, ['rev-parse', 'HEAD']) ?? '',
    dirty: isDirty(run, dir),
  };
  if (typeof pkg?.name === 'string' && pkg.name) info.packageName = pkg.name;
  return info;
}

/**
 * The app root and every git checkout in its `packages-local/`, root first,
 * then by directory name. A `packages-local/` entry without `.git` is skipped.
 */
export function listRepos(
  appRoot: string,
  run: Run = makeRun(appRoot),
): RepoInfo[] {
  const out = [repoInfo(run, appRoot, appRoot)];
  let entries: string[];
  try {
    entries = fs.readdirSync(path.join(appRoot, LOCAL_DIR)).sort();
  } catch {
    entries = [];
  }
  for (const entry of entries) {
    if (entry.startsWith('.')) continue;
    const dir = path.join(appRoot, LOCAL_DIR, entry);
    if (!isCheckout(dir)) continue;
    out.push(repoInfo(run, appRoot, dir));
  }
  return out;
}

/** The recorded target of `branch` in the repository of `repoDir`, or null. */
export function getTarget(
  repoDir: string,
  branch: string,
  run: Run = makeRun(repoDir),
): string | null {
  return gitOut(run, repoDir, ['config', '--get', `branch.${branch}.linked-target`]) || null;
}

export function setTarget(
  repoDir: string,
  branch: string,
  target: string,
  run: Run = makeRun(repoDir),
): void {
  const r = git(run, repoDir, ['config', `branch.${branch}.linked-target`, target]);
  if (r.status !== 0)
    throw new Error(`git config branch.${branch}.linked-target failed in ${repoDir}: ${r.stderr.trim()}`);
}

/** Commits on `a` not on `b` (ahead) and on `b` not on `a` (behind). */
export function aheadBehind(
  repoDir: string,
  a: string,
  b: string,
  run: Run = makeRun(repoDir),
): {ahead: number; behind: number} {
  const out = gitOut(run, repoDir, ['rev-list', '--left-right', '--count', `${a}...${b}`]);
  const [ahead, behind] = (out ?? '').split(/\s+/).map(Number);
  if (!Number.isFinite(ahead) || !Number.isFinite(behind))
    throw new Error(`git rev-list ${a}...${b} failed in ${repoDir}`);
  return {ahead, behind};
}

/**
 * The integration branch the checkout at `appRoot` is on: its branch when that
 * branch has a target, or, on an agent branch `<x>--<agent>`, `x` when `x`
 * has one. Null otherwise (on the target itself, detached, or no target).
 */
export function integrationOf(
  appRoot: string,
  run: Run = makeRun(appRoot),
): Integration | null {
  const branch = currentBranch(run, appRoot);
  if (!branch) return null;
  const target = getTarget(appRoot, branch, run);
  if (target) return {branch, target};
  const at = branch.lastIndexOf(AGENT_SEPARATOR);
  if (at > 0) {
    const base = branch.slice(0, at);
    const agent = branch.slice(at + AGENT_SEPARATOR.length);
    const baseTarget = agent ? getTarget(appRoot, base, run) : null;
    if (baseTarget) return {branch: base, target: baseTarget, agent};
  }
  return null;
}

/** `<integration>--<agent>`. The agent name may not hold `/` or `--`. */
export function agentBranch(integration: string, agent: string): string {
  if (!agent || agent.includes('/') || agent.includes(AGENT_SEPARATOR))
    throw new Error(
      `Agent name "${agent}" may not be empty or contain "/" or "${AGENT_SEPARATOR}".`,
    );
  return `${integration}${AGENT_SEPARATOR}${agent}`;
}

export function branchExists(run: Run, repoDir: string, branch: string): boolean {
  return git(run, repoDir, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]).status === 0;
}

/** Whether `ref` names a commit in the repository (a branch, remote branch, tag or sha). */
export function refExists(run: Run, repoDir: string, ref: string): boolean {
  return git(run, repoDir, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).status === 0;
}

export interface Worktree {
  dir: string;
  head: string;
  /** Null when detached. */
  branch: string | null;
  /** The first entry: the repository's main checkout. */
  main: boolean;
}

/** `git worktree list --porcelain`, parsed. The main checkout comes first. */
export function worktreesOf(run: Run, repoDir: string): Worktree[] {
  const out = gitOut(run, repoDir, ['worktree', 'list', '--porcelain']);
  if (out === null) return [];
  const list: Worktree[] = [];
  for (const block of out.split(/\n\s*\n/)) {
    let dir = '';
    let head = '';
    let branch: string | null = null;
    for (const line of block.split('\n')) {
      if (line.startsWith('worktree ')) dir = line.slice('worktree '.length);
      else if (line.startsWith('HEAD ')) head = line.slice('HEAD '.length);
      else if (line.startsWith('branch '))
        branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
    }
    if (dir) list.push({dir, head, branch, main: list.length === 0});
  }
  return list;
}

/** The repository's main checkout (not a linked worktree), or `repoDir` when git cannot tell. */
export function mainCheckoutOf(run: Run, repoDir: string): string {
  return worktreesOf(run, repoDir)[0]?.dir ?? repoDir;
}

/** Whether `ancestor` is reachable from `descendant`. */
export function isAncestor(
  run: Run,
  repoDir: string,
  ancestor: string,
  descendant: string,
): boolean {
  return git(run, repoDir, ['merge-base', '--is-ancestor', ancestor, descendant]).status === 0;
}

/** Match a package named on the command line against a checkout: its npm name, or its directory name with or without the `_linked-` prefix. */
export function matchesPackage(
  repo: Pick<RepoInfo, 'rel' | 'packageName'>,
  name: string,
): boolean {
  const dirName = path.posix.basename(repo.rel);
  if (repo.packageName === name) return true;
  if (dirName === name) return true;
  if (repo.packageName === `@_linked/${name}`) return true;
  return dirName === `_linked-${name}`;
}
