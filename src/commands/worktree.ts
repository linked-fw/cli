/**
 * `linked worktree add | list | remove` — an agent's worktree set.
 *
 * Run in the integration worktree set (`linked branch start`). `add <agent>`
 * creates a worktree of the app on `<integration>--<agent>` (or detached at
 * the integration tip, `--app-detached`, when the agent does not change the
 * app) next to the integration set, `<integration dir>-<agent>`, links
 * `node_modules` and the gitignored `.env` files to the main checkout's, and
 * nests a worktree on the agent branch of each `--with` package. A package the
 * integration set does not have yet joins it first: its integration worktree
 * is nested in the integration set, on the integration branch made from the
 * target. No main checkout is switched. The agent lands with a rebase and
 * `git -C <integration checkout> merge --ff-only <agent branch>`; `remove`
 * then deletes the set and its landed branches.
 */
import fs from 'node:fs';
import path from 'node:path';

import {findAppRoot} from '../localize/app-root.js';
import {readJson} from '../localize/fsops.js';
import {LOCAL_DIR} from '../localize/members.js';
import type {Run} from '../localize/run.js';
import {
  AGENT_SEPARATOR,
  agentBranch,
  branchExists,
  currentBranch,
  git,
  integrationOf,
  isAncestor,
  isCheckout,
  listRepos,
  mainCheckoutOf,
  matchesPackage,
  refExists,
  setTarget,
  worktreesOf,
  type RepoInfo,
} from '../integration/repos.js';
import {linkShared, privateKeys, refuseDir, unlinkShared} from '../integration/worktreeSet.js';
import {defaultCommandDeps, type CommandDeps} from './branch.js';

export interface WorktreeAddOptions {
  with?: string | string[];
  appDetached?: boolean;
  port?: string | number;
  dataset?: string;
  dir?: string;
}

/** The branch an agent's set starts from: the integration branch, else the app's current branch. */
function baseOf(run: Run, appRoot: string): {base: string | null; target: string | null; agent?: string} {
  const integration = integrationOf(appRoot, run);
  if (integration) return {base: integration.branch, target: integration.target, agent: integration.agent};
  return {base: currentBranch(run, appRoot), target: null};
}

/** Where an agent's set goes by default: next to a worktree set, else `<parent>/wt/<agent>`. */
export function defaultAgentDir(run: Run, appRoot: string, agent: string): string {
  const linkedWorktree = path.resolve(mainCheckoutOf(run, appRoot)) !== path.resolve(appRoot);
  return linkedWorktree
    ? path.join(path.dirname(appRoot), `${path.basename(appRoot)}-${agent}`)
    : path.join(path.dirname(appRoot), 'wt', agent);
}

function splitWith(value: WorktreeAddOptions['with']): string[] {
  const list = Array.isArray(value) ? value : value ? [value] : [];
  return list.flatMap((v) => v.split(',')).map((v) => v.trim()).filter(Boolean);
}

function startCommand(appRoot: string, dir: string, opts: WorktreeAddOptions): string[] {
  const scripts = readJson(path.join(appRoot, 'package.json'))?.scripts ?? {};
  const run = scripts['start:local'] ? 'npm run start:local' : scripts.start ? 'npm start' : 'npx linked start';
  const env = [`PORT=${opts.port ?? '<free port>'}`, ...(opts.dataset ? [`FUSEKI_DATASET=${opts.dataset}`] : [])];
  const lines = [`cd ${dir} && ${env.join(' ')} ${run}`];
  const backup = path.join(appRoot, 'scripts', 'backup-cn-state.sh');
  const restore = path.join(appRoot, 'scripts', 'restore-fuseki-dataset.sh');
  if (opts.dataset && fs.existsSync(backup) && fs.existsSync(restore)) {
    lines.unshift(
      'Clone the dataset first:',
      `  scripts/backup-cn-state.sh --yes`,
      `  scripts/restore-fuseki-dataset.sh <dump of the dataset to copy> ${opts.dataset} --yes`,
      'Then start:',
    );
  }
  return lines;
}

