/**
 * `linked release plan` — what releasing the integration branch involves,
 * per repository of the integration set it runs in.
 *
 * For each repository on the integration branch: the commits, reports
 * (`docs/reports/`) and changesets (`.changeset/`) it has that its target
 * lacks; the release PRs, found without labels as the PRs whose head starts
 * with `<integration>--` (agent branches share the prefix but are never
 * pushed), in stack order; the `## PR` section of each new report, which the
 * PR body is built from; and the next action. Repositories are ordered by
 * their dependencies on each other, the app last: framework PRs merge and
 * publish first.
 */
import path from 'node:path';

import {findAppRoot} from '../localize/app-root.js';
import {readJson} from '../localize/fsops.js';
import type {Run} from '../localize/run.js';
import {
  AGENT_SEPARATOR,
  aheadBehind,
  getTarget,
  git,
  integrationOf,
  listRepos,
  type RepoInfo,
} from '../integration/repos.js';
import {defaultCommandDeps, type CommandDeps} from './branch.js';

export interface ReleasePr {
  number: number;
  headRefName: string;
  baseRefName: string;
  state: string;
  url: string;
  mergedAt: string | null;
}

export type NextAction = 'open PRs' | 'waiting' | 'merge target back' | 'done' | 'unknown';

export interface RepoReleasePlan {
  rel: string;
  packageName?: string;
  target: string;
  commits: string[];
  /** Commits on the target the integration branch lacks. */
  behind: number;
  reports: {path: string; prSection: string | null}[];
  changesets: string[];
  /** In stack order; null when the PR state is unknown. */
  prs: ReleasePr[] | null;
  prError?: string;
  next: NextAction;
}

export interface ReleasePlan {
  integration: string | null;
  repos: RepoReleasePlan[];
}

/** The body of a report's `## PR` section: from the `## PR` line to the next `## ` heading. */
export function extractPrSection(markdown: string): string | null {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((l) => /^## PR\s*$/.test(l));
  if (start < 0) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith('## '));
  return (end < 0 ? rest : rest.slice(0, end)).join('\n').trim();
}

/** Base before head: a PR whose base is another release PR's head comes after it. */
export function stackOrder(prs: ReleasePr[]): ReleasePr[] {
  const heads = new Set(prs.map((p) => p.headRefName));
  const out: ReleasePr[] = [];
  const placed = new Set<string>();
  let layer = prs.filter((p) => !heads.has(p.baseRefName));
  while (layer.length) {
    layer.sort((a, b) => a.number - b.number);
    for (const p of layer) {
      out.push(p);
      placed.add(p.headRefName);
    }
    layer = prs.filter((p) => !placed.has(p.headRefName) && placed.has(p.baseRefName));
  }
  // A cycle or a dangling stack: keep the rest, by number.
  for (const p of prs.filter((p) => !out.includes(p)).sort((a, b) => a.number - b.number)) out.push(p);
  return out;
}

/** Repositories ordered so each comes after the ones its package.json depends on; the app last. */
export function dependencyOrder<T extends Pick<RepoInfo, 'rel' | 'dir' | 'packageName'>>(repos: T[]): T[] {
  const app = repos.filter((r) => r.rel === '.');
  const pkgs = repos.filter((r) => r.rel !== '.').sort((a, b) => (a.rel < b.rel ? -1 : 1));
  const byName = new Map(pkgs.filter((r) => r.packageName).map((r) => [r.packageName!, r]));
  const depsOf = (r: T): T[] => {
    const json = readJson(path.join(r.dir, 'package.json')) ?? {};
    const names = new Set<string>();
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'])
      for (const n of Object.keys(json[field] ?? {})) names.add(n);
    return [...names].map((n) => byName.get(n)).filter((d): d is T => !!d && d !== r);
  };
  const out: T[] = [];
  const state = new Map<T, 'visiting' | 'done'>();
  const visit = (r: T) => {
    if (state.get(r)) return;
    state.set(r, 'visiting');
    for (const d of depsOf(r)) visit(d);
    state.set(r, 'done');
    out.push(r);
  };
  for (const r of pkgs) visit(r);
  return [...out, ...app];
}

export function nextAction(p: Pick<RepoReleasePlan, 'commits' | 'behind' | 'prs'>): NextAction {
  if (p.prs?.some((pr) => pr.state === 'OPEN')) return 'waiting';
  if (p.prs === null) return p.commits.length ? 'unknown' : p.behind > 0 ? 'merge target back' : 'done';
  if (p.commits.length) return 'open PRs';
  if (p.behind > 0) return 'merge target back';
  return 'done';
}

function lines(out: string): string[] {
  return out.split('\n').map((l) => l.trim()).filter(Boolean);
}

