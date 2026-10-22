/**
 * `linked release plan` — what the app's integration branch would release,
 * per repo, and the state of its release PRs.
 *
 * A release opens PRs per repo from branches cut for it and named
 * `<integration>--<what>`; several PRs in one repo are stacked (each later
 * PR's base is the earlier PR's branch). Agent branches share the prefix but
 * are never pushed, so the PRs whose head starts with `<integration>--` are
 * the release. Framework repos are released first, in dependency order, the
 * app last.
 *
 * `releasePlan` takes the app root and optional `run` (git) and `gh` seams and
 * returns data; `formatReleasePlan` prints it. Nothing is changed.
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import {
  getTarget,
  git,
  integrationOf,
  listRepos,
  type Integration,
  type RepoInfo,
} from '../integration/repos.js';
import {findAppRoot} from '../localize/app-root.js';
import {makeRun, type Run} from '../localize/run.js';
import {refExists} from './branch.js';

export const NO_PR_SECTION = 'no PR section';

export interface ReleaseReport {
  /** Path in the repo, e.g. `docs/reports/091-webid-local.md`. */
  path: string;
  /** The report's `## PR` section without its heading, or `no PR section`. */
  pr: string;
}

export interface ReleasePr {
  number: number;
  headRefName: string;
  baseRefName: string;
  /** As gh reports it: `OPEN`, `CLOSED` or `MERGED`. */
  state: string;
  url: string;
  mergedAt: string | null;
}

/**
 * - `open PRs`: commits to release and no open or merged release PR.
 * - `waiting`: at least one release PR is open.
 * - `merge target back`: every release PR is merged, and the target has
 *   commits the integration branch lacks (the merges of those PRs).
 * - `done`: every release PR is merged and nothing is left: no commits to
 *   release, and the target holds nothing the integration branch lacks.
 * - `nothing to release`: no commits to release and no release PR.
 * - `PR state unknown`: gh failed, so the PRs, and hence the action, are not
 *   known.
 *
 * Release PRs closed without merging are listed but do not count.
 */
export type NextAction =
  | 'open PRs'
  | 'waiting'
  | 'merge target back'
  | 'done'
  | 'nothing to release'
  | 'PR state unknown';

export interface ReleaseRepo {
  /** `.` for the app root, `packages-local/<dir>` otherwise. */
  repo: string;
  packageName?: string;
  target: string;
  /** Set when the plan could not be read for this repo (e.g. the target does not exist); the other fields are then empty. */
  error?: string;
  /**
   * Non-merge commits on the integration branch that the target lacks
   * (`git log --no-merges <target>..<integration>`), newest first. Merge
   * commits are left out so that merging the target back after a release
   * does not count as something new to release.
   */
  commits: {count: number; subjects: string[]};
  /** Commits the target has that the integration branch lacks. */
  targetAhead: number;
  /** Reports added under `docs/reports/` on the integration branch. */
  reports: ReleaseReport[];
  /** Changesets added under `.changeset/` (without README.md and config.json). */
  changesets: string[];
  /** The release PRs in stack order (bottom first). */
  prs: ReleasePr[];
  prState: 'known' | 'unknown';
  /** Why the PR state is unknown: `gh not found`, or the first line of gh's error. */
  prReason?: string;
  next: NextAction;
  /**
   * What may make the plan wrong, each a short sentence:
   * - `no changeset: merging will not publish`: the repo uses changesets
   *   (`.changeset/config.json` at the integration tip), has commits to
   *   release, and adds no changeset;
   * - `target behind origin/<target>: fetch first`: the remote-tracking ref
   *   has commits the local target lacks. The plan compares against the
   *   local target and never fetches, so it may be stale.
   */
  warnings: string[];
}

export interface ReleasePlan {
  integration: Integration | null;
  /** Repos on the integration branch, in release order: dependencies first, the app root last. */
  repos: ReleaseRepo[];
  /** Repos not on the integration branch, which the release leaves out. */
  skipped: string[];
}

export interface ReleasePlanOptions {
  run?: Run;
  /** Runs `gh`; the default spawns it. It may throw (e.g. ENOENT) or return a non-zero status. */
  gh?: Run;
}

const lines = (s: string): string[] => s.split('\n').map((l) => l.trim()).filter(Boolean);

/**
 * The `## PR` section of a report: from the line after `## PR` up to the next
 * `## ` heading (or the end), trimmed. `no PR section` when there is none.
 */
export function extractPrSection(markdown: string): string {
  const all = markdown.split(/\r?\n/);
  const start = all.findIndex((l) => /^## PR\s*$/.test(l));
  if (start < 0) return NO_PR_SECTION;
  const rest = all.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith('## '));
  const section = (end < 0 ? rest : rest.slice(0, end)).join('\n').trim();
  return section || NO_PR_SECTION;
}

/**
 * The PRs in stack order: a PR whose base is no other listed PR's head starts
 * a stack, and is followed by the PR based on it, and so on. Several stacks,
 * or several PRs on one base, go by PR number.
 */
