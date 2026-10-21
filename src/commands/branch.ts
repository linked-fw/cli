/**
 * `linked branch status` and `linked branch start`.
 *
 * An integration branch collects the work of many agents across the app and
 * the framework repositories it touches, and is released in one go. It lives
 * in a worktree set: main checkouts stay on their target. `start` creates the
 * set (default `<parent of the app>/wt/<name>`): a worktree of the app on
 * `<name>`, `node_modules` and the gitignored `.env` files linked to the main
 * checkout's, a worktree of each named package on `<name>` in its
 * `packages-local/`, and `branch.<name>.linked-target` in every repository.
 * Agents then work in their own sets made with `linked worktree add` from the
 * integration set. `status` reports each repository of the checkout it runs in.
 */
import fs from 'node:fs';
import path from 'node:path';

import {findAppRoot} from '../localize/app-root.js';
import {LOCAL_DIR} from '../localize/members.js';
import {makeRun, type Run} from '../localize/run.js';
import {
  AGENT_SEPARATOR,
  aheadBehind,
  branchExists,
  getTarget,
  git,
  integrationOf,
  listRepos,
  mainCheckoutOf,
  matchesPackage,
  refExists,
  setTarget,
  worktreesOf,
  type RepoInfo,
} from '../integration/repos.js';
import {linkShared, privateKeys, refuseDir} from '../integration/worktreeSet.js';

export interface CommandDeps {
  cwd: string;
  run: Run;
  log: (m: string) => void;
  error: (m: string) => void;
}

export function defaultCommandDeps(cwd: string = process.cwd()): CommandDeps {
  return {
    cwd,
    run: makeRun(cwd),
    log: (m) => console.log(m),
    error: (m) => console.error(m),
  };
}

export interface BranchStatusRow {
  rel: string;
  packageName?: string;
  /** The branch, or `detached`. */
  branch: string;
  target: string | null;
  dirty: boolean;
  aheadTarget: number | null;
  behindTarget: number | null;
  aheadIntegration: number | null;
  behindIntegration: number | null;
  flag: 'off-branch' | null;
}

function safeAheadBehind(run: Run, dir: string, a: string, b: string) {
  try {
    return aheadBehind(dir, a, b, run);
  } catch {
    return null;
  }
}

/** One row per repository of the checkout at `appRoot`. */
export function branchStatus(appRoot: string, run: Run): BranchStatusRow[] {
  const integration = integrationOf(appRoot, run);
  return listRepos(appRoot, run).map((repo) => {
    const ref = repo.branch ?? 'HEAD';
    // An agent branch is measured against its integration branch's target.
    const own = repo.branch ? getTarget(repo.dir, repo.branch, run) : null;
    const viaIntegration = integration ? getTarget(repo.dir, integration.branch, run) : null;
    const target = own ?? viaIntegration ?? integration?.target ?? null;
    const vsTarget = target ? safeAheadBehind(run, repo.dir, ref, target) : null;
    const vsIntegration =
      integration && branchExists(run, repo.dir, integration.branch)
        ? safeAheadBehind(run, repo.dir, ref, integration.branch)
        : null;
    let flag: BranchStatusRow['flag'] = null;
    if (integration && repo.branch) {
      const onIt =
        repo.branch === integration.branch ||
        repo.branch.startsWith(`${integration.branch}${AGENT_SEPARATOR}`) ||
        repo.branch === target;
      if (!onIt) flag = 'off-branch';
    }
    return {
      rel: repo.rel,
      ...(repo.packageName ? {packageName: repo.packageName} : {}),
      branch: repo.branch ?? 'detached',
      target,
      dirty: repo.dirty,
      aheadTarget: vsTarget?.ahead ?? null,
      behindTarget: vsTarget?.behind ?? null,
      aheadIntegration: vsIntegration?.ahead ?? null,
      behindIntegration: vsIntegration?.behind ?? null,
      flag,
    };
  });
}

function formatTable(header: string[], rows: string[][]): string[] {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd();
  return [line(header), ...rows.map(line)];
}

const counts = (a: number | null, b: number | null) => (a === null || b === null ? '-' : `+${a} -${b}`);

export function runBranchStatus(options: {json?: boolean}, deps = defaultCommandDeps()): number {
  const appRoot = findAppRoot(deps.cwd);
  const rows = branchStatus(appRoot, deps.run);
  if (options.json) {
    deps.log(JSON.stringify(rows, null, 2));
    return 0;
  }
  const integration = integrationOf(appRoot, deps.run);
  deps.log(
    integration
      ? `Integration branch ${integration.branch} (target ${integration.target})${integration.agent ? `, agent ${integration.agent}` : ''}`
      : 'No integration branch here (the app is on a branch without a recorded target).',
  );
  for (const l of formatTable(
    ['repository', 'branch', 'target', 'dirty', 'vs target', 'vs integration', 'flag'],
    rows.map((r) => [
      r.rel,
      r.branch,
      r.target ?? '-',
      r.dirty ? 'dirty' : '',
      counts(r.aheadTarget, r.behindTarget),
      counts(r.aheadIntegration, r.behindIntegration),
      r.flag ?? '',
    ]),
  ))
    deps.log(l);
  return 0;
}

