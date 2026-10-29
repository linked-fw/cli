/**
 * `linked branch start <m> --worktree` and `linked branch land <m>` — a
 * master's integration branch in a worktree of its own, so the owner's
 * checkouts stay on his stable branch (the records are in
 * `../integration/masters.ts`).
 *
 * `start --worktree` makes `<m>` in a new app worktree (default
 * `<parent of the app root>/wt/<m>`) with a nested worktree of each named
 * package, each from the branch the owner's checkout of that repo is on, and
 * a link farm into the main checkout's install; it never switches a checkout.
 * Steps of the master are `linked worktree add <agent> --from <m>`.
 *
 * `land` moves the master's work into the owner's branches: per repo,
 * frameworks first in dependency order and the app last, it merges the target
 * into `<m>` in the master's worktree (a merge, so the step commits the
 * reports cite keep their SHAs), stops when that made a commit so the master
 * re-tests, then fast-forwards the owner's checkout to `<m>`, builds each
 * landed framework checkout and pushes the target.
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import {
  freeMasterPort,
  listMasters,
  masterOf,
  MASTER_PORTS,
  MASTER_PORTS_LOCK,
  portHolder,
  readPortRegistry,
  recordPort,
  stepPorts,
  type PortEntry,
} from '../integration/masters.js';
import {withMachineLockAsync} from '../integration/repo-lock.js';
import {LocalizeError} from '../localize/errors.js';
import {currentBranch, getTarget, listRepos, setTarget, type RepoInfo} from '../integration/repos.js';
import {findAppRoot} from '../localize/app-root.js';
import {makeRun, type Run} from '../localize/run.js';
import {localBranchExists, refExists, selectCheckouts, worktreesOf} from './branch.js';
import {dependencyOrder} from './release.js';
import {
  createWorktreeSet,
  defaultWorktreeDir,
  mainCheckoutOf,
  realish,
  shellQuote,
  startCommandFor,
  startEnv,
  worktreeList,
} from './worktree.js';

export interface BranchStartWorktreeOptions {
  /** `packages-local/` checkouts to give a worktree on `<m>`. */
  with?: string[];
  /** The branch `<m>` starts from and lands in, in every repo; default each checkout's current branch. */
  target?: string;
  /** The preview port; default the first free `45k0` slot. */
  port?: number;
  dataset?: string;
  /** Where the worktree goes; default `<parent of the app root>/wt/<m>`. */
  dir?: string;
}

export interface BranchStartWorktreeResult {
  code: number;
  messages: string[];
  dir: string;
  port: number | null;
  /** The command that starts the master's preview; set on success. */
  startCommand?: string;
}

const failed = (r: {stdout: string; stderr: string}): string => (r.stderr || r.stdout).trim();

function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Start master `name` in a worktree of its own. Every precondition is checked
 * before anything is made; if a later step fails, what this run made is
 * undone.
 */
