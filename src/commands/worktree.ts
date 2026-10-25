/**
 * `linked worktree add | list | remove` — an agent's worktree of an app, with
 * a nested worktree of each framework package it changes.
 *
 * Layout: `<dir>` (default `<parent of the app root>/wt/<agent>`) is a git
 * worktree of the app, on the agent branch `<base>--<agent>` (or detached at
 * the base tip with `--app-detached`). Every package the agent changes is a
 * worktree of that package's `packages-local/` checkout at
 * `<dir>/packages-local/<dirName>`, on the same agent branch. Its
 * `node_modules` is a link farm into the app root's install (see
 * worktree-node-modules.ts): it shares the main checkout's install, except
 * that those package names, and only those, link to the worktree's copies, so
 * Vite, tsc and Node all load them.
 *
 * The base is the root's integration branch, or the root's current branch
 * when it has none. Agents land by fast-forwarding the base to their branch;
 * `remove` refuses until every agent branch has landed, unless told otherwise.
 *
 * The core functions take the app root, options and an optional `run`, and
 * return data and an exit code; printing is separate, so tests drive them
 * against real throwaway repos.
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import {
  agentBranch,
  currentBranch,
  getTarget,
  integrationOf,
  listRepos,
  setTarget,
  type RepoInfo,
} from '../integration/repos.js';
import {findAppRoot} from '../localize/app-root.js';
import {makeRun, type Run} from '../localize/run.js';
import {sharedInstall} from '../localize/shared-install.js';
import {
  branchesContaining,
  localBranchExists,
  refExists,
  safeToDeleteCreatedBranch,
  selectCheckouts,
  worktreesOf,
} from './branch.js';
import {linkNodeModules, overlaysOf, removeFarm, type LinkResult} from './worktree-node-modules.js';

export interface WorktreeAddOptions {
  /** `packages-local/` checkouts to give a worktree: package name, dir name or short name. */
  with?: string[];
  /** Check the app out detached at the base tip instead of on the agent branch. */
  appDetached?: boolean;
  port?: number;
  dataset?: string;
  /** Where the worktree goes; default `<parent of the app root>/wt/<agent>`. */
  dir?: string;
}

export interface WorktreeAddResult {
  code: number;
  /** What was done, or why nothing was; then the start instructions. */
  messages: string[];
  dir: string;
  base: string | null;
  agentBranch: string | null;
  /** The command that starts the app from the worktree; set on success. */
  startCommand?: string;
}

/** The default worktree directory for `agent`: `<parent of the app root>/wt/<agent>`. */
export function defaultWorktreeDir(appRoot: string, agent: string): string {
  return path.join(path.dirname(appRoot), 'wt', agent);
}

/**
 * `p` with every existing ancestor resolved through symlinks, so paths
 * compare equal however they were spelled (`/tmp` vs `/private/tmp`).
 */
function realish(p: string): string {
  const abs = path.resolve(p);
  let head = abs;
  const tail: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(head), ...tail);
    } catch {
      const parent = path.dirname(head);
      if (parent === head) return abs;
      tail.unshift(path.basename(head));
      head = parent;
    }
  }
}

function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** The branch agents of this app fork from: the integration branch, else the root's branch. */
async function baseOf(appRoot: string, run: Run): Promise<{base: string | null; target: string | null}> {
  const integration = await integrationOf(appRoot, run);
  if (integration) return {base: integration.branch, target: integration.target};
  const branch = currentBranch(run, appRoot);
  return {base: branch, target: branch};
}

const dirName = (repo: RepoInfo): string => path.basename(repo.dir);

/** `.env`, `.env.local` and `.env.<mode>.local`. */
const ENV_FILE = /^\.env(\.local|\.[^.]+\.local)?$/;
const PRIVATE_KEY = /\.(pem|key)$/;

function failed(r: {stdout: string; stderr: string}): string {
  return (r.stderr || r.stdout).trim();
}

/**
 * Create the agent's worktree. Every precondition (target dir, branches,
 * the state of each checkout that has to join the base branch) is checked
 * before anything is changed; if a later step fails, what this run created
 * is undone.
 */