function addedFiles(run: Run, dir: string, target: string, integration: string, under: string): string[] {
  const r = git(run, dir, ['diff', '--name-only', '--diff-filter=A', `${target}...${integration}`, '--', under]);
  return r.status === 0 ? lines(r.stdout) : [];
}

function releasePrs(run: Run, dir: string, integration: string): {prs: ReleasePr[] | null; error?: string} {
  const r = run('gh', ['pr', 'list', '--state', 'all', '--limit', '200', '--json', 'number,headRefName,baseRefName,state,url,mergedAt'], {cwd: dir});
  if (r.status !== 0) {
    const missing = /ENOENT|not found/i.test(r.stderr);
    return {prs: null, error: missing ? 'gh not found' : r.stderr.trim().split('\n')[0] || `gh exited ${r.status}`};
  }
  let all: ReleasePr[];
  try {
    all = JSON.parse(r.stdout || '[]');
  } catch {
    return {prs: null, error: 'gh printed no JSON'};
  }
  const prefix = `${integration}${AGENT_SEPARATOR}`;
  return {prs: stackOrder(all.filter((p) => p.headRefName?.startsWith(prefix)))};
}

export function releasePlan(appRoot: string, run: Run): ReleasePlan {
  const integration = integrationOf(appRoot, run);
  if (!integration) return {integration: null, repos: []};
  const branch = integration.branch;
  const onIt = listRepos(appRoot, run).filter(
    (r) => r.branch === branch || r.branch?.startsWith(`${branch}${AGENT_SEPARATOR}`),
  );
  const repos: RepoReleasePlan[] = [];
  for (const repo of dependencyOrder(onIt)) {
    const target = getTarget(repo.dir, branch, run) ?? integration.target;
    const log = git(run, repo.dir, ['log', '--format=%s', `${target}..${branch}`]);
    const commits = log.status === 0 ? lines(log.stdout) : [];
    let behind = 0;
    try {
      behind = aheadBehind(repo.dir, branch, target, run).behind;
    } catch {}
    const reports = addedFiles(run, repo.dir, target, branch, 'docs/reports')
      .filter((f) => f.endsWith('.md'))
      .map((f) => {
        const show = git(run, repo.dir, ['show', `${branch}:${f}`]);
        return {path: f, prSection: show.status === 0 ? extractPrSection(show.stdout) : null};
      });
    const changesets = addedFiles(run, repo.dir, target, branch, '.changeset').filter(
      (f) => f.endsWith('.md') && path.posix.basename(f) !== 'README.md',
    );
    const {prs, error} = releasePrs(run, repo.dir, branch);
    const plan: RepoReleasePlan = {
      rel: repo.rel,
      ...(repo.packageName ? {packageName: repo.packageName} : {}),
      target,
      commits,
      behind,
      reports,
      changesets,
      prs,
      ...(error ? {prError: error} : {}),
      next: 'done',
    };
    plan.next = nextAction(plan);
    repos.push(plan);
  }
  return {integration: branch, repos};
}

export function runReleasePlanWith(options: {json?: boolean}, deps: CommandDeps = defaultCommandDeps()): number {
  const appRoot = findAppRoot(deps.cwd);
  const plan = releasePlan(appRoot, deps.run);
  if (options.json) {
    deps.log(JSON.stringify(plan, null, 2));
    return plan.integration ? 0 : 1;
  }
  if (!plan.integration) {
    deps.error(`${appRoot} is not on an integration branch (a branch with a recorded target; see linked branch start).`);
    return 1;
  }
  const log = deps.log;
  log(`Release plan for ${plan.integration} (dependency order, app last):`);
  for (const r of plan.repos) {
    log('');
    log(`${r.rel === '.' ? 'app' : r.rel}${r.packageName ? ` (${r.packageName})` : ''} → ${r.target}: ${r.commits.length} commit(s) to release, ${r.behind} on the target not merged back`);
    for (const c of r.commits.slice(0, 30)) log(`  - ${c}`);
    if (r.commits.length > 30) log(`  … ${r.commits.length - 30} more`);
    for (const c of r.changesets) log(`  changeset ${c}`);
    for (const rep of r.reports) {
      log(`  report ${rep.path}${rep.prSection === null ? ': no PR section' : ''}`);
      if (rep.prSection) for (const l of rep.prSection.split('\n')) log(`    ${l}`);
    }
    if (r.prs === null) log(`  PR state unknown (${r.prError})`);
    else if (!r.prs.length) log('  no release PRs');
    else for (const pr of r.prs) log(`  PR #${pr.number} ${pr.headRefName} → ${pr.baseRefName} ${pr.state}${pr.url ? ` ${pr.url}` : ''}`);
    log(`  next: ${r.next}`);
  }
  return 0;
}

export function runReleasePlan(options: {json?: boolean}): void {
  process.exitCode = runReleasePlanWith(options);
}