export async function branchStartWorktree(
  appRoot: string,
  name: string,
  options: BranchStartWorktreeOptions = {},
  run: Run = makeRun(appRoot),
): Promise<BranchStartWorktreeResult> {
  const root = realish(appRoot);
  const dir = realish(options.dir ?? defaultWorktreeDir(root, name));
  const result: BranchStartWorktreeResult = {code: 1, messages: [], dir, port: null};
  const refuse = (...messages: string[]): BranchStartWorktreeResult => {
    result.messages.push(...messages);
    return result;
  };

  if (!name) return refuse('A branch name is required.');
  if (name.includes('--')) {
    return refuse(
      `"${name}" contains "--", which separates an integration branch from an agent name (<integration>--<agent>). Choose another name.`,
    );
  }
  if (run('git', ['check-ref-format', '--branch', name], {cwd: root}).status !== 0) {
    return refuse(`"${name}" is not a valid branch name.`);
  }
  const main = worktreesOf(run, root)[0];
  if (!main || realish(main.path) !== root) {
    return refuse(`Run it in the main checkout${main ? ` (${main.path})` : ''}: a master branches from the owner's checkouts.`);
  }
  if (fs.existsSync(dir)) return refuse(`${dir} already exists.`);
  if (isInside(root, dir)) return refuse(`${dir} is inside the app root ${root}. Put the worktree outside it.`);

  const repos = await listRepos(root, run);
  const [app, ...local] = repos;
  const chosen = selectCheckouts(local, options.with ?? []);
  if ('error' in chosen) return refuse(chosen.error);
  const selected: RepoInfo[] = [app, ...chosen.repos];

  const problems: string[] = [];
  const plan = selected.map((repo) => ({repo, target: options.target ?? repo.branch}));
  for (const {repo, target} of plan) {
    if (!target) {
      problems.push(`${repo.rel}: detached HEAD; put it on the branch to work from, or pass --target.`);
      continue;
    }
    if (target === name) problems.push(`${repo.rel}: "${name}" is the target itself; an integration branch needs a name of its own.`);
    else if (!refExists(run, repo.dir, target)) problems.push(`${repo.rel}: "${target}" does not exist.`);
    if (localBranchExists(run, repo.dir, name)) problems.push(`${repo.rel}: branch ${name} already exists.`);
  }
  if (problems.length) return refuse(...problems, 'Nothing was made.');

  // Choosing the port, making the worktrees and recording the master hold the machine-wide lock, so
  // two masters started at once (in this app or another) never take one port.
  try {
    return await withMachineLockAsync(MASTER_PORTS_LOCK, `linked branch start ${name} --worktree (${root})`, async () => {
      const masters = await listMasters(run, root);
      const registry = readPortRegistry();
      if (options.port !== undefined) {
        const holder = portHolder(options.port, masters, registry);
        if (holder) return refuse(`Port ${options.port} is master ${holder.master}'s (${holder.dir}). Pick another, or leave --port out.`);
      }
      const port = options.port ?? freeMasterPort(masters, registry);
      if (port === null) return refuse(`Every preview slot (${MASTER_PORTS.join(', ')}) is taken by a master: remove one, or pass --port.`);
      result.port = port;
      const made = await makeMaster(root, name, dir, port, app, plan, local, selected, options, result, run);
      if (made.code === 0) recordPort({port, app: root, master: name, dir});
      return made;
    });
  } catch (error) {
    if (error instanceof LocalizeError) {
      result.code = error.code;
      result.messages.push(error.message, 'Nothing was made.');
      return result;
    }
    throw error;
  }
}

/** Make master `name` on `port` once every check passed: the worktrees, then the records. */
async function makeMaster(
  root: string,
  name: string,
  dir: string,
  port: number,
  app: RepoInfo,
  plan: {repo: RepoInfo; target: string | null}[],
  local: RepoInfo[],
  selected: RepoInfo[],
  options: BranchStartWorktreeOptions,
  result: BranchStartWorktreeResult,
  run: Run,
): Promise<BranchStartWorktreeResult> {
  const messages = result.messages;
  const undoSet = createWorktreeSet(
    {
      gitRoot: root,
      envRoot: root,
      installRoot: root,
      dir,
      app: {branch: name, start: plan[0].target!},
      packages: plan.slice(1).map(({repo, target}) => ({repo, branch: name, start: target!})),
    },
    messages,
    run,
  );
  if (!undoSet) {
    messages.push('Undid what this run had made.');
    return result;
  }

  const recorded: {repo: RepoInfo; key: string}[] = [];
  try {
    for (const {repo, target} of plan) {
      const worktreeDir = repo === app ? dir : path.join(dir, 'packages-local', path.basename(repo.dir));
      await setTarget(repo.dir, name, target!, run);
      recorded.push({repo, key: 'linked-target'});
      for (const [key, value] of [
        ['linked-worktree', worktreeDir],
        ...(repo === app ? [['linked-port', String(port)], ...(options.dataset ? [['linked-dataset', options.dataset]] : [])] : []),
      ] as [string, string][]) {
        const r = run('git', ['config', `branch.${name}.${key}`, value], {cwd: repo.dir});
        if (r.status !== 0) throw new Error(`git config branch.${name}.${key} failed in ${repo.rel}: ${failed(r)}`);
        recorded.push({repo, key});
      }
      messages.push(`${repo.rel}: ${name} from ${target} (target ${target})${repo.dirty ? '; it has uncommitted changes, which the master does not get' : ''}`);
      const remoteDefault = run('git', ['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD'], {cwd: repo.dir}).stdout.trim();
      if (remoteDefault === `origin/${target}`) {
        messages.push(
          `  Warning: ${target} is origin's default branch, and land pushes the target; a protected ${target} refuses that. Put that checkout on its integration branch first (or pass --target).`,
        );
      }
    }
  } catch (error) {
    messages.push(`failed: ${(error as Error).message}`);
    for (const {repo, key} of recorded.reverse()) run('git', ['config', '--unset', `branch.${name}.${key}`], {cwd: repo.dir});
    undoSet();
    messages.push('Undid what this run had made.');
    return result;
  }
  const untouched = local.filter((r) => !selected.includes(r)).map((r) => r.rel);
  if (untouched.length) messages.push(`No worktree (the install's copy is used): ${untouched.join(', ')}`);

  result.startCommand = startCommandFor(dir, startEnv(dir, port, options.dataset, true));
  messages.push(
    '',
    `Master ${name}: ${dir}. The owner's checkouts were not switched.`,
    `Preview: ${result.startCommand}`,
    `Preview link: http://localhost:${port} (its test runs: CN_TEST_PORT=${port + 1}; steps: ports ${stepPorts(port)}).`,
    `Steps: linked worktree add <agent> --from ${name} [--with <packages>] (run anywhere in the app).`,
    `After each landing into ${name}: npx linked build in each changed package worktree under ${path.join(dir, 'packages-local')}, then restart the preview.`,
    `When the owner approves: linked branch land ${name}, from ${root}.`,
  );
  if (options.dataset) {
    messages.push(
      `Clone the data into ${options.dataset} first (from ${root}): scripts/backup-cn-state.sh --yes, then scripts/restore-fuseki-dataset.sh <the cn-main dump> ${shellQuote(options.dataset)} --yes`,
    );
  }
  result.code = 0;
  return result;
}