export async function worktreeAdd(
  appRoot: string,
  agent: string,
  options: WorktreeAddOptions = {},
  run: Run = makeRun(appRoot),
): Promise<WorktreeAddResult> {
  const root = realish(appRoot);
  const dir = realish(options.dir ?? defaultWorktreeDir(root, agent));
  const result: WorktreeAddResult = {code: 1, messages: [], dir, base: null, agentBranch: null};
  const refuse = (...messages: string[]): WorktreeAddResult => {
    result.messages.push(...messages);
    return result;
  };

  if (options.appDetached && !(options.with ?? []).length) {
    return refuse(
      'A detached app worktree with no package worktree has nothing to land.',
      'To run another copy of the app, start the main checkout on another port, or pass --with.',
    );
  }
  if (fs.existsSync(dir)) return refuse(`${dir} already exists.`);
  // Inside the app root, the worktree's files would show up in the main
  // checkout (its git status, Vite's watcher, a workspace glob such as
  // packages-local/*). Nothing needs it there, so refuse it anywhere inside.
  if (isInside(root, dir)) {
    return refuse(
      `${dir} is inside the app root ${root}. Put worktrees outside it (the default is ${defaultWorktreeDir(root, agent)}).`,
    );
  }

  const {base, target} = await baseOf(root, run);
  if (!base || !target) {
    return refuse('The app root has a detached HEAD: check out the integration branch (or the branch to work from) first.');
  }
  result.base = base;
  let branch: string;
  try {
    branch = agentBranch(base, agent);
  } catch (error) {
    return refuse((error as Error).message);
  }
  result.agentBranch = branch;
  // agentBranch only rules out "/" and "--"; git has more rules (spaces, "..", "~", ...).
  if (run('git', ['check-ref-format', '--branch', branch], {cwd: root}).status !== 0) {
    return refuse(`invalid agent name "${agent}": ${branch} is not a valid branch name.`);
  }

  const repos = await listRepos(root, run);
  const chosen = selectCheckouts(repos.slice(1), options.with ?? []);
  if ('error' in chosen) return refuse(chosen.error);
  const packages = chosen.repos;

  const problems: string[] = [];
  if (!options.appDetached && localBranchExists(run, root, branch)) {
    problems.push(`.: branch ${branch} already exists.`);
  }
  const joins: {repo: RepoInfo; exists: boolean}[] = [];
  for (const repo of packages) {
    if (localBranchExists(run, repo.dir, branch)) {
      problems.push(`${repo.rel}: branch ${branch} already exists.`);
    }
    if (repo.branch === base) continue;
    const exists = localBranchExists(run, repo.dir, base);
    if (repo.dirty) {
      problems.push(`${repo.rel}: not on ${base} and has uncommitted or untracked changes; commit or stash them.`);
    } else if (!exists && !refExists(run, repo.dir, target)) {
      problems.push(`${repo.rel}: not on ${base}, and "${target}" does not exist there to create it from.`);
    }
    joins.push({repo, exists});
  }
  if (problems.length) return refuse(...problems, 'Nothing was changed.');

  // Each step that changes something pushes how to undo it.
  const undo: (() => void)[] = [];
  // Set once this run's `git worktree add` has made the dir: a dir that
  // appeared some other way is never removed.
  let createdDir = false;
  const step = (args: string[], cwd: string): boolean => {
    const r = run('git', args, {cwd});
    if (r.status !== 0) {
      result.messages.push(`${path.relative(root, cwd) || '.'}: git ${args.join(' ')} failed: ${failed(r)}`);
      return false;
    }
    return true;
  };
  const rollback = (): WorktreeAddResult => {
    for (const fn of undo.reverse()) {
      try {
        fn();
      } catch (error) {
        result.messages.push(`undo failed: ${(error as Error).message}`);
      }
    }
    if (createdDir && fs.existsSync(dir)) fs.rmSync(dir, {recursive: true, force: true});
    run('git', ['worktree', 'prune'], {cwd: root});
    result.messages.push('Undid what this run had created.');
    return result;
  };

  try {
    // A checkout that is not on the base yet joins the work now.
    for (const {repo, exists} of joins) {
      const args = exists ? ['switch', base] : ['switch', '-c', base, target];
      if (!step(args, repo.dir)) return rollback();
      // Where this run made the base, and the branches that already contained
      // that commit (the target, typically), so a later fork can be told apart.
      const created = exists ? null : run('git', ['rev-parse', `refs/heads/${base}`], {cwd: repo.dir}).stdout.trim();
      const before = created
        ? branchesContaining(run, repo.dir, created).filter((r) => r !== `refs/heads/${base}`)
        : [];
      const key = `branch.${base}.linked-target`;
      const config: {set: boolean; previous: string | null} = {set: false, previous: null};
      undo.push(() => {
        const back = repo.branch ? ['switch', repo.branch] : ['switch', '--detach', repo.head];
        run('git', back, {cwd: repo.dir});
        // A base branch this run created goes again only while it is still
        // what the run made: another agent may have moved or forked from it.
        let keep = false;
        if (created) {
          const check = safeToDeleteCreatedBranch(repo.dir, base, created, run, before);
          if (check.ok) {
            run('git', ['branch', '-D', base], {cwd: repo.dir});
          } else if ('sha' in check && check.sha) {
            keep = true;
            result.messages.push(`${repo.rel}: kept ${base} at ${check.sha}: ${check.reason}.`);
          }
        }
        if (config.set && !keep) {
          run('git', config.previous ? ['config', key, config.previous] : ['config', '--unset', key], {cwd: repo.dir});
        }
      });
      // Without an integration branch the base is its own target: nothing to record.
      if (target !== base) {
        config.previous = await getTarget(repo.dir, base, run);
        config.set = true;
        await setTarget(repo.dir, base, target, run);
      }
      result.messages.push(`${repo.rel}: ${exists ? 'switched to' : 'created'} ${base}${target !== base ? ` (target ${target})` : ''}`);
    }

    const appArgs = options.appDetached
      ? ['worktree', 'add', '--detach', dir, base]
      : ['worktree', 'add', '-b', branch, dir, base];
    if (!step(appArgs, root)) return rollback();
    createdDir = true;
    undo.push(() => {
      run('git', ['worktree', 'remove', '--force', dir], {cwd: root});
      if (!options.appDetached) run('git', ['branch', '-D', branch], {cwd: root});
    });
    result.messages.push(
      options.appDetached
        ? `${dir}: app worktree, detached at ${base}`
        : `${dir}: app worktree on ${branch}`,
    );

    try {
      for (const name of fs.readdirSync(root).filter((n) => ENV_FILE.test(n)).sort()) {
        // Only an untracked, gitignored file: a tracked one is in the worktree already.
        if (run('git', ['check-ignore', '-q', name], {cwd: root}).status !== 0) continue;
        // The file itself, not the root's entry: a link to a link breaks when the middle one moves.
        const source = fs.realpathSync(path.join(root, name));
        fs.symlinkSync(source, path.join(dir, name));
        result.messages.push(`${path.join(dir, name)} -> ${source}`);
      }
    } catch (error) {
      result.messages.push(`linking into ${dir} failed: ${(error as Error).message}`);
      return rollback();
    }

    for (const repo of packages) {
      const pkgDir = path.join(dir, 'packages-local', dirName(repo));
      if (!step(['worktree', 'add', '-b', branch, pkgDir, base], repo.dir)) return rollback();
      undo.push(() => {
        run('git', ['worktree', 'remove', '--force', pkgDir], {cwd: repo.dir});
        run('git', ['branch', '-D', branch], {cwd: repo.dir});
      });
      // npm nests version-conflicting dependencies in the checkout's own
      // node_modules; without them the worktree's imports fall through to the
      // root's versions.
      const nested = path.join(repo.dir, 'node_modules');
      if (fs.existsSync(nested)) {
        try {
          linkDir(nested, path.join(pkgDir, 'node_modules'));
        } catch (error) {
          result.messages.push(`linking ${pkgDir}/node_modules failed: ${(error as Error).message}`);
          return rollback();
        }
        result.messages.push(`${path.join(pkgDir, 'node_modules')} -> ${nested}`);
      }
      result.messages.push(`${pkgDir}: ${repo.packageName ?? repo.rel} on ${branch}`);
    }

    try {
      result.messages.push(farmMessage(root, dir, linkNodeModules(root, dir, overlaysOf(dir))));
    } catch (error) {
      result.messages.push(`linking ${path.join(dir, 'node_modules')} failed: ${(error as Error).message}`);
      return rollback();
    }
  } catch (error) {
    result.messages.push(`failed: ${(error as Error).message}`);
    return rollback();
  }

  const keys = fs
    .readdirSync(root)
    .filter((n) => PRIVATE_KEY.test(n))
    .filter((n) => run('git', ['ls-files', '--error-unmatch', n], {cwd: root}).status !== 0)
    .sort();
  if (keys.length) {
    result.messages.push(
      `Not linked (private keys never are): ${keys.join(', ')}. If the app needs one here: ln -s ${shellQuote(path.join(root, keys[0]))} ${shellQuote(dir + path.sep)}`,
    );
  }

  const pkgJson = readJson(path.join(root, 'package.json'));
  const scripts = (pkgJson?.scripts ?? {}) as Record<string, unknown>;
  const start = 'start:local' in scripts ? 'npm run start:local' : 'npm start';
  const env = [`PORT=${options.port ?? '<port>'}`];
  if (options.dataset) env.push(`FUSEKI_DATASET=${shellQuote(options.dataset)}`);
  result.startCommand = `cd ${shellQuote(dir)} && ${env.join(' ')} ${start}`;
  result.messages.push('', `Start it: ${result.startCommand}`);
  if (options.port === undefined) result.messages.push('(pick a free port: the main checkout uses 4040)');
  const backup = path.join(root, 'scripts', 'backup-cn-state.sh');
  const restore = path.join(root, 'scripts', 'restore-fuseki-dataset.sh');
  if (options.dataset && fs.existsSync(backup) && fs.existsSync(restore)) {
    result.messages.push(
      `Clone the data into ${options.dataset} first (from ${root}):`,
      `  scripts/backup-cn-state.sh --yes`,
      `  scripts/restore-fuseki-dataset.sh <the cn-main dump it wrote> ${shellQuote(options.dataset)} --yes`,
    );
  }
  result.messages.push(
    "Don't run npm install in the worktree: node_modules links into the main checkout's install (the git hooks skip it there too).",
    'After an npm install in the main checkout, or a package worktree added by hand: linked worktree relink, from the worktree.',
    'Landing (rebase onto the base, then merge --ff-only from the main checkout) is described in the wrapup skill.',
  );
  result.code = 0;
  return result;
}