export function stackOrder(prs: ReleasePr[]): ReleasePr[] {
  const byNumber = [...prs].sort((a, b) => a.number - b.number);
  const heads = new Set(byNumber.map((p) => p.headRefName));
  const ordered: ReleasePr[] = [];
  const visit = (pr: ReleasePr): void => {
    if (ordered.includes(pr)) return;
    ordered.push(pr);
    for (const child of byNumber.filter((p) => p.baseRefName === pr.headRefName)) visit(child);
  };
  for (const pr of byNumber.filter((p) => !heads.has(p.baseRefName))) visit(pr);
  // A cycle of bases (not possible on GitHub, but in the data) keeps PR order.
  for (const pr of byNumber) visit(pr);
  return ordered;
}

function readDeps(dir: string): string[] {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    const names = new Set<string>();
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
      const deps = pkg[field];
      if (deps && typeof deps === 'object') for (const n of Object.keys(deps)) names.add(n);
    }
    return [...names];
  } catch {
    return [];
  }
}

/**
 * Repos in release order: each after the listed repos its `package.json`
 * depends on (dependencies, devDependencies, peerDependencies), ties broken
 * by `rel`, and the app root (`.`) last. Repos in a dependency cycle follow
 * in `rel` order.
 */
export function dependencyOrder<T extends {rel: string; dir: string; packageName?: string}>(
  repos: T[],
): T[] {
  const root = repos.filter((r) => r.rel === '.');
  const rest = repos.filter((r) => r.rel !== '.').sort((a, b) => a.rel.localeCompare(b.rel));
  const byName = new Map(rest.filter((r) => r.packageName).map((r) => [r.packageName!, r]));
  const needs = new Map(
    rest.map((r) => [
      r,
      new Set(readDeps(r.dir).map((n) => byName.get(n)).filter((d): d is T => !!d && d !== r)),
    ]),
  );
  const ordered: T[] = [];
  while (ordered.length < rest.length) {
    const ready = rest.find(
      (r) => !ordered.includes(r) && [...needs.get(r)!].every((d) => ordered.includes(d)),
    );
    if (!ready) {
      ordered.push(...rest.filter((r) => !ordered.includes(r)));
      break;
    }
    ordered.push(ready);
  }
  return [...ordered, ...root];
}

/** The release PRs in `dir`, or why they could not be read. */
function releasePrs(
  gh: Run,
  dir: string,
  integration: string,
): {prs: ReleasePr[]} | {reason: string} {
  let r;
  try {
    r = gh(
      'gh',
      ['pr', 'list', '--state', 'all', '--json', 'number,headRefName,baseRefName,state,url,mergedAt', '--limit', '200'],
      {cwd: dir},
    );
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return {reason: code === 'ENOENT' ? 'gh not found' : String((e as Error).message).split('\n')[0]};
  }
  if (r.status !== 0) {
    const msg = (r.stderr || r.stdout).trim();
    // The default runner reports a missing binary as `spawnSync gh ENOENT`.
    if (/\bENOENT\b/.test(msg)) return {reason: 'gh not found'};
    return {reason: msg.split('\n')[0] || `gh exited ${r.status}`};
  }
  let all: ReleasePr[];
  try {
    all = JSON.parse(r.stdout) as ReleasePr[];
  } catch {
    return {reason: 'gh printed something other than JSON'};
  }
  const prefix = `${integration}--`;
  return {prs: stackOrder(all.filter((p) => p.headRefName.startsWith(prefix)))};
}

function nextAction(repo: Omit<ReleaseRepo, 'next'>): NextAction {
  if (repo.prState === 'unknown') return 'PR state unknown';
  const live = repo.prs.filter((p) => p.state === 'OPEN' || p.state === 'MERGED');
  if (live.some((p) => p.state === 'OPEN')) return 'waiting';
  if (live.length === 0) return repo.commits.count > 0 ? 'open PRs' : 'nothing to release';
  if (repo.targetAhead > 0) return 'merge target back';
  // Every release PR merged and the target merged back: what is left is new work.
  return repo.commits.count > 0 ? 'open PRs' : 'done';
}