export interface BranchLandOptions {
  /** Check and report what would happen; change nothing. */
  dryRun?: boolean;
  /** Stop after merging a moved target into `<m>`, so the master re-tests (default true). */
  retest?: boolean;
  /** Build each landed framework checkout (default true). */
  build?: boolean;
  /** Push each landed target to origin (default true). */
  push?: boolean;
}

export interface LandRepo {
  rel: string;
  packageName?: string;
  /** The master's worktree of the repo. */
  worktree: string;
  /** The owner's checkout. */
  checkout: string;
  target: string;
  /** What happened: nothing to land, merged the target in, conflict, fast-forwarded, … */
  result: 'up-to-date' | 'merged-target' | 'would-merge-target' | 'conflict' | 'landed' | 'would-land' | 'refused' | 'skipped';
  /** Commits the target gained. */
  commits?: number;
  files?: string[];
  built?: boolean;
  pushed?: boolean;
}

export interface BranchLandResult {
  /** 0 landed (or dry run), 1 refused, 3 re-test needed, 4 conflict, 5 landed but a build or push failed. */
  code: number;
  messages: string[];
  repos: LandRepo[];
}

/**
 * Land master `name` into the owner's checkouts (see the module comment).
 * Checks every repo before changing any: the master's worktrees clean and on
 * `<m>`, no step worktree unlanded, each owner checkout clean and on its
 * target. Stops at the first conflict, leaving the merge in progress in the
 * master's worktree for the agents whose work it touches.
 */
