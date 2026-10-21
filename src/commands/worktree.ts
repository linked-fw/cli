/**
 * `linked worktree add | list | remove` — an agent's worktree of an app, with
 * a nested worktree of each framework package it changes.
 *
 * Layout: `<dir>` (default `<parent of the app root>/wt/<agent>`) is a git
 * worktree of the app, on the agent branch `<base>--<agent>` (or detached at
 * the base tip with `--app-detached`). Its `node_modules` is a symlink to the
 * app root's, so it shares the main checkout's install, and every package
 * the agent changes is a worktree of that package's `packages-local/`
 * checkout at `<dir>/packages-local/<dirName>`, on the same agent branch.
 * The dev server's workspace table then points those names, and only those,
 * at the worktree's copies.
 *
 * The base is the root's integration branch, or the root's current branch
 * when it has none. Agents land by fast-forwarding the base to their branch;
 * `remove` refuses until every agent branch has landed.
 *
 * The core functions take the app root, options and an optional `run`, and
 * return data and an exit code; printing is separate, so tests drive them
 * against real throwaway repos.
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import {integrationOf, agentBranch, getTarget, listRepos, setTarget, type RepoInfo} from '../integration/repos.js';
import {findAppRoot} from '../localize/app-root.js';
import {makeRun, type Run} from '../localize/run.js';
import {localBranchExists, refExists, selectCheckouts} from './branch.js';

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

function currentBranch(run: Run, dir: string): string | null {
  const r = run('git', ['symbolic-ref', '--short', '-q', 'HEAD'], {cwd: dir});
  const branch = r.stdout.trim();
  return r.status === 0 && branch ? branch : null;
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
    if (fs.existsSync(dir)) fs.rmSync(dir, {recursive: true, force: true});
    run('git', ['worktree', 'prune'], {cwd: root});
    result.messages.push('Undid what this run had created.');
    return result;
  };

  // A checkout that is not on the base yet joins the work now.
  for (const {repo, exists} of joins) {
    const args = exists ? ['switch', base] : ['switch', '-c', base, target];
    if (!step(args, repo.dir)) return rollback();
    const back = repo.branch ? ['switch', repo.branch] : ['switch', '--detach', repo.head];
    undo.push(() => {
      run('git', back, {cwd: repo.dir});
      if (!exists) run('git', ['branch', '-D', base], {cwd: repo.dir});
    });
    // Without an integration branch the base is its own target: nothing to record.
    if (target !== base) {
      const previous = await getTarget(repo.dir, base, run);
      await setTarget(repo.dir, base, target, run);
      undo.push(() => {
        const key = `branch.${base}.linked-target`;
        run('git', previous ? ['config', key, previous] : ['config', '--unset', key], {cwd: repo.dir});
      });
    }
    result.messages.push(`${repo.rel}: ${exists ? 'switched to' : 'created'} ${base}${target !== base ? ` (target ${target})` : ''}`);
  }

  const appArgs = options.appDetached
    ? ['worktree', 'add', '--detach', dir, base]
    : ['worktree', 'add', '-b', branch, dir, base];
  if (!step(appArgs, root)) return rollback();
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
    fs.symlinkSync(path.join(root, 'node_modules'), path.join(dir, 'node_modules'));
    for (const name of fs.readdirSync(root).filter((n) => ENV_FILE.test(n)).sort()) {
      // Only an untracked, gitignored file: a tracked one is in the worktree already.
      if (run('git', ['check-ignore', '-q', name], {cwd: root}).status !== 0) continue;
      fs.symlinkSync(path.join(root, name), path.join(dir, name));
      result.messages.push(`${dir}/${name} -> ${path.join(root, name)}`);
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
        fs.symlinkSync(nested, path.join(pkgDir, 'node_modules'));
      } catch (error) {
        result.messages.push(`linking ${pkgDir}/node_modules failed: ${(error as Error).message}`);
        return rollback();
      }
    }
    result.messages.push(`${pkgDir}: ${repo.packageName ?? repo.rel} on ${branch}`);
  }

  const keys = fs
    .readdirSync(root)
    .filter((n) => PRIVATE_KEY.test(n))
    .filter((n) => run('git', ['ls-files', '--error-unmatch', n], {cwd: root}).status !== 0)
    .sort();
  if (keys.length) {
    result.messages.push(
      `Not linked (private keys never are): ${keys.join(', ')}. If the app needs one here: ln -s ${path.join(root, keys[0])} ${dir}/`,
    );
  }

  const pkgJson = readJson(path.join(root, 'package.json'));
  const scripts = (pkgJson?.scripts ?? {}) as Record<string, unknown>;
  const start = 'start:local' in scripts ? 'npm run start:local' : 'npm start';
  const env = [`PORT=${options.port ?? '<port>'}`];
  if (options.dataset) env.push(`FUSEKI_DATASET=${options.dataset}`);
  result.startCommand = `cd ${dir} && ${env.join(' ')} ${start}`;
  result.messages.push('', `Start it: ${result.startCommand}`);
  if (options.port === undefined) result.messages.push('(pick a free port: the main checkout uses 4040)');
  const backup = path.join(root, 'scripts', 'backup-cn-state.sh');
  const restore = path.join(root, 'scripts', 'restore-fuseki-dataset.sh');
  if (options.dataset && fs.existsSync(backup) && fs.existsSync(restore)) {
    result.messages.push(
      `Clone the data into ${options.dataset} first (from ${root}):`,
      `  scripts/backup-cn-state.sh --yes`,
      `  scripts/restore-fuseki-dataset.sh <the cn-main dump it wrote> ${options.dataset} --yes`,
    );
  }
  result.messages.push(
    "Don't run npm install in the worktree: node_modules is the main checkout's (the git hooks skip it there too).",
    'Landing (rebase onto the base, then merge --ff-only from the main checkout) is described in the wrapup skill.',
  );
  result.code = 0;
  return result;
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

interface GitWorktree {
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

function worktreesOf(run: Run, repoDir: string): GitWorktree[] {
  const r = run('git', ['worktree', 'list', '--porcelain'], {cwd: repoDir});
  return r.status === 0 ? parseWorktreeList(r.stdout) : [];
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
  /** The agent name: from a `<base>--<agent>` branch, else the directory name. */
  agent: string;
  dir: string;
  branch: string | null;
  head: string;
  /** Whether the branch is in the base; null when detached. */
  landed: boolean | null;
  /** On a `<base>--<agent>` branch, or detached: the shape `worktree add` makes. */
  agentWorktree: boolean;
  packages: PackageWorktree[];
}

