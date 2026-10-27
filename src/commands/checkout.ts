/**
 * `linked checkout <branch>` -- a branch checkout of an app and of the packages it lists in
 * `linked.unpublishedPackages`, as git worktrees of bare base clones in a projects root:
 *
 *   <root>/.repos/<owner>/<name>.git                  bare base clone, one per repo
 *   <root>/<name>/<branch-dir>/                       the app's worktree (or --dir)
 *   <root>/<name>/<branch-dir>/packages-local/<dir>/  a package's worktree
 *
 * The app is on `<branch>`, created from `--from` (default the remote's default branch) and
 * pushed when the remote lacks it. Each listed package (transitively: `walkUnpublished`) is on
 * `<branch>` when its repo has it, else detached at `origin/<default>` (`packageBranch`). Then one
 * `npm install` in the app worktree, its own install (never a link farm), and the builds of the
 * package worktrees that moved.
 *
 * Re-running it fetches every base clone and brings each worktree up to date where that is a
 * fast-forward on a clean tree; anything else is left as it is and reported `kept` with the
 * reason. Nothing is ever deleted: a package no longer listed is reported `unlisted`.
 *
 * Credentials come only from the environment (integration/credentials.ts): remote git calls get
 * the askpass environment, everything else runs without the token, and no URL with userinfo
 * reaches git. One checkout per base clone at a time: callers serialise per app.
 *
 * The core function takes options and an optional `run` and returns the JSON result; printing
 * is separate, so tests drive it against real throwaway repos.
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import {
  localEnv,
  remoteEnv,
  scrubSecret,
  stripUserinfo,
} from '../integration/credentials.js';
import {currentBranch} from '../integration/repos.js';
import {
  appBranch,
  branchDir,
  packageBranch,
  walkUnpublished,
  type ListedPackage,
} from '../integration/unpublished.js';
import {unpublishedPackages} from '../installed-packages.js';
import {
  EXIT_INSTALL_FAILED,
  EXIT_NOT_FOUND,
  EXIT_REFUSED,
  EXIT_USAGE,
  EXIT_WARNED,
  LocalizeError,
} from '../localize/errors.js';
import {installGitHooks} from '../localize/git-hooks.js';
import {
  defaultBuildCommand,
  INSTALL_ARGS,
  refuseSharedInstall,
  tail,
} from '../localize/localize.js';
import {checkoutNameFor, normalizeGitUrl} from '../localize/resolve.js';
import {makeRun, type Run} from '../localize/run.js';
import {refExists, worktreesOf} from './branch.js';
import {dependencyOrder} from './release.js';
import {realish} from './worktree.js';

export interface CheckoutOptions {
  /** The app's repo; default the `origin` of the app checkout `cwd` is in. */
  repo?: string;
  /** The projects root; default `cwd`. */
  root?: string;
  /** The app worktree's directory; default `<root>/<name>/<branch-dir>`. */
  dir?: string;
  /** What a new app branch is created from; default the remote's default branch. */
  from?: string;
  /** false: no install and no builds. */
  install?: boolean;
  /** The build command for each package worktree that moved; '' builds nothing. */
  build?: string;
  /** Where relative paths and a missing `--repo` are read from; default `process.cwd()`. */
  cwd?: string;
  /** The environment (LINKED_GIT_TOKEN comes from here); default `process.env`. */
  env?: NodeJS.ProcessEnv;
}

/** What happened to a worktree in this run. */
export type CheckoutStatus =
  'created' | 'updated' | 'unchanged' | 'switched' | 'kept';

export interface CheckoutApp {
  name: string;
  repo: string;
  dir: string;
  branch: string;
  /** The branch was created (from --from) and pushed by this run. */
  created: boolean;
  head: string;
  status: CheckoutStatus;
  /** Why a `kept` worktree was left as it is. */
  reason?: string;
}

export interface CheckoutPackage {
  name: string;
  repo: string;
  dir: string;
  /** The checked-out branch, or the default branch a detached fallback is at. */
  branch: string;
  detached: boolean;
  /** Its repo has no `<branch>`: detached at `origin/<default>`. */
  fellBack: boolean;
  head: string;
  /** The packages whose lists name it, the app first. */
  requiredBy: string[];
  status: CheckoutStatus;
  reason?: string;
  /** In `packages-local/` but no list names it any more; left as it is. */
  unlisted?: true;
}