export async function branchLand(
  appRoot: string,
  name: string,
  options: BranchLandOptions = {},
  run: Run = makeRun(appRoot),
): Promise<BranchLandResult> {
  const root = realish(appRoot);
  const retest = options.retest ?? true;
  const build = options.build ?? true;
  const push = options.push ?? true;
  const result: BranchLandResult = {code: 1, messages: [], repos: []};
  const refuse = (...messages: string[]): BranchLandResult => {
    result.messages.push(...messages);
    return result;
  };

  const main = worktreesOf(run, root)[0];
  if (!main || realish(main.path) !== root) {
    return refuse(`Run it in the main checkout${main ? ` (${main.path})` : ''}: it lands into the owner's checkouts.`);
  }
  const master = await masterOf(run, root, name);
  if (!master) return refuse(`${name} is not a master: no branch.${name}.linked-worktree is recorded.`);
  const masterDir = realish(master.dir);
  if (!fs.existsSync(masterDir)) return refuse(`The worktree of master ${name} (${masterDir}) does not exist.`);

  const ordered = dependencyOrder(await listRepos(masterDir, run));
  const problems: string[] = [];
  const repos: LandRepo[] = [];
  for (const r of ordered) {
    const checkout = r.rel === '.' ? root : path.join(root, r.rel);
    const target = (await getTarget(r.dir, name, run)) ?? master.target;
    const entry: LandRepo = {rel: r.rel, packageName: r.packageName, worktree: r.dir, checkout, target: target ?? '', result: 'skipped'};
    repos.push(entry);
    if (!target) {
      problems.push(`${r.rel}: no target is recorded for ${name}.`);
      continue;
    }
    if (r.branch !== name) problems.push(`${r.rel}: the master's worktree ${r.dir} is on ${r.branch ?? 'a detached HEAD'}, not ${name}.`);
    if (fs.existsSync(path.join(gitDir(run, r.dir), 'MERGE_HEAD'))) {
      problems.push(`${r.rel}: a merge is in progress in ${r.dir}: resolve it and commit, then run land again.`);
    } else if (r.dirty) {
      problems.push(`${r.rel}: the master's worktree ${r.dir} has uncommitted or untracked changes.`);
    }
    if (!fs.existsSync(path.join(checkout, '.git'))) {
      problems.push(`${r.rel}: the owner has no checkout at ${checkout}.`);
      continue;
    }
    const ownerBranch = currentBranch(run, checkout);
    if (ownerBranch !== target) problems.push(`${r.rel}: the owner's checkout is on ${ownerBranch ?? 'a detached HEAD'}, not ${target}.`);
    const status = run('git', ['status', '--porcelain'], {cwd: checkout});
    if (status.status !== 0 || status.stdout.trim()) {
      problems.push(`${r.rel}: the owner's checkout ${checkout} has uncommitted or untracked changes; commit or stash them first.`);
    }
  }
  // A repo that records a worktree of <m> the master's worktree no longer has would be left out.
  const covered = new Set(ordered.map((r) => (r.rel === '.' ? root : path.join(root, r.rel))));
  for (const r of (await listRepos(root, run)).slice(1)) {
    const recorded = run('git', ['config', '--get', `branch.${name}.linked-worktree`], {cwd: r.dir}).stdout.trim();
    if (recorded && !covered.has(r.dir)) {
      problems.push(`${r.rel}: records a worktree of ${name} at ${recorded}, which is not in ${path.join(masterDir, 'packages-local')}; put it back, or land that repo by hand.`);
    }
  }
  // The owner's targets must have what origin has, or the push after landing is refused.
  for (const entry of repos) {
    if (!entry.target || !fs.existsSync(path.join(entry.checkout, '.git'))) continue;
    if (run('git', ['remote', 'get-url', 'origin'], {cwd: entry.checkout}).status !== 0) continue;
    const fetched = run('git', ['fetch', '-q', 'origin', entry.target], {cwd: entry.checkout});
    if (fetched.status !== 0) {
      result.messages.push(`${entry.rel}: could not fetch origin ${entry.target} (${failed(fetched)}); going on with the local ${entry.target}.`);
      continue;
    }
    if (run('git', ['merge-base', '--is-ancestor', 'FETCH_HEAD', entry.target], {cwd: entry.checkout}).status !== 0) {
      problems.push(`${entry.rel}: origin/${entry.target} has commits the local ${entry.target} lacks: git -C ${entry.checkout} pull --ff-only first.`);
    }
  }
  const steps = (await worktreeList(masterDir, {}, run)).worktrees;
  for (const s of steps) {
    const unlanded = [...(s.landed === false ? ['app'] : []), ...s.packages.filter((p) => p.landed === false).map((p) => p.packageName ?? p.rel)];
    if (unlanded.length) problems.push(`step ${s.agent} (${s.dir}) has not landed in ${name}: ${unlanded.join(', ')}.`);
  }
  result.repos = repos;
  if (problems.length) return refuse(...problems, 'Nothing was changed.');

  const isAncestor = (dir: string, a: string, b: string): boolean =>
    run('git', ['merge-base', '--is-ancestor', a, b], {cwd: dir}).status === 0;

  // Bring each target in: a merge commit only where the target moved.
  const merged: LandRepo[] = [];
  for (const entry of repos) {
    // Nothing to bring in: the target has nothing new, or has all of <m> already.
    if (isAncestor(entry.worktree, entry.target, name) || isAncestor(entry.worktree, name, entry.target)) continue;
    if (options.dryRun) {
      entry.result = 'would-merge-target';
      result.messages.push(`${entry.rel}: would merge ${entry.target} into ${name} (it moved since ${name} started).`);
      merged.push(entry);
      continue;
    }
    const r = run('git', ['merge', '--no-edit', '-m', `Merge ${entry.target} into ${name}`, entry.target], {cwd: entry.worktree});
    if (r.status !== 0) {
      const files = run('git', ['diff', '--name-only', '--diff-filter=U'], {cwd: entry.worktree})
        .stdout.split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
      entry.result = 'conflict';
      entry.files = files;
      result.code = 4;
      result.messages.push(
        `${entry.rel}: merging ${entry.target} into ${name} conflicts${files.length ? ` in ${files.join(', ')}` : `: ${failed(r)}`}.`,
        `The merge is left in progress in ${entry.worktree}: resolve it there (the agents whose work it touches), commit, re-test, then run land again.`,
      );
      if (merged.length) result.messages.push(`Already merged in this run: ${merged.map((m) => m.rel).join(', ')}.`);
      return result;
    }
    entry.result = 'merged-target';
    merged.push(entry);
    result.messages.push(`${entry.rel}: merged ${entry.target} into ${name}.`);
  }
  if (merged.length && retest && !options.dryRun) {
    result.code = 3;
    result.messages.push(
      '',
      `Re-test needed: the targets moved, so ${name} now has merge commits in ${merged.map((m) => (m.rel === '.' ? 'the app' : m.rel)).join(', ')}.`,
      `Build the merged package worktrees (npx linked build), run the regular set in ${masterDir}, then run land again (or --no-retest).`,
    );
    return result;
  }

  // Every target must be in <m> now, or a fast-forward fails halfway through.
  if (!options.dryRun) {
    const behind = repos.filter((e) => e.target && !isAncestor(e.worktree, e.target, name));
    if (behind.length) {
      return refuse(`${behind.map((e) => `${e.rel}: ${e.target}`).join(', ')} moved since the merge: run land again.`);
    }
  }
  // Fast-forward the owner's checkouts.
  const before = new Map(repos.map((e) => [e, run('git', ['rev-parse', 'HEAD'], {cwd: e.checkout}).stdout.trim()]));
  const landed: LandRepo[] = [];
  for (const entry of repos) {
    if (entry.result === 'would-merge-target') continue;
    if (isAncestor(entry.checkout, name, entry.target)) {
      entry.result = entry.result === 'merged-target' ? entry.result : 'up-to-date';
      continue;
    }
    const commits = Number.parseInt(
      run('git', ['rev-list', '--count', `${entry.target}..${name}`], {cwd: entry.checkout}).stdout.trim(),
      10,
    );
    entry.commits = Number.isFinite(commits) ? commits : undefined;
    if (options.dryRun) {
      entry.result = 'would-land';
      result.messages.push(`${entry.rel}: would fast-forward ${entry.target} by ${entry.commits ?? '?'} commits.`);
      continue;
    }
    const r = run('git', ['merge', '--ff-only', name], {cwd: entry.checkout});
    if (r.status !== 0) {
      entry.result = 'refused';
      result.code = 1;
      result.messages.push(
        `${entry.rel}: git merge --ff-only ${name} failed in ${entry.checkout}: ${failed(r)}`,
        `${entry.target} moved meanwhile: run land again, which merges it into ${name} first.`,
        ...(landed.length
          ? [`Already landed: ${landed.map((l) => `${l.rel} (${l.target} was ${before.get(l)?.slice(0, 12)})`).join(', ')}.`]
          : []),
      );
      return result;
    }
    entry.result = 'landed';
    landed.push(entry);
    result.messages.push(`${entry.rel}: ${entry.target} fast-forwarded to ${name} (${entry.commits ?? '?'} commits).`);
  }
  if (options.dryRun) {
    result.code = 0;
    result.messages.push(...(repos.every((r) => r.result === 'up-to-date' || r.result === 'skipped') ? [`Nothing to land: every target has ${name}.`] : []));
    return result;
  }

  let trouble = false;
  for (const entry of landed) {
    if (!build || entry.rel === '.') continue;
    const r = run('npx', ['linked', 'build'], {cwd: entry.checkout});
    entry.built = r.status === 0;
    if (!entry.built) {
      trouble = true;
      result.messages.push(`${entry.rel}: npx linked build failed in ${entry.checkout}: ${failed(r).split('\n').slice(-5).join('\n')}`);
    } else result.messages.push(`${entry.rel}: built.`);
  }
  for (const entry of landed) {
    if (!push) continue;
    if (run('git', ['remote', 'get-url', 'origin'], {cwd: entry.checkout}).status !== 0) continue;
    if (entry.built === false) {
      result.messages.push(`${entry.rel}: not pushed, because its build failed: fix it, then git -C ${entry.checkout} push origin ${entry.target}.`);
      continue;
    }
    const r = run('git', ['push', 'origin', entry.target], {cwd: entry.checkout});
    entry.pushed = r.status === 0;
    if (!entry.pushed) {
      trouble = true;
      result.messages.push(`${entry.rel}: git push origin ${entry.target} failed: ${failed(r)}`);
    } else result.messages.push(`${entry.rel}: pushed ${entry.target}.`);
  }
  result.code = trouble ? 5 : 0;
  result.messages.push(
    '',
    landed.length ? `Landed ${name}${trouble ? ', with the failures above' : ''}. Restart the CN on ${root} so it runs the landed code.` : `Nothing to land: every target has ${name}.`,
    `Remove the master once done with it: linked worktree remove ${name}.`,
  );
  return result;
}