/** One line on the farm `linkNodeModules` made. */
function farmMessage(root: string, dir: string, r: LinkResult): string {
  const overlays = Object.entries(r.overlays).map(([name, d]) => `${name} -> ${path.relative(dir, d)}`);
  return (
    `${path.join(dir, 'node_modules')}: links into ${path.join(root, 'node_modules')} (${r.links} entries)` +
    (overlays.length ? `, with ${overlays.join(', ')}` : '') +
    (r.replaced === 'symlink' ? '; replaced the node_modules symlink' : '')
  );
}

/** A directory symlink; a junction on Windows, which needs no extra privilege. */
function linkDir(target: string, link: string): void {
  fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : undefined);
}

/** `s` as one POSIX shell word: unchanged when it is plain, else single-quoted. */
export function shellQuote(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Whether `branch` is contained in `base` in `repoDir`; null when detached. */
function landed(run: Run, repoDir: string, branch: string | null, base: string | null): boolean | null {
  if (!branch) return null;
  if (!base || !localBranchExists(run, repoDir, base)) return false;
  return run('git', ['merge-base', '--is-ancestor', branch, base], {cwd: repoDir}).status === 0;
}

export interface PackageWorktree {
  /** `packages-local/<dir>` of the checkout it belongs to. */
  rel: string;
  packageName?: string;
  /** The checkout the worktree belongs to. */
  checkout: string;
  dir: string;
  branch: string | null;
  landed: boolean | null;
}

export interface AppWorktree {
  /** The agent name: from a `<base>--<agent>` branch (the app's or a package's), else the directory name. */
  agent: string;
  dir: string;
  branch: string | null;
  head: string;
  /** Whether the branch is in the base; null when detached. */
  landed: boolean | null;
  /**
   * The shape `worktree add` makes: on a `<base>--<agent>` branch, or
   * detached with a package worktree on one.
   */
  agentWorktree: boolean;
  packages: PackageWorktree[];
}

export interface WorktreeList {
  base: string | null;
  worktrees: AppWorktree[];
}

export interface WorktreeListOptions {
  /** Every worktree of the app, not only agent worktrees. */
  all?: boolean;
}

/**
 * The agent worktrees of the app root, with the package worktrees nested in
 * their `packages-local/`. With `all`, every other worktree of the app too
 * (marked `agentWorktree: false`). The main checkout is never listed.
 */
export async function worktreeList(
  appRoot: string,
  options: WorktreeListOptions = {},
  run: Run = makeRun(appRoot),
): Promise<WorktreeList> {
  const root = realish(appRoot);
  const {base} = await baseOf(root, run);
  const prefix = base ? `${base}--` : null;
  const agentOf = (branch: string | null): string | null =>
    prefix && branch?.startsWith(prefix) ? branch.slice(prefix.length) : null;
  const repos = (await listRepos(root, run)).slice(1);
  const nested = repos.flatMap((repo) =>
    worktreesOf(run, repo.dir)
      .filter((wt) => realish(wt.path) !== realish(repo.dir))
      .map((wt) => ({repo, wt, dir: realish(wt.path)})),
  );
  const worktrees: AppWorktree[] = [];
  // git lists the main worktree first.
  for (const [i, wt] of worktreesOf(run, root).entries()) {
    const dir = realish(wt.path);
    if (i === 0 || dir === root) continue;
    const packages: PackageWorktree[] = nested
      .filter((n) => path.dirname(n.dir) === path.join(dir, 'packages-local'))
      .map((n) => ({
        rel: n.repo.rel,
        packageName: n.repo.packageName,
        checkout: n.repo.dir,
        dir: n.dir,
        branch: n.wt.branch,
        landed: landed(run, n.repo.dir, n.wt.branch, base),
      }));
    const ownAgent = agentOf(wt.branch);
    const packageAgent = wt.branch === null ? packages.map((p) => agentOf(p.branch)).find((a) => a !== null) ?? null : null;
    const agent = ownAgent ?? packageAgent;
    if (agent === null && !options.all) continue;
    worktrees.push({
      agent: agent ?? path.basename(dir),
      dir,
      branch: wt.branch,
      head: wt.head,
      landed: landed(run, root, wt.branch, base),
      agentWorktree: agent !== null,
      packages,
    });
  }
  return {base, worktrees};
}

const landedLabel = (l: boolean | null): string => (l === null ? 'n/a' : l ? 'landed' : 'not landed');

export function formatWorktreeList(list: WorktreeList, options: WorktreeListOptions = {}): string {
  const lines = [list.base ? `Base: ${list.base}` : 'Base: none (the app root is detached)'];
  if (!list.worktrees.length) {
    lines.push(options.all ? 'No worktrees besides the main checkout.' : 'No agent worktrees (--all lists every worktree).');
  }
  for (const wt of list.worktrees) {
    lines.push(
      '',
      `${wt.agent}${wt.agentWorktree ? '' : ' (not an agent worktree)'}  ${wt.dir}`,
      `  app  ${wt.branch ?? 'detached'}  ${landedLabel(wt.landed)}`,
    );
    for (const p of wt.packages) {
      lines.push(`  ${p.packageName ?? p.rel}  ${p.branch ?? 'detached'}  ${landedLabel(p.landed)}`);
    }
  }
  return lines.join('\n');
}

export interface WorktreeRemoveOptions {
  /** Remove worktrees that have changes of their own or unlanded branches; unlanded branches are kept. */
  force?: boolean;
  /** Also delete agent branches that have not landed (`git branch -D`). */
  deleteUnlanded?: boolean;
  /** The app worktree's directory, instead of finding it by its agent branch. */
  dir?: string;
}

export interface WorktreeRemoveResult {
  code: number;
  messages: string[];
}

/**
 * The agent's app worktree in `list`: the one at `dir` when given, else the
 * one on `<base>--<agent>`, a detached one with a package worktree on that
 * branch, or the one at the default dir.
 */
function findAppWorktree(
  root: string,
  list: WorktreeList,
  agent: string,
  dirOption?: string,
): {app: AppWorktree; branch: string | null} | {error: string[]} {
  let branch: string | null = null;
  try {
    branch = list.base ? agentBranch(list.base, agent) : null;
  } catch (error) {
    return {error: [(error as Error).message]};
  }
  if (dirOption) {
    const dir = realish(dirOption);
    const app = list.worktrees.find((w) => w.dir === dir);
    return app ? {app, branch} : {error: [`No worktree of ${root} at ${dir}.`]};
  }
  const defaultDir = realish(defaultWorktreeDir(root, agent));
  const app =
    (branch ? list.worktrees.find((w) => w.branch === branch) : undefined) ??
    (branch ? list.worktrees.find((w) => w.branch === null && w.packages.some((p) => p.branch === branch)) : undefined) ??
    list.worktrees.find((w) => w.dir === defaultDir);
  if (!app) {
    return {
      error: [
        `No worktree of ${root} for ${agent}: none on ${branch ?? `<base>--${agent}`}, nor at ${defaultDir}.`,
        'Pass its directory with --dir; `linked worktree list` shows the worktrees.',
      ],
    };
  }
  return {app, branch};
}

/**
 * Remove an agent's worktree: the nested package worktrees first, then the
 * app worktree, then the agent branches. The app worktree is the one on
 * `<base>--<agent>`; a detached one is found by its package worktrees on that
 * branch, or at the default dir; `dir` names it outright.
 *
 * Refuses, removing nothing, while an agent branch has not landed in the base
 * or a worktree has changes of its own (the symlinks and cache `worktree add`
 * and the dev server made don't count). `force` removes the worktrees anyway
 * but keeps unlanded branches, printing their sha; `deleteUnlanded` deletes
 * those too.
 */
export async function worktreeRemove(
  appRoot: string,
  agent: string,
  options: WorktreeRemoveOptions = {},
  run: Run = makeRun(appRoot),
): Promise<WorktreeRemoveResult> {
  const root = realish(appRoot);
  const force = !!options.force;
  const deleteUnlanded = !!options.deleteUnlanded;
  const messages: string[] = [];
  const refuse = (...m: string[]): WorktreeRemoveResult => ({code: 1, messages: [...messages, ...m]});

  const list = await worktreeList(root, {all: true}, run);
  const found = findAppWorktree(root, list, agent, options.dir);
  if ('error' in found) return refuse(...found.error);
  const {app, branch} = found;

  const items: {label: string; repoDir: string; dir: string; branch: string | null; landed: boolean | null; ours: string[]}[] = [
    ...app.packages.map((p) => ({
      label: p.packageName ?? p.rel,
      repoDir: p.checkout,
      dir: p.dir,
      branch: p.branch,
      landed: p.landed,
      ours: ['node_modules'],
    })),
    {
      label: 'app',
      repoDir: root,
      dir: app.dir,
      branch: app.branch,
      landed: app.landed,
      ours: ['node_modules', '.vite-cache', 'packages-local', ...envLinks(app.dir)],
    },
  ];

  const problems: string[] = [];
  for (const it of items) {
    if (it.landed === false && !force && !deleteUnlanded) {
      problems.push(`${it.label}: ${it.branch} has not landed in ${list.base}.`);
    }
    if (force) continue;
    const status = run('git', ['status', '--porcelain'], {cwd: it.dir});
    const own = status.stdout
      .split('\n')
      .filter(Boolean)
      .filter((line) => !it.ours.includes(line.slice(3).replace(/\/$/, '')));
    if (status.status !== 0) problems.push(`${it.label}: git status failed in ${it.dir}: ${failed(status)}`);
    else if (own.length) problems.push(`${it.label}: ${it.dir} has changes: ${own.map((l) => l.trim()).join(', ')}`);
  }
  if (problems.length) {
    return refuse(
      ...problems,
      'Nothing was removed. --force removes it anyway and keeps unlanded branches; --delete-unlanded deletes them too.',
    );
  }

  for (const it of items) {
    // The links unlinked below, so a failed `git worktree remove` can put them
    // back and leave the worktree usable.
    const unlinked: {path: string; target: string; type: 'dir' | 'file'}[] = [];
    // The app's node_modules link farm, rebuilt the same way if the removal fails.
    const farm = sharedInstall(it.dir);
    const removedFarm = farm?.layout === 'farm' && removeFarm(it.dir) ? farm.installRoot : null;
    for (const name of it.ours) {
      const p = path.join(it.dir, name);
      let stat: fs.Stats | undefined;
      try {
        stat = fs.lstatSync(p);
      } catch {
        continue;
      }
      if (stat.isSymbolicLink()) {
        const target = fs.readlinkSync(p);
        let type: 'dir' | 'file' = 'file';
        try {
          if (fs.statSync(p).isDirectory()) type = 'dir';
        } catch {
          /* dangling: a file link */
        }
        fs.unlinkSync(p);
        unlinked.push({path: p, target, type});
      } else if (name === '.vite-cache') fs.rmSync(p, {recursive: true, force: true});
      else if (name === 'packages-local') {
        try {
          fs.rmdirSync(p); // only once the package worktrees are gone, so empty
        } catch {
          /* not empty: git reports it */
        }
      }
    }
    const args = ['worktree', 'remove', ...(force ? ['--force'] : []), it.dir];
    const r = run('git', args, {cwd: it.repoDir});
    if (r.status !== 0) {
      for (const link of unlinked) {
        try {
          fs.symlinkSync(link.target, link.path, link.type);
        } catch {
          /* already back, or the dir is gone: the error below is what matters */
        }
      }
      if (removedFarm) {
        try {
          linkNodeModules(removedFarm, it.dir, overlaysOf(it.dir));
        } catch {
          /* the error below is what matters; linked worktree relink rebuilds it */
        }
      }
      return refuse(`${it.label}: git ${args.join(' ')} failed: ${failed(r)}`);
    }
    messages.push(`removed ${it.dir}`);
  }

  for (const it of items) {
    if (!branch || it.branch !== branch) {
      if (it.branch) messages.push(`${it.label}: kept ${it.branch} (not ${branch ?? 'an agent branch'}).`);
      continue;
    }
    const sha = run('git', ['rev-parse', '--short', `refs/heads/${branch}`], {cwd: it.repoDir}).stdout.trim();
    if (!it.landed && !deleteUnlanded) {
      messages.push(`${it.label}: kept ${branch} at ${sha} (not landed)`);
      continue;
    }
    const r = run('git', ['branch', it.landed ? '-d' : '-D', branch], {cwd: it.repoDir});
    messages.push(
      r.status !== 0
        ? `${it.label}: could not delete ${branch}: ${failed(r)}`
        : it.landed
          ? `${it.label}: deleted ${branch}`
          : `${it.label}: deleted ${branch} (was ${sha}, not landed)`,
    );
  }
  return {code: 0, messages};
}

/** The `.env*` entries of `dir` that are symlinks, i.e. the ones `add` made. */
function envLinks(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((n) => ENV_FILE.test(n))
      .filter((n) => fs.lstatSync(path.join(dir, n)).isSymbolicLink());
  } catch {
    return [];
  }
}