export interface CheckoutResult {
  code: number;
  branch: string;
  root: string;
  app: CheckoutApp | null;
  packages: CheckoutPackage[];
  install: {ran: boolean; ok: boolean};
  builds: {name: string; result: 'ok' | 'failed' | 'skipped'}[];
  messages: string[];
}

const LOCAL_DIR = 'packages-local';
const WORKSPACE_GLOB = `${LOCAL_DIR}/*`;
/** The files whose change makes a re-run install again. */
const MANIFESTS = ['package.json', 'package-lock.json'];

/** The base clone's place under `<root>/.repos/`: `<owner>/<name>.git`, from the URL path. */
export function baseClonePath(
  root: string,
  repo: string,
): {dir: string; name: string} {
  let pathname: string;
  try {
    pathname = new URL(repo).pathname;
  } catch {
    throw new LocalizeError(`${repo} is not a URL.`, EXIT_USAGE);
  }
  const parts = pathname.split('/').filter(Boolean);
  const name = (parts.pop() ?? '').replace(/\.git$/, '');
  const owner = parts.pop() ?? '_';
  if (!name)
    throw new LocalizeError(`${repo} names no repository.`, EXIT_USAGE);
  return {dir: path.join(root, '.repos', owner, `${name}.git`), name};
}

/** A clean, normalized `https:`/`file:` repo URL, or a usage error. */
function cleanRepo(raw: string, warn: (m: string) => void): string {
  const {url, stripped} = stripUserinfo(normalizeGitUrl(raw));
  if (stripped)
    warn(
      `${url}: credentials in the URL are ignored; pass a token in LINKED_GIT_TOKEN.`,
    );
  if (!/^(https|file):\/\/[^/]*\/./i.test(url)) {
    throw new LocalizeError(
      `${url} is not an https:// (or file://) URL.`,
      EXIT_USAGE,
    );
  }
  return url;
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Make or update the branch checkout. Never throws for a refusal: the result's `code` says what
 * happened (0, 5 a build failed, 2 usage, 4 a remote could not be reached, 6 refused, 7 the
 * install failed) and `messages` why.
 */
export function checkout(
  branch: string,
  options: CheckoutOptions = {},
  run?: Run,
): CheckoutResult {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const root = realish(path.resolve(cwd, options.root ?? '.'));
  const result: CheckoutResult = {
    code: 0,
    branch,
    root,
    app: null,
    packages: [],
    install: {ran: false, ok: true},
    builds: [],
    messages: [],
  };
  const baseRun = run ?? makeRun(root);
  const messages = result.messages;
  try {
    new Checkout(branch, options, root, cwd, env, baseRun, result).run();
  } catch (e) {
    if (!(e instanceof LocalizeError)) throw e;
    result.code = Math.max(result.code, e.code);
    messages.push(scrubSecret(e.message, env));
  }
  return result;
}

interface Head {
  dir: string;
  before: string | null;
}

class Checkout {
  private readonly local: Run;
  private readonly bases = new Map<string, string>();
  private readonly moved: Head[] = [];

  constructor(
    private readonly branch: string,
    private readonly options: CheckoutOptions,
    private readonly root: string,
    private readonly cwd: string,
    private readonly env: NodeJS.ProcessEnv,
    private readonly runner: Run,
    private readonly result: CheckoutResult,
  ) {
    // Every local subprocess runs without the token: hooks and lifecycle scripts never see it.
    this.local = (cmd, args, opts = {}) =>
      runner(cmd, args, {...opts, env: opts.env ?? localEnv(env)});
  }

  private say(m: string): void {
    this.result.messages.push(m);
  }

  /** Local git; throws a refusal with git's message when it fails. */
  private git(cwd: string, args: string[]): string {
    const r = this.local('git', args, {cwd});
    if (r.status !== 0) {
      throw new LocalizeError(
        `git ${args.join(' ')} failed in ${cwd}: ${(r.stderr || r.stdout).trim()}`,
        EXIT_REFUSED,
      );
    }
    return r.stdout.trim();
  }

  private ok(cwd: string, args: string[]): boolean {
    return this.local('git', args, {cwd}).status === 0;
  }

  /** A git call that reaches the remote: the askpass environment, the token scrubbed from errors. */
  private remote(cwd: string, args: string[], code = EXIT_NOT_FOUND): string {
    const r = this.runner('git', args, {cwd, env: remoteEnv(this.env)});
    if (r.status !== 0) {
      throw new LocalizeError(
        `git ${args.join(' ')} failed in ${cwd}: ${scrubSecret((r.stderr || r.stdout).trim(), this.env)}`,
        code,
      );
    }
    return r.stdout.trim();
  }

  run(): void {
    const {branch} = this;
    if (
      !branch ||
      !this.ok(this.root, ['check-ref-format', '--branch', branch])
    ) {
      throw new LocalizeError(
        `"${branch}" is not a valid branch name.`,
        EXIT_USAGE,
      );
    }
    fs.mkdirSync(this.root, {recursive: true});
    const repo = cleanRepo(this.options.repo ?? this.originOfCwd(), (m) =>
      this.say(m),
    );
    const {name} = baseClonePath(this.root, repo);
    const base = this.baseClone(repo);
    const appDir = realish(
      this.options.dir
        ? path.resolve(this.cwd, this.options.dir)
        : path.join(this.root, name, branchDir(branch)),
    );

    this.result.app = this.appWorktree(repo, base, appDir);
    const appJson = readJson(path.join(appDir, 'package.json'));
    const list = unpublishedPackages(appJson, (m) => this.say(m));
    if (list.length) this.requireSetup(appJson, appDir);

    const published = {
      ...((appJson?.dependencies as Record<string, unknown> | undefined) ?? {}),
      ...((appJson?.devDependencies as Record<string, unknown> | undefined) ??
        {}),
    };
    const reached: {entry: ListedPackage; pkg: CheckoutPackage}[] = [];
    walkUnpublished(
      appJson,
      (entry) => {
        if (entry.name in published) {
          this.say(
            `${entry.name} is in linked.unpublishedPackages and in dependencies: a published package belongs in dependencies only.`,
          );
        }
        const pkg = this.packageWorktree(entry, appDir);
        reached.push({entry, pkg});
        this.result.packages.push(pkg);
        return readJson(path.join(pkg.dir, 'package.json'));
      },
      (m) => this.say(m),
    );
    for (const {entry, pkg} of reached) pkg.requiredBy = [...entry.requiredBy];
    this.result.packages.push(
      ...this.unlisted(appDir, new Set(reached.map((r) => r.pkg.dir))),
    );

    const hooks = installGitHooks(appDir);
    if (hooks.hooksPath !== null) {
      this.say(
        `core.hooksPath is set (${hooks.hooksPath}): the localize git hooks were not written.`,
      );
    }
    if (this.options.install === false) return;
    this.installAndBuild(appDir);
  }

  /** The `origin` of the git checkout `cwd` is in: `--repo` may be left out inside an app checkout. */
  private originOfCwd(): string {
    const r = this.local('git', ['remote', 'get-url', 'origin'], {
      cwd: this.cwd,
    });
    const url = r.stdout.trim();
    if (r.status !== 0 || !url) {
      throw new LocalizeError(
        `--repo <app https url> is needed: ${this.cwd} is not in a checkout with an origin.`,
        EXIT_USAGE,
      );
    }
    return url;
  }

  /**
   * The bare base clone of `repo`, made on first use and fetched (`--prune`) once per run. Its
   * fetch refspec makes remote-tracking refs; its copied local heads are deleted, so every
   * worktree's branch is a local branch tracking `origin/<branch>` and `origin/HEAD` is the
   * default branch.
   */
  private baseClone(repo: string): string {
    const known = this.bases.get(repo);
    if (known) return known;
    const {dir} = baseClonePath(this.root, repo);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(path.dirname(dir), {recursive: true});
      this.remote(this.root, ['clone', '--bare', '-q', '--', repo, dir]);
      this.git(dir, [
        'config',
        'remote.origin.fetch',
        '+refs/heads/*:refs/remotes/origin/*',
      ]);
      const heads = this.git(dir, [
        'for-each-ref',
        '--format=%(refname)',
        'refs/heads',
      ]);
      for (const ref of heads.split('\n').filter(Boolean))
        this.git(dir, ['update-ref', '-d', ref]);
      this.remote(dir, ['fetch', '--prune', '-q', 'origin']);
      this.remote(dir, ['remote', 'set-head', 'origin', '--auto']);
      this.say(`base clone ${dir} <- ${repo}`);
    } else {
      const bare = this.local('git', ['rev-parse', '--is-bare-repository'], {
        cwd: dir,
      }).stdout.trim();
      const origin = this.local(
        'git',
        ['config', '--get', 'remote.origin.url'],
        {cwd: dir},
      ).stdout.trim();
      if (bare !== 'true' || origin !== repo) {
        throw new LocalizeError(
          `${dir} is not the base clone of ${repo} (${bare !== 'true' ? 'not a bare repository' : `its origin is ${origin || 'unset'}`}). Move it out of the way.`,
          EXIT_REFUSED,
        );
      }
      this.remote(dir, ['fetch', '--prune', '-q', 'origin']);
      if (!this.ok(dir, ['symbolic-ref', '-q', 'refs/remotes/origin/HEAD'])) {
        this.remote(dir, ['remote', 'set-head', 'origin', '--auto']);
      }
    }
    this.bases.set(repo, dir);
    return dir;
  }

  /** The remote's default branch, from `origin/HEAD`. */
  private defaultBranch(base: string): string {
    const ref = this.local(
      'git',
      ['symbolic-ref', '--short', '-q', 'refs/remotes/origin/HEAD'],
      {cwd: base},
    ).stdout.trim();
    if (!ref)
      throw new LocalizeError(
        `${base}: the remote has no default branch (origin/HEAD).`,
        EXIT_REFUSED,
      );
    return ref.replace(/^origin\//, '');
  }

  private hasRemoteBranch(base: string, branch: string): boolean {
    return refExists(this.local, base, `refs/remotes/origin/${branch}`);
  }

  /** The worktree of `base` at `dir`, if there is one. */
  private worktreeAt(base: string, dir: string) {
    return worktreesOf(this.local, base).find((wt) => realish(wt.path) === dir);
  }

  /** Refuse when another worktree of `base` has `branch`: git allows a branch in one worktree only. */
  private refuseHeld(base: string, branch: string, dir: string): void {
    const holder = worktreesOf(this.local, base).find(
      (wt) => wt.branch === branch && realish(wt.path) !== dir,
    );
    if (holder) {
      throw new LocalizeError(
        `${branch} is checked out in ${holder.path} already (a branch can be in one worktree only). Remove that worktree, or pass its directory with --dir.`,
        EXIT_REFUSED,
      );
    }
  }

  private head(dir: string): string {
    return this.git(dir, ['rev-parse', 'HEAD']);
  }

  private dirty(dir: string): boolean {
    return this.git(dir, ['status', '--porcelain']) !== '';
  }

  /** Bring a worktree that is on `branch` to `origin/<branch>` when that is a fast-forward. */
  private updateOnBranch(
    dir: string,
    base: string,
    branch: string,
  ): {status: CheckoutStatus; reason?: string} {
    if (!this.hasRemoteBranch(base, branch))
      return {status: 'kept', reason: `origin has no ${branch}`};
    const head = this.head(dir);
    const upstream = this.git(base, [
      'rev-parse',
      `refs/remotes/origin/${branch}`,
    ]);
    if (head === upstream) return {status: 'unchanged'};
    if (this.dirty(dir))
      return {status: 'kept', reason: 'it has uncommitted changes'};
    if (this.ok(dir, ['merge-base', '--is-ancestor', head, upstream])) {
      this.git(dir, ['merge', '--ff-only', '-q', `origin/${branch}`]);
      this.moved.push({dir, before: head});
      return {status: 'updated'};
    }
    if (this.ok(dir, ['merge-base', '--is-ancestor', upstream, head])) {
      return {
        status: 'kept',
        reason: `it has commits origin/${branch} lacks: push them`,
      };
    }
    return {status: 'kept', reason: `it has diverged from origin/${branch}`};
  }

  private appWorktree(repo: string, base: string, dir: string): CheckoutApp {
    const {branch} = this;
    const name = (dirPkg: string) => {
      const n = readJson(path.join(dirPkg, 'package.json'))?.name;
      return typeof n === 'string' ? n : '';
    };
    const app = (
      status: CheckoutStatus,
      created: boolean,
      reason?: string,
    ): CheckoutApp => ({
      name: name(dir),
      repo,
      dir,
      branch,
      created,
      head: this.head(dir),
      status,
      ...(reason ? {reason} : {}),
    });

    if (this.worktreeAt(base, dir)) {
      const on = currentBranch(this.local, dir);
      if (on !== branch)
        return app(
          'kept',
          false,
          `it is on ${on ?? 'a detached HEAD'}, not ${branch}`,
        );
      const {status, reason} = this.updateOnBranch(dir, base, branch);
      return app(status, false, reason);
    }
    if (fs.existsSync(dir)) {
      throw new LocalizeError(
        `${dir} exists and is not a worktree of ${base}. Move it out of the way.`,
        EXIT_REFUSED,
      );
    }
    this.refuseHeld(base, branch, dir);
    fs.mkdirSync(path.dirname(dir), {recursive: true});
    const local = refExists(this.local, base, `refs/heads/${branch}`);
    const rule = appBranch(
      this.hasRemoteBranch(base, branch),
      this.options.from ?? 'origin/HEAD',
    );
    if (!rule.create) {
      if (local) {
        this.git(base, ['worktree', 'add', '-q', dir, branch]);
        this.updateOnBranch(dir, base, branch);
      } else {
        this.git(base, [
          'worktree',
          'add',
          '-q',
          '--track',
          '-b',
          branch,
          dir,
          `origin/${branch}`,
        ]);
      }
      this.moved.push({dir, before: null});
      this.say(`app: ${dir} on ${branch}`);
      return app('created', false);
    }
    if (local) {
      this.git(base, ['worktree', 'add', '-q', dir, branch]);
    } else {
      const from = this.fromRef(base, rule.from);
      this.git(base, [
        'worktree',
        'add',
        '-q',
        '--no-track',
        '-b',
        branch,
        dir,
        from,
      ]);
    }
    this.moved.push({dir, before: null});
    this.remote(dir, ['push', '-q', '-u', 'origin', branch], EXIT_REFUSED);
    this.say(`app: ${dir} on ${branch}, created from ${rule.from} and pushed`);
    return app('created', true);
  }

  /** `--from` as a commit: `origin/<from>` when the remote has that branch, else the ref as given. */
  private fromRef(base: string, from: string): string {
    if (this.hasRemoteBranch(base, from)) return `origin/${from}`;
    if (refExists(this.local, base, from)) return from;
    throw new LocalizeError(
      `--from ${from}: no such branch or commit in ${base}.`,
      EXIT_USAGE,
    );
  }

  private requireSetup(
    appJson: Record<string, unknown> | null,
    appDir: string,
  ): void {
    const ws = appJson?.workspaces;
    const globs = Array.isArray(ws)
      ? ws
      : ws &&
          typeof ws === 'object' &&
          Array.isArray((ws as {packages?: unknown}).packages)
        ? (ws as {packages: unknown[]}).packages
        : [];
    if (!globs.includes(WORKSPACE_GLOB)) {
      throw new LocalizeError(
        `${appDir}/package.json lists unpublished packages but its "workspaces" lacks "${WORKSPACE_GLOB}", so npm would not link them. ` +
          `Set the app up once (\`linked localize --listed\` in a clone of it) and commit the set-up.`,
        EXIT_REFUSED,
      );
    }
  }

  private packageWorktree(
    entry: ListedPackage,
    appDir: string,
  ): CheckoutPackage {
    const {branch} = this;
    const base = this.baseClone(entry.repo);
    const dir = path.join(appDir, LOCAL_DIR, checkoutNameFor(entry.name));
    const def = this.defaultBranch(base);
    const rule = packageBranch(branch, this.hasRemoteBranch(base, branch), def);
    const pkg = (status: CheckoutStatus, reason?: string): CheckoutPackage => {
      const on = currentBranch(this.local, dir);
      return {
        name: entry.name,
        repo: entry.repo,
        dir,
        branch: on ?? def,
        detached: on === null,
        fellBack: on !== branch,
        head: this.head(dir),
        requiredBy: entry.requiredBy,
        status,
        ...(reason ? {reason} : {}),
      };
    };

    if (this.worktreeAt(base, dir)) {
      const {status, reason} = this.updatePackage(
        dir,
        base,
        def,
        rule.on === 'branch',
      );
      return this.checkName(entry, dir, pkg(status, reason), false);
    }
    if (fs.existsSync(dir)) {
      return this.checkName(
        entry,
        dir,
        pkg('kept', `it is not a worktree of ${base}`),
        false,
      );
    }
    fs.mkdirSync(path.dirname(dir), {recursive: true});
    if (rule.on === 'branch') {
      this.refuseHeld(base, branch, dir);
      if (refExists(this.local, base, `refs/heads/${branch}`)) {
        this.git(base, ['worktree', 'add', '-q', dir, branch]);
        this.updateOnBranch(dir, base, branch);
      } else {
        this.git(base, [
          'worktree',
          'add',
          '-q',
          '--track',
          '-b',
          branch,
          dir,
          `origin/${branch}`,
        ]);
      }
    } else {
      this.git(base, [
        'worktree',
        'add',
        '-q',
        '--detach',
        dir,
        `origin/${def}`,
      ]);
    }
    this.moved.push({dir, before: null});
    this.say(
      `${entry.name}: ${dir} ${rule.on === 'branch' ? `on ${branch}` : `detached at origin/${def} (no ${branch} in its repo)`}`,
    );
    return this.checkName(entry, dir, pkg('created'), true);
  }

  /** A listed repo whose package.json names another package is refused; a worktree this run made goes. */
  private checkName(
    entry: ListedPackage,
    dir: string,
    pkg: CheckoutPackage,
    created: boolean,
  ): CheckoutPackage {
    const declared = readJson(path.join(dir, 'package.json'))?.name;
    if (declared === entry.name) return pkg;
    if (created) {
      const base = this.bases.get(entry.repo);
      if (base)
        this.local('git', ['worktree', 'remove', '--force', dir], {cwd: base});
    }
    throw new LocalizeError(
      `${entry.repo} is listed as ${entry.name}, but its package.json ${typeof declared === 'string' ? `declares "${declared}"` : 'names no package'}` +
        `${created ? '; its worktree was removed' : ''}. Nothing was installed.`,
      EXIT_REFUSED,
    );
  }

  /** A re-run on a package worktree: follow its branch, switch a fallback whose branch appeared, or move a fallback to the new default tip. */
  private updatePackage(
    dir: string,
    base: string,
    def: string,
    branchExists: boolean,
  ): {status: CheckoutStatus; reason?: string} {
    const {branch} = this;
    const on = currentBranch(this.local, dir);
    if (on === branch) return this.updateOnBranch(dir, base, branch);
    if (on !== null)
      return {
        status: 'kept',
        reason: `it is on ${on}, not ${branch} or detached`,
      };
    if (this.dirty(dir))
      return {status: 'kept', reason: 'it has uncommitted changes'};
    const head = this.head(dir);
    if (branchExists) {
      this.refuseHeld(base, branch, dir);
      if (refExists(this.local, base, `refs/heads/${branch}`)) {
        this.git(dir, ['switch', '-q', branch]);
        this.updateOnBranch(dir, base, branch);
      } else {
        this.git(dir, [
          'switch',
          '-q',
          '--track',
          '-c',
          branch,
          `origin/${branch}`,
        ]);
      }
      this.moved.push({dir, before: head});
      return {status: 'switched'};
    }
    const tip = this.git(base, ['rev-parse', `refs/remotes/origin/${def}`]);
    if (head === tip) return {status: 'unchanged'};
    if (!this.ok(dir, ['merge-base', '--is-ancestor', head, tip])) {
      return {
        status: 'kept',
        reason: `its detached HEAD has commits origin/${def} lacks`,
      };
    }
    this.git(dir, ['checkout', '-q', '--detach', `origin/${def}`]);
    this.moved.push({dir, before: head});
    return {status: 'updated'};
  }

  /** The package worktrees in `packages-local/` no list names any more: reported, never deleted. */
  private unlisted(appDir: string, listed: Set<string>): CheckoutPackage[] {
    const local = path.join(appDir, LOCAL_DIR);
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(local).filter((e) => !e.startsWith('.'));
    } catch {
      return [];
    }
    const out: CheckoutPackage[] = [];
    for (const e of entries.sort()) {
      const dir = path.join(local, e);
      if (listed.has(dir) || !fs.existsSync(path.join(dir, '.git'))) continue;
      const on = currentBranch(this.local, dir);
      const nm = readJson(path.join(dir, 'package.json'))?.name;
      const url = this.local('git', ['config', '--get', 'remote.origin.url'], {
        cwd: dir,
      }).stdout.trim();
      out.push({
        name: typeof nm === 'string' ? nm : e,
        repo: url,
        dir,
        branch: on ?? 'HEAD',
        detached: on === null,
        fellBack: on !== this.branch,
        head: this.head(dir),
        requiredBy: [],
        status: 'kept',
        reason: 'no list names it any more',
        unlisted: true,
      });
    }
    return out;
  }

  /** Whether a worktree that moved changed a manifest, or the app has no install yet. */
  private needsInstall(appDir: string): boolean {
    if (!fs.existsSync(path.join(appDir, 'node_modules'))) return true;
    for (const {dir, before} of this.moved) {
      if (before === null) return true;
      const changed = this.git(dir, [
        'diff',
        '--name-only',
        before,
        'HEAD',
        '--',
        ...MANIFESTS,
      ]);
      if (changed) return true;
    }
    return false;
  }

  private installAndBuild(appDir: string): void {
    const {result} = this;
    if (this.needsInstall(appDir)) {
      refuseSharedInstall(appDir);
      result.install.ran = true;
      const r = this.local('npm', INSTALL_ARGS, {cwd: appDir});
      if (r.status !== 0) {
        result.install.ok = false;
        result.code = Math.max(result.code, EXIT_INSTALL_FAILED);
        this.say(
          `npm ${INSTALL_ARGS.join(' ')} failed in ${appDir}:\n${scrubSecret(tail(r.stderr || r.stdout), this.env)}`,
        );
        return;
      }
      this.say(`npm ${INSTALL_ARGS.join(' ')} (${appDir})`);
    }
    const movedDirs = new Set(this.moved.map((m) => m.dir));
    const toBuild = result.packages.filter(
      (p) => !p.unlisted && movedDirs.has(p.dir),
    );
    const ordered = dependencyOrder(
      toBuild.map((p) => ({
        rel: path.relative(appDir, p.dir),
        dir: p.dir,
        packageName: p.name,
      })),
    );
    for (const repo of ordered) {
      const cmd =
        this.options.build ??
        defaultBuildCommand(readJson(path.join(repo.dir, 'package.json')));
      if (!cmd) {
        result.builds.push({name: repo.packageName, result: 'skipped'});
        continue;
      }
      const r = this.local(cmd, [], {cwd: repo.dir, shell: true});
      if (r.status !== 0) {
        result.builds.push({name: repo.packageName, result: 'failed'});
        result.code = Math.max(result.code, EXIT_WARNED);
        this.say(
          `${repo.packageName}: \`${cmd}\` failed:\n${scrubSecret(tail(r.stderr || r.stdout), this.env)}`,
        );
      } else {
        result.builds.push({name: repo.packageName, result: 'ok'});
      }
    }
  }
}