/** The git dir of the worktree at `dir` (where a merge in progress keeps MERGE_HEAD). */
function gitDir(run: Run, dir: string): string {
  const r = run('git', ['rev-parse', '--absolute-git-dir'], {cwd: dir});
  return r.stdout.trim() || path.join(dir, '.git');
}

/** The commander action for `branch start --worktree`. */
export async function runBranchStartWorktree(
  name: string,
  packages: string[],
  options: {with?: string; target?: string; port?: string; dataset?: string; dir?: string},
): Promise<void> {
  const port = options.port === undefined ? undefined : Number.parseInt(options.port, 10);
  if (port !== undefined && !Number.isInteger(port)) {
    console.error(`--port must be a number, got "${options.port}".`);
    process.exitCode = 1;
    return;
  }
  const withList = [...packages, ...(options.with ? options.with.split(',') : [])].map((s) => s.trim()).filter(Boolean);
  const result = await branchStartWorktree(findAppRoot(process.cwd()), name, {
    with: withList,
    target: options.target,
    port,
    dataset: options.dataset,
    dir: options.dir ? path.resolve(process.cwd(), options.dir) : undefined,
  });
  const write = result.code === 0 ? console.log : console.error;
  for (const m of result.messages) write(m);
  process.exitCode = result.code;
}