export interface WorktreeList {
  base: string | null;
  worktrees: AppWorktree[];
}

/**
 * Every worktree of the app root other than the root itself, with the
 * package worktrees nested in its `packages-local/`. Worktrees made some
 * other way are listed too, marked `agentWorktree: false` unless they have
 * the agent shape.
 */
export async function worktreeList(
  appRoot: string,
  run: Run = makeRun(appRoot),
): Promise<WorktreeList> {
  const root = realish(appRoot);
  const {base} = await baseOf(root, run);
  const repos = (await listRepos(root, run)).slice(1);
  const nested = repos.flatMap((repo) =>
    worktreesOf(run, repo.dir)
      .filter((wt) => realish(wt.path) !== realish(repo.dir))
      .map((wt) => ({repo, wt, dir: realish(wt.path)})),
  );
  const worktrees: AppWorktree[] = [];
  for (const wt of worktreesOf(run, root)) {
    const dir = realish(wt.path);
    if (dir === root) continue;
    const prefix = base ? `${base}--` : null;
    const agentShaped = !!prefix && !!wt.branch?.startsWith(prefix);
    worktrees.push({
      agent: agentShaped && prefix && wt.branch ? wt.branch.slice(prefix.length) : path.basename(dir),
      dir,
      branch: wt.branch,
      head: wt.head,
      landed: landed(run, root, wt.branch, base),
      agentWorktree: agentShaped || wt.branch === null,
      packages: nested
        .filter((n) => path.dirname(n.dir) === path.join(dir, 'packages-local'))
        .map((n) => ({
          rel: n.repo.rel,
          packageName: n.repo.packageName,
          checkout: n.repo.dir,
          dir: n.dir,
          branch: n.wt.branch,
          landed: landed(run, n.repo.dir, n.wt.branch, base),
        })),
    });
  }
  return {base, worktrees};
}

const landedLabel = (l: boolean | null): string => (l === null ? 'n/a' : l ? 'landed' : 'not landed');