/** One line per worktree, for the terminal. */
export function formatCheckout(r: CheckoutResult): string {
  const lines: string[] = [...r.messages];
  if (r.app) {
    lines.push(
      `app ${r.app.name || r.app.repo}  ${r.app.branch}  ${r.app.status}${r.app.reason ? ` (${r.app.reason})` : ''}  ${r.app.dir}`,
    );
  }
  for (const p of r.packages) {
    const where = p.detached ? `detached at ${p.branch}` : p.branch;
    lines.push(
      `  ${p.name}  ${where}${p.fellBack && !p.unlisted ? ' (fell back)' : ''}  ${p.status}${p.reason ? ` (${p.reason})` : ''}  ${p.dir}`,
    );
  }
  if (r.install.ran) lines.push(`install: ${r.install.ok ? 'ok' : 'failed'}`);
  for (const b of r.builds) lines.push(`build ${b.name}: ${b.result}`);
  return lines.join('\n');
}

/** The commander action for `checkout`. */
export async function runCheckout(
  branch: string,
  options: {
    repo?: string;
    root?: string;
    dir?: string;
    from?: string;
    install?: boolean;
    build?: string;
    json?: boolean;
  },
): Promise<void> {
  const result = checkout(branch, {
    repo: options.repo,
    root: options.root,
    dir: options.dir,
    from: options.from,
    install: options.install,
    build: options.build,
  });
  if (options.json)
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  else
    (result.code === 0 ? console.log : console.error)(formatCheckout(result));
  process.exitCode = result.code;
}