/** The commander action for `branch land`. */
export async function runBranchLand(
  name: string,
  options: {dryRun?: boolean; retest?: boolean; build?: boolean; push?: boolean; json?: boolean},
): Promise<void> {
  const result = await branchLand(findAppRoot(process.cwd()), name, {
    dryRun: options.dryRun,
    retest: options.retest,
    build: options.build,
    push: options.push,
  });
  if (options.json) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  else {
    const write = result.code === 0 ? console.log : console.error;
    for (const m of result.messages) write(m);
  }
  process.exitCode = result.code;
}

export interface BranchListRepo {
  /** `.` for the app, `packages-local/<dir>` for a package checkout. */
  rel: string;
  target: string | null;
  /** That repo's worktree of the branch, when it records one (a master's). */
  worktree: string | null;
}

export interface BranchListEntry {
  name: string;
  kind: 'master' | 'integration';
  /** The app's target, else the first repo's. */
  target: string | null;
  repos: BranchListRepo[];
  /** A master's app worktree. */
  dir: string | null;
  port: number | null;
  dataset: string | null;
  /** A master's step agents. */
  steps: string[];
}

export interface BranchList {
  branches: BranchListEntry[];
  /** Masters of other apps holding a preview port on this machine (the port registry). */
  otherPorts: PortEntry[];
}

