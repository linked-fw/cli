/**
 * `linked branch status` and `linked branch start` — one integration branch
 * across an app and its `packages-local/` checkouts (the repo model is in
 * `../integration/repos.ts`).
 *
 * The core functions take the app root and an optional `run`, and return data
 * and an exit code; printing is separate, so tests drive them against real
 * throwaway repos.
 */
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

function refExists(run: Run, dir: string, ref: string): boolean {
  const r = run('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
    cwd: dir,
  });
  return r.status === 0;
}

function localBranchExists(run: Run, dir: string, branch: string): boolean {
  return refExists(run, dir, `refs/heads/${branch}`);
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
 * Put the app root and the named `packages-local/` checkouts on integration
 * branch `name`, created from `target` where it does not exist yet, and
 * record `target` for it in each. Every precondition is checked in every
 * selected repo before any is switched, so a refusal leaves all untouched.
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
  const check = run('git', ['check-ref-format', '--branch', name], {cwd: appRoot});
  if (check.status !== 0) return refuse(`"${name}" is not a valid branch name.`);

  const repos = await listRepos(appRoot, run);
  const [root, ...local] = repos;
  const selected: RepoInfo[] = [root];
  for (const wanted of packages) {
    const found = local.filter((r) => matches(r, wanted));
    if (found.length !== 1) {
      const available = local
        .map((r) => (r.packageName ? `${r.packageName} (${r.rel})` : r.rel))
        .join(', ');
      return refuse(
        found.length === 0
          ? `No checkout in packages-local/ matches "${wanted}". Available: ${available || 'none'}.`
          : `"${wanted}" matches several checkouts: ${found.map((r) => r.rel).join(', ')}. Use the full package name.`,
      );
    }
    if (!selected.includes(found[0])) selected.push(found[0]);
  }

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

  const messages: string[] = [];
  for (const {repo, exists} of plan) {
    if (repo.branch !== name) {
      const args = exists ? ['switch', name] : ['switch', '-c', name, target];
      const r = run('git', args, {cwd: repo.dir});
      if (r.status !== 0) {
        messages.push(`${repo.rel}: git ${args.join(' ')} failed: ${(r.stderr || r.stdout).trim()}`);
        return {code: 1, messages};
      }
    }
    await setTarget(repo.dir, name, target, run);
    const how = repo.branch === name ? 'already on' : exists ? 'switched to' : 'created';
    messages.push(`${repo.rel}: ${how} ${name} (target ${target})`);
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