export interface WorktreeRelinkOptions {
  /** The app worktree's directory, instead of the agent name or the current directory. */
  dir?: string;
}

/**
 * Rebuild an app worktree's `node_modules` link farm: after an `npm install`
 * in the main checkout, after a package worktree was added to its
 * `packages-local/` by hand, and to move a worktree made with a symlinked
 * `node_modules` (the earlier layout) to the farm. A package worktree without
 * a `node_modules` gets the link to its checkout's, as `add` makes it.
 *
 * The worktree is `dir`, else the agent's, else `appRoot` itself when it is a
 * worktree rather than the main checkout. A real install of the worktree's own
 * is left alone.
 */
export async function worktreeRelink(
  appRoot: string,
  agent: string | undefined,
  options: WorktreeRelinkOptions = {},
  run: Run = makeRun(appRoot),
): Promise<WorktreeRemoveResult> {
  const here = realish(appRoot);
  const all = worktreesOf(run, here);
  if (!all.length) return {code: 1, messages: [`${here} is not in a git repository.`]};
  // git lists the main worktree first.
  const root = realish(all[0].path);
  const list = await worktreeList(root, {all: true}, run);
  let dir: string;
  if (options.dir) {
    dir = realish(options.dir);
  } else if (agent) {
    const found = findAppWorktree(root, list, agent);
    if ('error' in found) return {code: 1, messages: found.error};
    dir = found.app.dir;
  } else if (here !== root) {
    dir = here;
  } else {
    return {code: 1, messages: ['Run it in the worktree, or name the agent (or --dir).']};
  }
  if (dir === root) return {code: 1, messages: [`${dir} is the main checkout: it has its own install.`]};
  if (!list.worktrees.some((w) => w.dir === dir)) return {code: 1, messages: [`No worktree of ${root} at ${dir}.`]};

  const messages: string[] = [];
  try {
    for (const name of Object.values(overlaysOf(dir)).map((d) => path.basename(d))) {
      const own = path.join(dir, 'packages-local', name, 'node_modules');
      const nested = path.join(root, 'packages-local', name, 'node_modules');
      if (fs.existsSync(own) || isLink(own) || !fs.existsSync(nested)) continue;
      linkDir(nested, own);
      messages.push(`${own} -> ${nested}`);
    }
    messages.push(farmMessage(root, dir, linkNodeModules(root, dir, overlaysOf(dir))));
  } catch (error) {
    return {code: 1, messages: [...messages, `relinking ${dir} failed: ${(error as Error).message}`]};
  }
  return {code: 0, messages};
}