interface Joining {
  repo: RepoInfo;
  /** The integration worktree it gets, in the integration set. */
  at: string;
  branchExists: boolean;
}

export function worktreeAdd(agent: string, options: WorktreeAddOptions, deps: CommandDeps = defaultCommandDeps()): number {
  const {run, log, error} = deps;
  const appRoot = findAppRoot(deps.cwd);
  const mainRoot = mainCheckoutOf(run, appRoot);
  const {base, target, agent: inAgent} = baseOf(run, appRoot);
  if (inAgent) {
    error(`${appRoot} is agent ${inAgent}'s set; run linked worktree add in the integration set.`);
    return 1;
  }
  if (!base) {
    error(`${appRoot} is on a detached HEAD; run linked worktree add on the integration branch.`);
    return 1;
  }
  let branch: string;
  try {
    branch = agentBranch(base, agent);
  } catch (e) {
    error((e as Error).message);
    return 2;
  }
  const dir = path.resolve(deps.cwd, options.dir ?? defaultAgentDir(run, appRoot, agent));
  const refused = refuseDir(dir, [appRoot, mainRoot]);
  if (refused) {
    error(refused);
    return 1;
  }

  const here = listRepos(appRoot, run).slice(1);
  const main = path.resolve(mainRoot) === path.resolve(appRoot) ? here : listRepos(mainRoot, run).slice(1);
  const nested: RepoInfo[] = [];
  const joining: Joining[] = [];
  const problems: string[] = [];
  for (const name of splitWith(options.with)) {
    const own = here.find((r) => matchesPackage(r, name));
    if (own) {
      if (own.branch !== base)
        problems.push(`${own.rel} is on ${own.branch ?? 'a detached HEAD'}, not ${base}.`);
      if (!nested.includes(own)) nested.push(own);
      continue;
    }
    const repo = main.find((r) => matchesPackage(r, name));
    if (!repo) {
      problems.push(`No checkout of ${name} in ${path.join(mainRoot, LOCAL_DIR)}.`);
      continue;
    }
    if (!target) {
      problems.push(`${name} would join ${base}, which has no recorded target; start it with linked branch start.`);
      continue;
    }
    if (repo.dirty) problems.push(`${path.join(mainRoot, repo.rel)} has uncommitted changes or untracked files; commit or stash them first.`);
    const exists = branchExists(run, repo.dir, base);
    const holder = exists ? worktreesOf(run, repo.dir).find((w) => w.branch === base) : undefined;
    if (holder) problems.push(`${repo.rel}: ${base} is already checked out in ${holder.dir}.`);
    if (!exists && !refExists(run, repo.dir, target)) problems.push(`${repo.rel} has no ${target} to branch ${base} from.`);
    joining.push({repo, at: path.join(appRoot, LOCAL_DIR, path.basename(repo.dir)), branchExists: exists});
  }
  if (!options.appDetached && branchExists(run, appRoot, branch))
    problems.push(`The app already has a branch ${branch}.`);
  for (const repo of [...nested, ...joining.map((j) => j.repo)])
    if (branchExists(run, repo.dir, branch)) problems.push(`${repo.rel} already has a branch ${branch}.`);
  if (problems.length) {
    for (const p of problems) error(p);
    error('Nothing was created.');
    return 1;
  }

  const created: string[] = [];
  const step = (repoDir: string, args: string[], what: string): boolean => {
    const r = git(run, repoDir, args);
    if (r.status === 0) {
      created.push(what);
      return true;
    }
    error(`git ${args.join(' ')} failed in ${repoDir}: ${r.stderr.trim()}`);
    if (created.length) error(`Created so far: ${created.join(', ')}.`);
    return false;
  };

  // Packages joining midway get their integration worktree first.
  const packageRepos: {dirName: string; dir: string}[] = nested.map((r) => ({dirName: path.basename(r.dir), dir: r.dir}));
  for (const j of joining) {
    fs.mkdirSync(path.dirname(j.at), {recursive: true});
    const args = j.branchExists ? ['worktree', 'add', j.at, base] : ['worktree', 'add', '-b', base, j.at, target!];
    if (!step(j.repo.dir, args, j.at)) return 1;
    setTarget(j.repo.dir, base, target!, run);
    log(`${j.repo.packageName ?? j.repo.rel} joined ${base}: ${j.at}`);
    packageRepos.push({dirName: path.basename(j.at), dir: j.at});
  }

  const appArgs = options.appDetached
    ? ['worktree', 'add', '--detach', dir, base]
    : ['worktree', 'add', '-b', branch, dir, base];
  if (!step(appRoot, appArgs, dir)) return 1;
  const linked = linkShared(run, appRoot, dir);
  for (const p of packageRepos) {
    const at = path.join(dir, LOCAL_DIR, p.dirName);
    fs.mkdirSync(path.dirname(at), {recursive: true});
    if (!step(p.dir, ['worktree', 'add', '-b', branch, at, base], at)) return 1;
  }

  log(`Worktree set for ${agent} in ${dir}:`);
  log(`  app ${options.appDetached ? `detached at ${base}` : `on ${branch}`}`);
  for (const p of packageRepos) log(`  ${LOCAL_DIR}/${p.dirName} on ${branch}`);
  if (linked.length) log(`  linked: ${linked.join(', ')}`);
  const keys = privateKeys(run, mainRoot);
  if (keys.length) log(`  not linked: ${keys.join(', ')} (private keys; link one by hand if the app needs it)`);
  for (const l of startCommand(appRoot, dir, options)) log(l);
  log(`Land: rebase onto ${base}, then git -C <integration checkout> merge --ff-only ${branch}; then linked worktree remove ${agent}.`);
  return 0;
}