export function formatWorktreeList(list: WorktreeList): string {
  const lines = [list.base ? `Base: ${list.base}` : 'Base: none (the app root is detached)'];
  if (!list.worktrees.length) lines.push('No worktrees besides the app root.');
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
  /** Remove even with unlanded branches or changes, and delete unlanded agent branches. */
  force?: boolean;
  dir?: string;
}

export interface WorktreeRemoveResult {
  code: number;
  messages: string[];
}

/**
 * Remove an agent's worktree: the nested package worktrees first, then the
 * app worktree, then the agent branches. Refuses, removing nothing, while an
 * agent branch has not landed in the base or a worktree has changes of its
 * own (the symlinks and cache `worktree add` and the dev server made don't
 * count), unless `force`.
 */
export async function worktreeRemove(
  appRoot: string,
  agent: string,
  options: WorktreeRemoveOptions = {},
  run: Run = makeRun(appRoot),
): Promise<WorktreeRemoveResult> {
  const root = realish(appRoot);
  const dir = realish(options.dir ?? defaultWorktreeDir(root, agent));
  const force = !!options.force;
  const messages: string[] = [];
  const refuse = (...m: string[]): WorktreeRemoveResult => ({code: 1, messages: [...messages, ...m]});

  const list = await worktreeList(root, run);
  const app = list.worktrees.find((w) => w.dir === dir);
  if (!app) return refuse(`No worktree of ${root} at ${dir}.`);
  let branch: string | null = null;
  try {
    branch = list.base ? agentBranch(list.base, agent) : null;
  } catch (error) {
    return refuse((error as Error).message);
  }

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

  if (!force) {
    const problems: string[] = [];
    for (const it of items) {
      if (it.landed === false) problems.push(`${it.label}: ${it.branch} has not landed in ${list.base}.`);
      const status = run('git', ['status', '--porcelain'], {cwd: it.dir});
      const own = status.stdout
        .split('\n')
        .filter(Boolean)
        .filter((line) => !it.ours.includes(line.slice(3).replace(/\/$/, '')));
      if (status.status !== 0) problems.push(`${it.label}: git status failed in ${it.dir}: ${failed(status)}`);
      else if (own.length) problems.push(`${it.label}: ${it.dir} has changes: ${own.map((l) => l.trim()).join(', ')}`);
    }
    if (problems.length) return refuse(...problems, 'Nothing was removed (--force removes it anyway).');
  }

  for (const it of items) {
    for (const name of it.ours) {
      const p = path.join(it.dir, name);
      let stat: fs.Stats | undefined;
      try {
        stat = fs.lstatSync(p);
      } catch {
        continue;
      }
      if (stat.isSymbolicLink()) fs.unlinkSync(p);
      else if (name === '.vite-cache') fs.rmSync(p, {recursive: true, force: true});
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
    if (r.status !== 0) return refuse(`${it.label}: git ${args.join(' ')} failed: ${failed(r)}`);
    messages.push(`removed ${it.dir}`);
  }

  for (const it of items) {
    if (!branch || it.branch !== branch) {
      if (it.branch) messages.push(`${it.label}: kept ${it.branch} (not ${branch ?? 'an agent branch'}).`);
      continue;
    }
    if (!it.landed && !force) continue;
    const r = run('git', ['branch', it.landed ? '-d' : '-D', branch], {cwd: it.repoDir});
    messages.push(
      r.status === 0
        ? `${it.label}: deleted ${branch}${it.landed ? '' : ' (not landed)'}`
        : `${it.label}: could not delete ${branch}: ${failed(r)}`,
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
export async function runWorktreeList(options: {json?: boolean}): Promise<void> {
  const list = await worktreeList(findAppRoot(process.cwd()));
  process.stdout.write((options.json ? JSON.stringify(list, null, 2) : formatWorktreeList(list)) + '\n');
}

/** The commander action for `worktree remove`. */
export async function runWorktreeRemove(
  agent: string,
  options: {force?: boolean; dir?: string},
): Promise<void> {
  const result = await worktreeRemove(findAppRoot(process.cwd()), agent, {
    force: options.force,
    dir: resolveDir(options.dir),
  });
  const write = result.code === 0 ? console.log : console.error;
  for (const m of result.messages) write(m);
  process.exitCode = result.code;
}