function isLink(p: string): boolean {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/** The commander action for `worktree relink`. */
export async function runWorktreeRelink(agent: string | undefined, options: {dir?: string}): Promise<void> {
  const result = await worktreeRelink(process.cwd(), agent, {dir: resolveDir(options.dir)});
  const write = result.code === 0 ? console.log : console.error;
  for (const m of result.messages) write(m);
  process.exitCode = result.code;
}

const resolveDir = (dir?: string): string | undefined => (dir ? path.resolve(process.cwd(), dir) : undefined);

/** The commander action for `worktree add`. */
export async function runWorktreeAdd(
  agent: string,
  options: {with?: string; appDetached?: boolean; port?: string; dataset?: string; dir?: string},
): Promise<void> {
  const port = options.port === undefined ? undefined : Number.parseInt(options.port, 10);
  if (port !== undefined && !Number.isInteger(port)) {
    console.error(`--port must be a number, got "${options.port}".`);
    process.exitCode = 1;
    return;
  }
  const result = await worktreeAdd(findAppRoot(process.cwd()), agent, {
    with: options.with ? options.with.split(',').map((s) => s.trim()).filter(Boolean) : [],
    appDetached: options.appDetached,
    port,
    dataset: options.dataset,
    dir: resolveDir(options.dir),
  });
  const write = result.code === 0 ? console.log : console.error;
  for (const m of result.messages) write(m);
  process.exitCode = result.code;
}

/** The commander action for `worktree list`. */
export async function runWorktreeList(options: {json?: boolean; all?: boolean}): Promise<void> {
  const list = await worktreeList(findAppRoot(process.cwd()), {all: options.all});
  process.stdout.write((options.json ? JSON.stringify(list, null, 2) : formatWorktreeList(list, {all: options.all})) + '\n');
}

/** The commander action for `worktree remove`. */
export async function runWorktreeRemove(
  agent: string,
  options: {force?: boolean; deleteUnlanded?: boolean; dir?: string},
): Promise<void> {
  const result = await worktreeRemove(findAppRoot(process.cwd()), agent, {
    force: options.force,
    deleteUnlanded: options.deleteUnlanded,
    dir: resolveDir(options.dir),
  });
  const write = result.code === 0 ? console.log : console.error;
  for (const m of result.messages) write(m);
  process.exitCode = result.code;
}