export interface AgentWorktree {
  agent: string;
  dir: string;
  /** The app worktree's branch, or null when detached. */
  branch: string | null;
  /** Null when detached. */
  landed: boolean | null;
  packages: {rel: string; dir: string; branch: string | null; landed: boolean | null}[];
}

/** Every agent set of the integration branch the app at `appRoot` is on. */
export function listAgentWorktrees(appRoot: string, run: Run): {base: string | null; sets: AgentWorktree[]} {
  const {base} = baseOf(run, appRoot);
  if (!base) return {base, sets: []};
  const prefix = `${base}${AGENT_SEPARATOR}`;
  const sets: AgentWorktree[] = [];
  for (const wt of worktreesOf(run, appRoot)) {
    if (wt.main || path.resolve(wt.dir) === path.resolve(appRoot)) continue;
    const packages: AgentWorktree['packages'] = [];
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(path.join(wt.dir, LOCAL_DIR)).sort();
    } catch {}
    for (const entry of entries) {
      const dir = path.join(wt.dir, LOCAL_DIR, entry);
      if (!isCheckout(dir)) continue;
      const b = currentBranch(run, dir);
      if (!b?.startsWith(prefix)) continue;
      packages.push({
        rel: `${LOCAL_DIR}/${entry}`,
        dir,
        branch: b,
        landed: isAncestor(run, dir, b, base),
      });
    }
    let agent: string | null = null;
    if (wt.branch?.startsWith(prefix)) agent = wt.branch.slice(prefix.length);
    else if (!wt.branch && packages.length) agent = packages[0].branch!.slice(prefix.length);
    else if (!wt.branch && path.basename(wt.dir).startsWith(`${path.basename(appRoot)}-`))
      agent = path.basename(wt.dir).slice(path.basename(appRoot).length + 1);
    if (!agent) continue;
    sets.push({
      agent,
      dir: wt.dir,
      branch: wt.branch,
      landed: wt.branch ? isAncestor(run, appRoot, wt.branch, base) : null,
      packages,
    });
  }
  return {base, sets};
}

const landedText = (l: boolean | null) => (l === null ? '-' : l ? 'landed' : 'not landed');

