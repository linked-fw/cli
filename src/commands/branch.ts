/**
 * `linked branch status` and `linked branch start` — one integration branch
 * across an app and its `packages-local/` checkouts (the repo model is in
 * `../integration/repos.ts`).
 *
 * The core functions take the app root and an optional `run`, and return data
 * and an exit code; printing is separate, so tests drive them against real
 * throwaway repos.
 */
import fs from 'node:fs';
import process from 'node:process';

import {
  aheadBehind,
  getTarget,
  integrationOf,
  listRepos,
  setTarget,
  type Integration,
  type RepoInfo,
} from '../integration/repos.js';
import {findAppRoot} from '../localize/app-root.js';
import {makeRun, type Run} from '../localize/run.js';

export type BranchFlag = 'off-branch' | '';

export interface BranchStatusRow {
  /** `.` for the app root, `packages-local/<dir>` otherwise. */
  repo: string;
  packageName?: string;
  /** The checked-out branch, or `detached`. */
  branch: string;
  /** The target recorded for the checked-out branch, or '' when none is. */
  target: string;
  dirty: boolean;
  /** Commits HEAD has that the target lacks, and the reverse; null without a resolvable target. */
  aheadTarget: number | null;
  behindTarget: number | null;
  /** The same against the root's integration branch; null when there is none or the repo lacks that branch. */
  aheadIntegration: number | null;
  behindIntegration: number | null;
  flag: BranchFlag;
}

export interface BranchStatus {
  integration: Integration | null;
  rows: BranchStatusRow[];
}

export function refExists(run: Run, dir: string, ref: string): boolean {
  const r = run('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
    cwd: dir,
  });
  return r.status === 0;
}

export function localBranchExists(run: Run, dir: string, branch: string): boolean {
  return refExists(run, dir, `refs/heads/${branch}`);
}

/** The local branches (full ref names) whose history contains `sha`. */
export function branchesContaining(run: Run, repoDir: string, sha: string): string[] {
  const r = run('git', ['for-each-ref', '--contains', sha, '--format=%(refname)', 'refs/heads'], {cwd: repoDir});
  return r.status === 0 ? r.stdout.split('\n').map((l) => l.trim()).filter(Boolean) : [];
}

export type DeleteCheck = {ok: true} | {ok: false; reason: string; sha: string};

/**
 * Whether an undo may delete `branch`, which this run created at `createdSha`.
 * Only while it is still exactly what the run made: it points at `createdSha`,
 * no worktree has it checked out, and no other local branch has forked from
 * it. `existing` lists the branches that already contained `createdSha` when
 * it was created (the target it was made from, typically); those don't count
 * as forks. When not ok, `sha` is where the branch is now ('' when it is gone).
 */
export function safeToDeleteCreatedBranch(
  repoDir: string,
  branch: string,
  createdSha: string,
  run: Run,
  existing: string[] = [],
): DeleteCheck {
  const ref = `refs/heads/${branch}`;
  const now = run('git', ['rev-parse', '-q', '--verify', ref], {cwd: repoDir}).stdout.trim();
  if (!now) return {ok: false, reason: 'it no longer exists', sha: ''};
  if (now !== createdSha) return {ok: false, reason: `it moved from ${createdSha}`, sha: now};
  const holder = worktreesOf(run, repoDir).find((wt) => wt.branch === branch);
  if (holder) return {ok: false, reason: `the worktree at ${holder.path} has it checked out`, sha: now};
  const forks = branchesContaining(run, repoDir, createdSha).filter(
    (r) => r !== ref && !existing.includes(r),
  );
  if (forks.length) {
    return {
      ok: false,
      reason: `${forks.map((r) => r.replace(/^refs\/heads\//, '')).join(', ')} forked from it`,
      sha: now,
    };
  }
  return {ok: true};
}

export interface GitWorktree {
  path: string;
  head: string;
  /** Null when detached. */
  branch: string | null;
}