/** `branch.<b>.linked-target` and `-worktree` of the repo at `dir`, by branch. */
function branchRecords(run: Run, dir: string): Map<string, {target: string | null; worktree: string | null}> {
  const out = new Map<string, {target: string | null; worktree: string | null}>();
  const r = run('git', ['config', '--get-regexp', '^branch\\..*\\.linked-(target|worktree)$'], {cwd: dir});
  if (r.status !== 0) return out;
  for (const line of r.stdout.split('\n')) {
    const space = line.indexOf(' ');
    if (space < 0) continue;
    const key = line.slice(0, space);
    const value = line.slice(space + 1).trim();
    const m = /^branch\.(.+)\.linked-(target|worktree)$/.exec(key);
    if (!m || !value) continue;
    const rec = out.get(m[1]) ?? {target: null, worktree: null};
    if (m[2] === 'target') rec.target = value;
    else rec.worktree = value;
    out.set(m[1], rec);
  }
  return out;
}

/**
 * `linked branch list`: the app's integration branches and masters in one view, from the
 * `branch.<b>.linked-target` and `-worktree` records of the app repo and every `packages-local/`
 * checkout, the masters' ports, datasets and steps, and the other apps' masters on this machine.
 * Run anywhere in the app: it lists from the main checkout.
 */
export async function branchList(appRoot: string, run: Run = makeRun(appRoot)): Promise<BranchList> {
  const here = realish(appRoot);
  const root = mainCheckoutOf(run, here) ?? here;
  const repos = await listRepos(root, run);
  const masters = new Map((await listMasters(run, root)).map((m) => [m.name, m]));
  const listed = await worktreeList(root, {all: true}, run);
  const stepsOf = new Map(listed.masters.map((m) => [m.name, m.steps.map((s) => s.agent)]));

  const byName = new Map<string, BranchListRepo[]>();
  for (const repo of repos) {
    for (const [name, rec] of branchRecords(run, repo.dir)) {
      const list = byName.get(name) ?? [];
      list.push({rel: repo.rel, target: rec.target, worktree: rec.worktree});
      byName.set(name, list);
    }
  }
  const branches: BranchListEntry[] = [...byName].map(([name, list]) => {
    const master = masters.get(name);
    return {
      name,
      kind: master ? 'master' : 'integration',
      target: list.find((r) => r.rel === '.')?.target ?? list.find((r) => r.target)?.target ?? null,
      repos: list,
      dir: master?.dir ?? null,
      port: master?.port ?? null,
      dataset: master?.dataset ?? null,
      steps: master ? stepsOf.get(name) ?? [] : [],
    };
  });
  branches.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'master' ? -1 : 1));
  const otherPorts = readPortRegistry().filter((e) => realish(e.app) !== root);
  return {branches, otherPorts};
}

/** The table of `branch list`. */
export function formatBranchList(list: BranchList): string {
  const header = ['BRANCH', 'KIND', 'TARGET', 'REPOS', 'WORKTREE', 'PORT', 'DATASET', 'STEPS'];
  const rows = list.branches.map((b) => [
    b.name,
    b.kind,
    b.target ?? '-',
    b.repos.map((r) => (r.rel === '.' ? 'app' : path.basename(r.rel))).join(', '),
    b.dir ?? '(checkouts)',
    b.port === null ? '-' : String(b.port),
    b.dataset ?? '-',
    b.kind === 'master' ? String(b.steps.length) : '-',
  ]);
  const lines: string[] = [];
  if (rows.length) {
    const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
    for (const r of [header, ...rows]) lines.push(r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i]))).join('  ').trimEnd());
  } else {
    lines.push('No integration branches or masters.');
  }
  if (list.otherPorts.length) {
    lines.push(`Other masters on this machine: ${list.otherPorts.map((e) => `${e.port} ${e.master} (${e.app})`).join(', ')}`);
  }
  return lines.join('\n');
}

/** The commander action for `branch list`. */
export async function runBranchList(options: {json?: boolean}): Promise<void> {
  const list = await branchList(process.cwd());
  process.stdout.write((options.json ? JSON.stringify(list, null, 2) : formatBranchList(list)) + '\n');
  process.exitCode = 0;
}