export interface BranchStartOptions {
  target: string;
  dir?: string;
}

/**
 * Create the integration worktree set `<name>`. Every check runs before
 * anything is created, so a refusal changes nothing.
 */
export function branchStart(
  name: string,
  packages: string[],
  options: BranchStartOptions,
  deps = defaultCommandDeps(),
): number {
  const {run, log, error} = deps;
  const appRoot = mainCheckoutOf(run, findAppRoot(deps.cwd));
  const target = options.target;
  if (!target) {
    error('--target <branch> is required: the branch the integration branch is released to.');
    return 2;
  }
  if (name.includes(AGENT_SEPARATOR)) {
    error(`"${name}" contains "${AGENT_SEPARATOR}", which separates an integration branch from an agent's.`);
    return 2;
  }
  if (git(run, appRoot, ['check-ref-format', '--branch', name]).status !== 0) {
    error(`"${name}" is not a valid branch name.`);
    return 2;
  }
  const dir = path.resolve(deps.cwd, options.dir ?? path.join(path.dirname(appRoot), 'wt', name));
  const refused = refuseDir(dir, [appRoot]);
  if (refused) {
    error(refused);
    return 1;
  }

  const all = listRepos(appRoot, run);
  const repos: RepoInfo[] = [all[0]];
  for (const pkg of packages) {
    const match = all.slice(1).find((r) => matchesPackage(r, pkg));
    if (!match) {
      error(`No checkout of ${pkg} in ${path.join(appRoot, LOCAL_DIR)}. Localize it first: npx linked localize <npm name>.`);
      return 1;
    }
    if (!repos.includes(match)) repos.push(match);
  }

  const problems: string[] = [];
  for (const repo of repos) {
    if (repo.dirty)
      problems.push(`${repo.rel} has uncommitted changes or untracked files; commit or stash them first.`);
    const exists = branchExists(run, repo.dir, name);
    if (!exists && !refExists(run, repo.dir, target))
      problems.push(`${repo.rel} has no ${target} to branch ${name} from.`);
    const holder = exists ? worktreesOf(run, repo.dir).find((w) => w.branch === name) : undefined;
    if (holder) problems.push(`${repo.rel}: ${name} is already checked out in ${holder.dir}.`);
  }
  if (problems.length) {
    for (const p of problems) error(p);
    error('Nothing was created.');
    return 1;
  }

  const created: string[] = [];
  const addWorktree = (repo: RepoInfo, at: string): boolean => {
    const args = branchExists(run, repo.dir, name)
      ? ['worktree', 'add', at, name]
      : ['worktree', 'add', '-b', name, at, target];
    const r = git(run, repo.dir, args);
    if (r.status !== 0) {
      error(`git ${args.join(' ')} failed in ${repo.rel}: ${r.stderr.trim()}`);
      if (created.length) error(`Created so far: ${created.join(', ')}. Remove them with git worktree remove.`);
      return false;
    }
    setTarget(repo.dir, name, target, run);
    created.push(at);
    return true;
  };

  if (!addWorktree(repos[0], dir)) return 1;
  const linked = linkShared(run, appRoot, dir);
  for (const repo of repos.slice(1)) {
    const at = path.join(dir, LOCAL_DIR, path.basename(repo.dir));
    fs.mkdirSync(path.dirname(at), {recursive: true});
    if (!addWorktree(repo, at)) return 1;
  }

  log(`Integration branch ${name} (target ${target}) in ${dir}:`);
  for (const repo of repos) log(`  ${repo.rel === '.' ? 'app' : repo.rel} on ${name}`);
  if (linked.length) log(`  linked from ${appRoot}: ${linked.join(', ')}`);
  const keys = privateKeys(run, appRoot);
  if (keys.length)
    log(`  not linked: ${keys.join(', ')} (private keys; link one by hand if the app needs it)`);
  log(`Next: cd ${dir} && npx linked worktree add <agent> --with <package>`);
  return 0;
}

export function runBranchStart(
  name: string,
  packages: string[],
  options: BranchStartOptions,
): void {
  process.exitCode = branchStart(name, packages, options);
}

export function runBranchStatusCommand(options: {json?: boolean}): void {
  process.exitCode = runBranchStatus(options);
}