export function worktreeList(options: {json?: boolean}, deps: CommandDeps = defaultCommandDeps()): number {
  const appRoot = findAppRoot(deps.cwd);
  const {base, sets} = listAgentWorktrees(appRoot, deps.run);
  if (options.json) {
    deps.log(JSON.stringify(sets, null, 2));
    return 0;
  }
  if (!sets.length) {
    deps.log(base ? `No agent worktrees of ${base}.` : 'No agent worktrees (detached HEAD).');
    return 0;
  }
  for (const s of sets) {
    deps.log(`${s.agent}  ${s.dir}`);
    deps.log(`  app  ${s.branch ?? 'detached'}  ${landedText(s.landed)}`);
    for (const p of s.packages) deps.log(`  ${p.rel}  ${p.branch}  ${landedText(p.landed)}`);
  }
  return 0;
}

/** Remove the worktree at `at` from the repository it belongs to, run from another worktree of it. */
function removeWorktree(run: Run, at: string, force: boolean): {ok: boolean; repo: string; stderr: string} {
  const repo = worktreesOf(run, at).find((w) => path.resolve(w.dir) !== path.resolve(at))?.dir ?? mainCheckoutOf(run, at);
  const r = git(run, repo, ['worktree', 'remove', ...(force ? ['--force'] : []), at]);
  return {ok: r.status === 0, repo, stderr: r.stderr.trim()};
}

export function worktreeRemove(agent: string, options: {force?: boolean}, deps: CommandDeps = defaultCommandDeps()): number {
  const {run, log, error} = deps;
  const appRoot = findAppRoot(deps.cwd);
  const {base, sets} = listAgentWorktrees(appRoot, run);
  const set = sets.find((s) => s.agent === agent);
  if (!base || !set) {
    error(`No worktree set for ${agent}${base ? ` on ${base}` : ''}. linked worktree list shows them.`);
    return 1;
  }
  const unlanded = [
    ...(set.landed === false ? [`app ${set.branch}`] : []),
    ...set.packages.filter((p) => p.landed === false).map((p) => `${p.rel} ${p.branch}`),
  ];
  if (unlanded.length && !options.force) {
    error(`Not landed on ${base}: ${unlanded.join(', ')}. Land them (rebase, then merge --ff-only), or pass --force to remove the worktrees and keep those branches.`);
    return 1;
  }
  const force = !!options.force;
  const toDelete: {repo: string; branch: string}[] = [];
  for (const p of set.packages) {
    const r = removeWorktree(run, p.dir, force);
    if (!r.ok) {
      error(`git worktree remove ${p.dir} failed: ${r.stderr}`);
      return 1;
    }
    if (p.branch && p.landed) toDelete.push({repo: r.repo, branch: p.branch});
  }
  unlinkShared(set.dir);
  const r = removeWorktree(run, set.dir, force);
  if (!r.ok) {
    error(`git worktree remove ${set.dir} failed: ${r.stderr}`);
    return 1;
  }
  if (set.branch && set.landed) toDelete.push({repo: appRoot, branch: set.branch});
  for (const d of toDelete) {
    // `branch -d` checks against the HEAD of the worktree it runs in (often the
    // target); landed means merged into the integration branch, checked here.
    if (!isAncestor(run, d.repo, d.branch, base)) continue;
    const del = git(run, d.repo, ['branch', '-D', d.branch]);
    if (del.status !== 0) error(`git branch -d ${d.branch} failed in ${d.repo}: ${del.stderr.trim()}`);
  }
  log(`Removed ${agent}'s worktree set ${set.dir}.`);
  if (toDelete.length) log(`Deleted landed branches: ${[...new Set(toDelete.map((d) => d.branch))].join(', ')}.`);
  if (unlanded.length) log(`Kept unlanded branches: ${unlanded.join(', ')}.`);
  return 0;
}

export function runWorktreeAdd(agent: string, options: WorktreeAddOptions): void {
  process.exitCode = worktreeAdd(agent, options);
}
export function runWorktreeList(options: {json?: boolean}): void {
  process.exitCode = worktreeList(options);
}
export function runWorktreeRemove(agent: string, options: {force?: boolean}): void {
  process.exitCode = worktreeRemove(agent, options);
}