async function planRepo(
  run: Run,
  gh: Run,
  repo: RepoInfo,
  integration: Integration,
): Promise<ReleaseRepo> {
  const target = (await getTarget(repo.dir, integration.branch, run)) ?? integration.target;
  const base = {
    repo: repo.rel,
    packageName: repo.packageName,
    target,
    commits: {count: 0, subjects: [] as string[]},
    targetAhead: 0,
    reports: [] as ReleaseReport[],
    changesets: [] as string[],
    prs: [] as ReleasePr[],
    prState: 'known' as const,
    warnings: [] as string[],
  };
  if (!refExists(run, repo.dir, target)) {
    return {...base, error: `target "${target}" does not exist`, next: 'nothing to release'};
  }
  const tip = integration.branch;
  const subjects = lines(
    git(run, repo.dir, ['log', '--no-merges', '--format=%s', `${target}..${tip}`]),
  );
  const targetAhead = Number.parseInt(
    git(run, repo.dir, ['rev-list', '--count', `${tip}..${target}`]),
    10,
  );
  const added = (dir: string): string[] =>
    lines(git(run, repo.dir, ['diff', '--name-only', '--diff-filter=A', `${target}...${tip}`, '--', dir]));
  const reports = added('docs/reports')
    .filter((p) => p.endsWith('.md'))
    .map((p) => ({path: p, pr: extractPrSection(git(run, repo.dir, ['show', `${tip}:${p}`]))}));
  const changesets = added('.changeset').filter(
    (p) => p.endsWith('.md') && !['.changeset/README.md', '.changeset/config.json'].includes(p),
  );
  const warnings: string[] = [];
  const usesChangesets =
    run('git', ['cat-file', '-e', `${tip}:.changeset/config.json`], {cwd: repo.dir}).status === 0;
  if (usesChangesets && subjects.length > 0 && changesets.length === 0) {
    warnings.push('no changeset: merging will not publish');
  }
  const remote = `refs/remotes/origin/${target}`;
  if (refExists(run, repo.dir, remote)) {
    const behind = Number.parseInt(
      git(run, repo.dir, ['rev-list', '--count', `${target}..${remote}`]),
      10,
    );
    if (behind > 0) warnings.push(`target behind origin/${target}: fetch first`);
  }
  const found = releasePrs(gh, repo.dir, integration.branch);
  const partial = {
    ...base,
    warnings,
    commits: {count: subjects.length, subjects},
    targetAhead,
    reports,
    changesets,
    ...('prs' in found
      ? {prs: found.prs, prState: 'known' as const}
      : {prState: 'unknown' as const, prReason: found.reason}),
  };
  return {...partial, next: nextAction(partial)};
}

export async function releasePlan(
  appRoot: string,
  options: ReleasePlanOptions = {},
): Promise<ReleasePlan> {
  const run = options.run ?? makeRun(appRoot);
  const gh = options.gh ?? makeRun(appRoot);
  const integration = await integrationOf(appRoot, run);
  if (!integration) return {integration: null, repos: [], skipped: []};
  const all = await listRepos(appRoot, run);
  const on = all.filter((r) => r.branch === integration.branch);
  const skipped = all.filter((r) => !on.includes(r)).map((r) => r.rel);
  const repos: ReleaseRepo[] = [];
  for (const repo of dependencyOrder(on)) {
    repos.push(await planRepo(run, gh, repo, integration));
  }
  return {integration, repos, skipped};
}

const indent = (s: string, by: string): string =>
  s.split('\n').map((l) => (l ? by + l : l)).join('\n');

export function formatReleasePlan(plan: ReleasePlan): string {
  if (!plan.integration) {
    return 'No integration branch: the app root is not on a branch with a recorded target. Nothing to release.';
  }
  const out: string[] = [
    `Release of ${plan.integration.branch} (target ${plan.integration.target}), in order:`,
  ];
  plan.repos.forEach((r, i) => {
    out.push('', `${i + 1}. ${r.repo}${r.packageName ? ` (${r.packageName})` : ''} -> ${r.target}`);
    if (r.error) {
      out.push(`   error: ${r.error}`);
      return;
    }
    out.push(`   next: ${r.next}`);
    for (const w of r.warnings) out.push(`   warning: ${w}`);
    out.push(`   commits: ${r.commits.count}`);
    for (const s of r.commits.subjects) out.push(`     - ${s}`);
    if (r.targetAhead > 0) out.push(`   target has ${r.targetAhead} commit(s) not in ${plan.integration!.branch}`);
    out.push(`   changesets: ${r.changesets.length ? r.changesets.join(', ') : 'none'}`);
    if (r.prState === 'unknown') {
      out.push(`   PRs: PR state unknown (${r.prReason})`);
    } else if (!r.prs.length) {
      out.push('   PRs: none');
    } else {
      out.push('   PRs (stack order):');
      for (const p of r.prs) {
        out.push(`     - #${p.number} ${p.headRefName} -> ${p.baseRefName} ${p.state} ${p.url}`);
      }
    }
    out.push(`   reports: ${r.reports.length ? '' : 'none'}`.trimEnd());
    for (const rep of r.reports) {
      out.push(`     - ${rep.path}`);
      out.push(indent(rep.pr, '         '));
    }
  });
  if (plan.skipped.length) {
    out.push('', `Not on ${plan.integration.branch} (left out): ${plan.skipped.join(', ')}`);
  }
  return out.join('\n');
}

/** The commander action for `release plan`. */
export async function runReleasePlan(options: {json?: boolean}): Promise<void> {
  const plan = await releasePlan(findAppRoot(process.cwd()));
  process.stdout.write(
    (options.json ? JSON.stringify(plan, null, 2) : formatReleasePlan(plan)) + '\n',
  );
}