/** Parse `git worktree list --porcelain`. Bare entries are skipped. */
export function parseWorktreeList(out: string): GitWorktree[] {
  const list: GitWorktree[] = [];
  for (const block of out.split(/\n\s*\n/)) {
    let wt: GitWorktree | null = null;
    let bare = false;
    for (const line of block.split('\n')) {
      if (line.startsWith('worktree ')) wt = {path: line.slice('worktree '.length), head: '', branch: null};
      else if (wt && line.startsWith('HEAD ')) wt.head = line.slice(5);
      else if (wt && line.startsWith('branch ')) wt.branch = line.slice(7).replace(/^refs\/heads\//, '');
      else if (line === 'bare') bare = true;
    }
    if (wt && !bare) list.push(wt);
  }
  return list;
}

/** The worktrees of the repo at `repoDir`, its main checkout first; empty when git fails. */
export function worktreesOf(run: Run, repoDir: string): GitWorktree[] {
  const r = run('git', ['worktree', 'list', '--porcelain'], {cwd: repoDir});
  return r.status === 0 ? parseWorktreeList(r.stdout) : [];
}

/**
 * Whether `repo` is where the integration expects it: on the integration
 * branch, or on its own target for it.
 *
 * A repo's target for the integration is the one recorded in that repo as
 * `branch.<integration>.linked-target`. A checkout the work has not touched
 * yet has no such entry (and usually no integration branch at all); it then
 * counts as on its target when it is on the root's target. So a
 * `packages-local/` checkout left on `main` while the root works on
 * `overhaul` (target `main`) is not flagged, but one on `feature-x` is. A
 * detached HEAD is never on either.
 */
async function isOnBranch(
  run: Run,
  repo: RepoInfo,
  integration: Integration,
): Promise<boolean> {
  if (!repo.branch) return false;
  if (repo.branch === integration.branch) return true;
  const target =
    (await getTarget(repo.dir, integration.branch, run)) ?? integration.target;
  return repo.branch === target;
}

/** One row per repo (root first, then `packages-local/*`). */
export async function branchStatus(
  appRoot: string,
  run: Run = makeRun(appRoot),
): Promise<BranchStatus> {
  const integration = await integrationOf(appRoot, run);
  const repos = await listRepos(appRoot, run);
  const rows: BranchStatusRow[] = [];
  for (const repo of repos) {
    const target = repo.branch ? await getTarget(repo.dir, repo.branch, run) : null;
    let aheadTarget: number | null = null;
    let behindTarget: number | null = null;
    if (target && refExists(run, repo.dir, target)) {
      ({ahead: aheadTarget, behind: behindTarget} = await aheadBehind(
        repo.dir,
        'HEAD',
        target,
        run,
      ));
    }
    let aheadIntegration: number | null = null;
    let behindIntegration: number | null = null;
    if (integration && localBranchExists(run, repo.dir, integration.branch)) {
      ({ahead: aheadIntegration, behind: behindIntegration} = await aheadBehind(
        repo.dir,
        'HEAD',
        integration.branch,
        run,
      ));
    }
    // Without an integration branch on the root there is nothing to be off.
    const off = integration ? !(await isOnBranch(run, repo, integration)) : false;
    rows.push({
      repo: repo.rel,
      packageName: repo.packageName,
      branch: repo.branch ?? 'detached',
      target: target ?? '',
      dirty: repo.dirty,
      aheadTarget,
      behindTarget,
      aheadIntegration,
      behindIntegration,
      flag: off ? 'off-branch' : '',
    });
  }
  return {integration, rows};
}

const counts = (ahead: number | null, behind: number | null): string =>
  ahead === null || behind === null ? '-' : `+${ahead}/-${behind}`;

export function formatBranchStatus(status: BranchStatus): string {
  const header = ['repo', 'branch', 'target', 'dirty', 'vs target', 'vs integration', 'flag'];
  const cells = status.rows.map((r) => [
    r.repo,
    r.branch,
    r.target,
    r.dirty ? 'yes' : 'no',
    counts(r.aheadTarget, r.behindTarget),
    counts(r.aheadIntegration, r.behindIntegration),
    r.flag,
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...cells.map((c) => c[i].length)));
  const line = (c: string[]) => c.map((v, i) => v.padEnd(widths[i])).join('  ').trimEnd();
  const intro = status.integration
    ? `Integration branch: ${status.integration.branch} (target ${status.integration.target})`
    : 'No integration branch: the app root is not on a branch with a recorded target.';
  return [intro, '', line(header), ...cells.map(line)].join('\n');
}

export interface BranchStartResult {
  code: number;
  /** One line per repo switched, or the reason nothing was. */
  messages: string[];
}

/** Whether `wanted` names `repo`: its package name, its dir name, or the package name without its scope. */
function matches(repo: RepoInfo, wanted: string): boolean {
  const dirName = repo.rel.split('/').pop() ?? repo.rel;
  const unscoped = repo.packageName?.split('/').pop();
  return repo.packageName === wanted || dirName === wanted || unscoped === wanted;
}

/**
 * The `packages-local/` checkouts named by `wanted` (package name, dir name or
 * short name), each once, in the order given; or why one name matches none or
 * several.
 */
export function selectCheckouts(
  local: RepoInfo[],
  wanted: string[],
): {repos: RepoInfo[]} | {error: string} {
  const repos: RepoInfo[] = [];
  for (const name of wanted) {
    const found = local.filter((r) => matches(r, name));
    if (found.length !== 1) {
      const available = local
        .map((r) => (r.packageName ? `${r.packageName} (${r.rel})` : r.rel))
        .join(', ');
      return {
        error:
          found.length === 0
            ? `No checkout in packages-local/ matches "${name}". Available: ${available || 'none'}.`
            : `"${name}" matches several checkouts: ${found.map((r) => r.rel).join(', ')}. Use the full package name.`,
      };
    }
    if (!repos.includes(found[0])) repos.push(found[0]);
  }
  return {repos};
}

/** `p` resolved through symlinks when it exists, so paths compare equal however they were spelled. */
function real(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * Put the app root and the named `packages-local/` checkouts on integration
 * branch `name`, created from `target` where it does not exist yet, and
 * record `target` for it in each.
 *
 * Every precondition (a valid name other than the target, clean trees, the
 * target present wherever the branch has to be created, and no other
 * worktree holding the branch) is checked in every selected repo before any
 * is switched, so a refusal leaves all untouched. If a switch still fails
 * partway, the repos already switched go back to where they were: each
 * returns to its previous branch (or commit), a branch this run created is
 * deleted (unless it moved, is checked out, or another branch forked from it:
 * see `safeToDeleteCreatedBranch`), and the target entry is restored.
 */
export async function branchStart(
  appRoot: string,
  name: string,
  target: string,
  packages: string[] = [],
  run: Run = makeRun(appRoot),
): Promise<BranchStartResult> {
  const refuse = (...messages: string[]): BranchStartResult => ({code: 1, messages});
  if (!name) return refuse('A branch name is required.');
  if (name.includes('--')) {
    return refuse(
      `"${name}" contains "--", which separates an integration branch from an agent name (<integration>--<agent>). Choose another name.`,
    );
  }
  if (!target) return refuse('--target <branch> is required.');
  if (name === target) {
    return refuse(
      `"${name}" is the target itself: an integration branch lands in its target, so it needs a name of its own.`,
    );
  }
  const check = run('git', ['check-ref-format', '--branch', name], {cwd: appRoot});
  if (check.status !== 0) return refuse(`"${name}" is not a valid branch name.`);

  const repos = await listRepos(appRoot, run);
  const [root, ...local] = repos;
  const chosen = selectCheckouts(local, packages);
  if ('error' in chosen) return refuse(chosen.error);
  const selected: RepoInfo[] = [root, ...chosen.repos];

  const dirty = selected.filter((r) => r.dirty);
  if (dirty.length) {
    return refuse(
      `Uncommitted or untracked changes in ${dirty.map((r) => r.rel).join(', ')}. Commit or stash them first; nothing was switched.`,
    );
  }
  const plan = selected.map((repo) => ({
    repo,
    exists: localBranchExists(run, repo.dir, name),
  }));
  const noTarget = plan.filter((p) => !p.exists && !refExists(run, p.repo.dir, target));
  if (noTarget.length) {
    return refuse(
      `"${target}" does not exist in ${noTarget.map((p) => p.repo.rel).join(', ')}, so "${name}" cannot be created there; nothing was switched.`,
    );
  }
  // git refuses to switch to a branch another worktree has checked out.
  const held: string[] = [];
  for (const {repo} of plan) {
    const self = real(repo.dir);
    for (const wt of worktreesOf(run, repo.dir)) {
      if (wt.branch === name && real(wt.path) !== self) held.push(`${repo.rel} (at ${wt.path})`);
    }
  }
  if (held.length) {
    return refuse(
      `"${name}" is checked out in another worktree of ${held.join(', ')}. Remove that worktree or pick another name; nothing was switched.`,
    );
  }

  const messages: string[] = [];
  // Each repo switched pushes how to put it back.
  const undo: (() => void)[] = [];
  const rollback = (): BranchStartResult => {
    for (const fn of undo.reverse()) {
      try {
        fn();
      } catch (error) {
        messages.push(`undo failed: ${(error as Error).message}`);
      }
    }
    if (undo.length) messages.push('Put the repos switched so far back where they were.');
    return {code: 1, messages};
  };
  const key = `branch.${name}.linked-target`;
  try {
    for (const {repo, exists} of plan) {
      const previousTarget = await getTarget(repo.dir, name, run);
      if (repo.branch !== name) {
        const args = exists ? ['switch', name] : ['switch', '-c', name, target];
        const r = run('git', args, {cwd: repo.dir});
        if (r.status !== 0) {
          messages.push(`${repo.rel}: git ${args.join(' ')} failed: ${(r.stderr || r.stdout).trim()}`);
          return rollback();
        }
      }
      // A branch this run created: where it was made, and the branches that
      // already contained that commit (so a later fork can be told apart).
      const created =
        exists || repo.branch === name
          ? null
          : run('git', ['rev-parse', `refs/heads/${name}`], {cwd: repo.dir}).stdout.trim();
      const before = created
        ? branchesContaining(run, repo.dir, created).filter((r) => r !== `refs/heads/${name}`)
        : [];
      undo.push(() => {
        let keep = false;
        if (repo.branch !== name) {
          const back = repo.branch ? ['switch', repo.branch] : ['switch', '--detach', repo.head];
          run('git', back, {cwd: repo.dir});
          if (created) {
            const check = safeToDeleteCreatedBranch(repo.dir, name, created, run, before);
            if (check.ok) {
              run('git', ['branch', '-D', name], {cwd: repo.dir});
            } else if ('sha' in check && check.sha) {
              keep = true;
              messages.push(`${repo.rel}: kept ${name} at ${check.sha}: ${check.reason}.`);
            }
          }
        }
        if (keep) return;
        run(
          'git',
          previousTarget ? ['config', key, previousTarget] : ['config', '--unset', key],
          {cwd: repo.dir},
        );
      });
      await setTarget(repo.dir, name, target, run);
      const how = repo.branch === name ? 'already on' : exists ? 'switched to' : 'created';
      messages.push(`${repo.rel}: ${how} ${name} (target ${target})`);
    }
  } catch (error) {
    messages.push(`failed: ${(error as Error).message}`);
    return rollback();
  }
  const untouched = local.filter((r) => !selected.includes(r)).map((r) => r.rel);
  if (untouched.length) messages.push(`Left as they are: ${untouched.join(', ')}`);
  return {code: 0, messages};
}

/** The commander action for `branch status`. */
export async function runBranchStatus(options: {json?: boolean}): Promise<void> {
  const status = await branchStatus(findAppRoot(process.cwd()));
  process.stdout.write(
    (options.json ? JSON.stringify(status, null, 2) : formatBranchStatus(status)) + '\n',
  );
}

/** The commander action for `branch start`. */
export async function runBranchStart(
  name: string,
  packages: string[],
  options: {target: string},
): Promise<void> {
  const result = await branchStart(findAppRoot(process.cwd()), name, options.target, packages);
  const write = result.code === 0 ? console.log : console.error;
  for (const m of result.messages) write(m);
  process.exitCode = result.code;
}
