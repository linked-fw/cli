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
 * `--add <repo>` places one more package worktree that no list names (`added`): checked out by
 * the same rules from its base clone, its npm name read from its `package.json` there, never a
 * reason to install and never built, so the app's install and lock stay as committed. A later run
 * without `--add` reports it `unlisted`, as any checkout no list names.
 *
 * Credentials come only from the environment (integration/credentials.ts): remote git calls get
 * the askpass environment, everything else runs without the token, and no URL with userinfo
 * reaches git. Base clones are shared between apps, so the run takes each one's lock
 * (integration/repo-lock.ts) around its git work on that repo, one at a time; a missing base clone
 * is cloned beside its place and renamed into it, so a lock never sits in a half-made clone.
 *
 * The core function takes options and an optional `run` and returns the JSON result; printing
 * is separate, so tests drive it against real throwaway repos.
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import {
  gitRunners,
  scrubSecret,
  stripUserinfo,
} from '../integration/credentials.js';
import {withRepoLock, type RepoLockOptions} from '../integration/repo-lock.js';
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
import {makeRun, type Run, type RunResult} from '../localize/run.js';
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
  /** How long to wait for another run's lock on a base clone (integration/repo-lock.ts). */
  lock?: RepoLockOptions;
  /** Repos of packages to check out beside the listed ones, unlisted (`--add`). */
  add?: string[];
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
  /** Placed by `--add`: no list names it; it triggers no install and is not built. */
  added?: true;
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
  private readonly remoteRun: (cwd: string, args: string[]) => RunResult;
  private readonly bases = new Map<string, string>();
  private readonly moved: Head[] = [];
  /** The worktrees `--add` placed: left out of the install trigger and the builds. */
  private readonly addedDirs = new Set<string>();

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
    const runners = gitRunners(runner, env);
    this.local = runners.local;
    this.remoteRun = runners.remote;
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
    const r = this.remoteRun(cwd, args);
    if (r.status !== 0) {
      throw new LocalizeError(
        `git ${args.join(' ')} failed in ${cwd}: ${(r.stderr || r.stdout).trim()}`,
        code,
      );
    }
    return r.stdout.trim();
  }

  run(): void {
    const {branch} = this;
    fs.mkdirSync(this.root, {recursive: true});
    if (
      !branch ||
      !this.ok(this.root, ['check-ref-format', '--branch', branch])
    ) {
      throw new LocalizeError(
        `"${branch}" is not a valid branch name.`,
        EXIT_USAGE,
      );
    }
    const repo = cleanRepo(this.options.repo ?? this.originOfCwd(), (m) =>
      this.say(m),
    );
    const {name} = baseClonePath(this.root, repo);
    const appDir = realish(
      this.options.dir
        ? path.resolve(this.cwd, this.options.dir)
        : path.join(this.root, name, branchDir(branch)),
    );

    this.result.app = this.withBase(repo, (base) =>
      this.appWorktree(repo, base, appDir),
    );
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
    const added = this.addPackages(
      appDir,
      reached.map((r) => r.entry),
    );
    this.result.packages.push(...added);
    this.result.packages.push(
      ...this.unlisted(
        appDir,
        new Set([...reached.map((r) => r.pkg.dir), ...added.map((p) => p.dir)]),
      ),
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
   * Run `fn` on the base clone of `repo` while holding its lock: the base clone is shared by every
   * app checkout under the root that uses the repo.
   */
  private withBase<T>(repo: string, fn: (base: string) => T): T {
    const {dir} = baseClonePath(this.root, repo);
    if (!fs.existsSync(dir)) this.cloneBase(repo, dir);
    return withRepoLock(
      dir,
      `linked checkout ${this.branch}`,
      () => fn(this.baseClone(repo)),
      this.options.lock,
    );
  }

  /**
   * Make the bare base clone of `repo` at `dir`: cloned into a directory beside it and renamed
   * into place, so another run never sees it half made. Its fetch refspec makes remote-tracking
   * refs; its copied local heads are deleted, so every worktree's branch is a local branch
   * tracking `origin/<branch>` and `origin/HEAD` is the default branch. When another run's clone
   * got there first, this one is dropped and that one is used.
   */
  private cloneBase(repo: string, dir: string): void {
    fs.mkdirSync(path.dirname(dir), {recursive: true});
    const tmp = fs.mkdtempSync(`${dir}.new-`);
    try {
      this.remote(this.root, ['clone', '--bare', '-q', '--', repo, tmp]);
      this.git(tmp, [
        'config',
        'remote.origin.fetch',
        '+refs/heads/*:refs/remotes/origin/*',
      ]);
      const heads = this.git(tmp, [
        'for-each-ref',
        '--format=%(refname)',
        'refs/heads',
      ]);
      for (const ref of heads.split('\n').filter(Boolean))
        this.git(tmp, ['update-ref', '-d', ref]);
      this.remote(tmp, ['fetch', '--prune', '-q', 'origin']);
      this.remote(tmp, ['remote', 'set-head', 'origin', '--auto']);
      try {
        fs.renameSync(tmp, dir);
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code !== 'ENOTEMPTY' && code !== 'EEXIST') throw e;
        return; // another run's clone is in place: baseClone verifies and fetches it
      }
      this.bases.set(repo, dir);
      this.say(`base clone ${dir} <- ${repo}`);
    } finally {
      fs.rmSync(tmp, {recursive: true, force: true});
    }
  }

  /**
   * The bare base clone of `repo` (made by {@link cloneBase}), checked and fetched (`--prune`)
   * once per run. Called under its lock ({@link withBase}).
   */
  private baseClone(repo: string): string {
    const known = this.bases.get(repo);
    if (known) return known;
    const {dir} = baseClonePath(this.root, repo);
    {
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
      // Always: a remote that renamed its default branch leaves origin/HEAD pointing at a
      // branch the prune just deleted.
      this.remote(dir, ['remote', 'set-head', 'origin', '--auto']);
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
      if (
        !this.hasRemoteBranch(base, branch) &&
        !this.everPushed(base, branch)
      ) {
        // An earlier run made the branch but its push failed: push it now.
        this.remote(
          dir,
          ['push', '-q', '--no-verify', '-u', 'origin', branch],
          EXIT_REFUSED,
        );
        this.say(`app: pushed ${branch}, which origin lacked`);
        return app('updated', false);
      }
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
    this.remote(
      dir,
      ['push', '-q', '--no-verify', '-u', 'origin', branch],
      EXIT_REFUSED,
    );
    this.say(`app: ${dir} on ${branch}, created from ${rule.from} and pushed`);
    return app('created', true);
  }

  /**
   * Whether `branch` was ever pushed from here: a successful `push -u` records its upstream. A
   * branch with none was made by a run whose push failed; one with an upstream that origin no
   * longer has was deleted there (merged, usually) and is not pushed again.
   */
  private everPushed(base: string, branch: string): boolean {
    return this.ok(base, ['config', '--get', `branch.${branch}.remote`]);
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
    return this.withBase(entry.repo, (base) =>
      this.packageWorktreeIn(entry, appDir, base),
    );
  }

  private packageWorktreeIn(
    entry: ListedPackage,
    appDir: string,
    base: string,
  ): CheckoutPackage {
    const {branch} = this;
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

  /**
   * The `--add` repos as package worktrees beside the listed ones: the npm name each declares on
   * the branch (else on the default branch) of its base clone; a package the lists reach already
   * is theirs (the same repo) or refused (another repo).
   */
  private addPackages(
    appDir: string,
    listed: ListedPackage[],
  ): CheckoutPackage[] {
    const out: CheckoutPackage[] = [];
    for (const raw of this.options.add ?? []) {
      const repo = cleanRepo(raw, (m) => this.say(m));
      const pkg = this.withBase(repo, (base) => {
        const name = this.declaredName(base, repo);
        const known = listed.find((e) => e.name === name);
        if (known) {
          if (stripUserinfo(normalizeGitUrl(known.repo)).url !== repo) {
            throw new LocalizeError(
              `--add ${repo} is ${name}, which the lists name with ${known.repo}. Add nothing, or make them agree.`,
              EXIT_REFUSED,
            );
          }
          this.say(
            `--add ${repo}: ${name} is listed, so it is checked out as listed.`,
          );
          return null;
        }
        const twin = out.find((p) => p.name === name);
        if (twin) {
          if (twin.repo !== repo) {
            throw new LocalizeError(
              `--add names ${name} twice, with ${twin.repo} and ${repo}.`,
              EXIT_REFUSED,
            );
          }
          return null;
        }
        const placed = this.packageWorktreeIn(
          {name, repo, requiredBy: []},
          appDir,
          base,
        );
        this.addedDirs.add(placed.dir);
        return {...placed, added: true as const};
      });
      if (pkg) out.push(pkg);
    }
    return out;
  }

  /** The npm name a package repo's `package.json` declares: on the run's branch when it has it, else on its default branch. */
  private declaredName(base: string, repo: string): string {
    const ref = this.hasRemoteBranch(base, this.branch)
      ? `refs/remotes/origin/${this.branch}`
      : `refs/remotes/origin/${this.defaultBranch(base)}`;
    const shown = this.local('git', ['show', `${ref}:package.json`], {
      cwd: base,
    });
    let name: unknown;
    try {
      name = (JSON.parse(shown.stdout) as {name?: unknown}).name;
    } catch {
      name = undefined;
    }
    if (shown.status !== 0 || typeof name !== 'string' || !name) {
      throw new LocalizeError(
        `--add ${repo}: its ${ref.replace('refs/remotes/', '')} has no package.json naming a package.`,
        EXIT_REFUSED,
      );
    }
    return name;
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
      if (this.addedDirs.has(dir)) continue;
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
      (p) => !p.unlisted && !p.added && movedDirs.has(p.dir),
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
      `  ${p.name}  ${where}${p.fellBack && !p.unlisted ? ' (fell back)' : ''}${p.added ? ' (added)' : ''}  ${p.status}${p.reason ? ` (${p.reason})` : ''}  ${p.dir}`,
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
    add?: string[];
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
    add: options.add,
  });
  if (options.json)
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  else
    (result.code === 0 ? console.log : console.error)(formatCheckout(result));
  process.exitCode = result.code;
}

export interface CheckoutRemoveOptions {
  /** The app worktree; default the worktree on `<branch>` of the repo `cwd` is in. */
  dir?: string;
  /** Remove even what has not landed or has changes; unlanded branches are kept. */
  force?: boolean;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** How long to wait for another run's lock on a base clone (integration/repo-lock.ts). */
  lock?: RepoLockOptions;
}

export interface CheckoutRemoveResult {
  code: number;
  removed: string[];
  kept: {dir: string; reason: string}[];
  branches: {repo: string; branch: string; deleted: boolean; sha: string}[];
  messages: string[];
}

/**
 * `linked worktree remove --branch <branch>`: remove a `linked checkout` checkout once it has
 * landed -- the package worktrees in its `packages-local/`, then the app worktree, then the
 * landed local branches. Landed means contained in `origin/<default>` after a fetch; a detached
 * fallback has landed when its HEAD is. Refuses, removing nothing, while a repo has not landed or
 * has changes, unless `force` (unlanded branches are then kept, their sha printed). Base clones
 * stay.
 */
export function checkoutRemove(
  branch: string,
  options: CheckoutRemoveOptions = {},
  run?: Run,
): CheckoutRemoveResult {
  const result: CheckoutRemoveResult = {
    code: 0,
    removed: [],
    kept: [],
    branches: [],
    messages: [],
  };
  try {
    return removeCheckout(branch, options, run, result);
  } catch (e) {
    // A base clone's lock another run held too long; what was removed before it is reported.
    if (!(e instanceof LocalizeError)) throw e;
    result.code = e.code;
    result.messages.push(e.message);
    return result;
  }
}

function removeCheckout(
  branch: string,
  options: CheckoutRemoveOptions,
  run: Run | undefined,
  result: CheckoutRemoveResult,
): CheckoutRemoveResult {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const {local, remote} = gitRunners(run ?? makeRun(cwd), env);
  const refuse = (code: number, ...m: string[]): CheckoutRemoveResult => {
    result.code = code;
    result.messages.push(...m);
    return result;
  };
  const git = (dir: string, args: string[]) => local('git', args, {cwd: dir});
  /** Under the lock of the base clone `common` (shared with other app checkouts). */
  const locked = <T>(common: string, fn: () => T): T =>
    withRepoLock(
      common,
      `linked worktree remove --branch ${branch}`,
      fn,
      options.lock,
    );

  let appDir: string;
  if (options.dir) {
    appDir = realish(path.resolve(cwd, options.dir));
  } else {
    const found = worktreesOf(local, cwd).find((wt) => wt.branch === branch);
    if (!found) {
      return refuse(
        EXIT_USAGE,
        `No worktree on ${branch} in the repository of ${cwd}. Pass the app worktree with --dir.`,
      );
    }
    appDir = realish(found.path);
  }
  const commonOf = (dir: string): string | null => {
    const r = git(dir, [
      'rev-parse',
      '--path-format=absolute',
      '--git-common-dir',
    ]);
    const g = git(dir, ['rev-parse', '--path-format=absolute', '--git-dir']);
    if (r.status !== 0 || g.status !== 0) return null;
    // A main working tree has its git dir as the common dir: never removed here.
    return realish(r.stdout.trim()) === realish(g.stdout.trim())
      ? null
      : realish(r.stdout.trim());
  };
  const appCommon = commonOf(appDir);
  if (!appCommon)
    return refuse(
      EXIT_REFUSED,
      `${appDir} is not a linked worktree (a checkout's app worktree).`,
    );
  const appBranchNow = currentBranch(local, appDir);
  if (appBranchNow !== branch) {
    return refuse(
      EXIT_REFUSED,
      `${appDir} is on ${appBranchNow ?? 'a detached HEAD'}, not ${branch}.`,
    );
  }

  interface Item {
    label: string;
    dir: string;
    common: string;
    branch: string | null;
    repo: string;
    landed: boolean;
    dirty: boolean;
  }
  const items: Item[] = [];
  const local_ = path.join(appDir, LOCAL_DIR);
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(local_).sort();
  } catch {
    /* no packages-local/ */
  }
  // `git worktree remove` deletes the app worktree with everything in it, its gitignored
  // packages-local/ included: anything there that is not a package worktree of the checkout (a
  // full clone, a monorepo clone in .repos/, a stray file) could hold work. Refused even with
  // --force; move it out first.
  const foreign = entries
    .map((e) => path.join(local_, e))
    .filter((d) => !fs.existsSync(path.join(d, '.git')) || !commonOf(d));
  if (foreign.length) {
    result.kept.push(
      ...foreign.map((dir) => ({
        dir,
        reason: 'not a package worktree of this checkout',
      })),
    );
    return refuse(
      EXIT_REFUSED,
      `${foreign.join(', ')} ${foreign.length === 1 ? 'is' : 'are'} in ${local_} but not a package worktree of this checkout, ` +
        `and removing the app worktree would delete ${foreign.length === 1 ? 'it' : 'them'}. Move ${foreign.length === 1 ? 'it' : 'them'} out first; nothing was removed.`,
    );
  }
  const dirs = [...entries.map((e) => path.join(local_, e)), appDir];
  for (const dir of dirs) {
    const common = dir === appDir ? appCommon : commonOf(dir);
    const label = (() => {
      const n = readJson(path.join(dir, 'package.json'))?.name;
      return typeof n === 'string' ? n : path.basename(dir);
    })();
    if (!common)
      return refuse(EXIT_REFUSED, `${dir} is not a linked worktree.`);
    const f = locked(common, () => {
      const fetched = remote(dir, ['fetch', '--prune', '-q', 'origin']);
      remote(dir, ['remote', 'set-head', 'origin', '--auto']);
      return fetched;
    });
    if (f.status !== 0)
      return refuse(
        EXIT_NOT_FOUND,
        `git fetch failed in ${dir}: ${(f.stderr || f.stdout).trim()}`,
      );
    const def = git(dir, [
      'symbolic-ref',
      '--short',
      '-q',
      'refs/remotes/origin/HEAD',
    ]).stdout.trim();
    const on = currentBranch(local, dir);
    const landed =
      !!def &&
      git(dir, [
        'merge-base',
        '--is-ancestor',
        on ? `refs/heads/${on}` : 'HEAD',
        `refs/remotes/${def}`,
      ]).status === 0;
    const dirty = git(dir, ['status', '--porcelain']).stdout.trim() !== '';
    const repo = stripUserinfo(
      git(dir, ['config', '--get', 'remote.origin.url']).stdout.trim(),
    ).url;
    items.push({label, dir, common, branch: on, repo, landed, dirty});
  }

  const problems = items.flatMap((it) => [
    ...(!it.landed
      ? [
          {
            dir: it.dir,
            reason: `${it.label}: ${it.branch ?? 'its HEAD'} has not landed in origin's default branch`,
          },
        ]
      : []),
    ...(it.dirty
      ? [
          {
            dir: it.dir,
            reason: `${it.label}: it has uncommitted or untracked changes`,
          },
        ]
      : []),
  ]);
  if (problems.length && !options.force) {
    result.kept.push(...problems);
    return refuse(
      EXIT_REFUSED,
      ...problems.map((p) => p.reason),
      'Nothing was removed. --force removes it anyway and keeps unlanded branches.',
    );
  }

  for (const it of items) {
    const args = [
      'worktree',
      'remove',
      ...(options.force ? ['--force'] : []),
      it.dir,
    ];
    const r = locked(it.common, () => {
      const removed = git(it.common, args);
      if (removed.status === 0) git(it.common, ['worktree', 'prune']);
      return removed;
    });
    if (r.status !== 0) {
      result.kept.push({dir: it.dir, reason: (r.stderr || r.stdout).trim()});
      return refuse(
        EXIT_REFUSED,
        `${it.label}: git ${args.join(' ')} failed: ${(r.stderr || r.stdout).trim()}`,
      );
    }
    result.removed.push(it.dir);
  }
  for (const it of items) {
    if (!it.branch) continue;
    const sha = git(it.common, [
      'rev-parse',
      `refs/heads/${it.branch}`,
    ]).stdout.trim();
    let deleted = false;
    const name = it.branch;
    if (it.landed)
      deleted = locked(
        it.common,
        () => git(it.common, ['branch', '-D', name]).status === 0,
      );
    else
      result.messages.push(
        `${it.label}: kept ${it.branch} at ${sha} (not landed)`,
      );
    result.branches.push({repo: it.repo, branch: it.branch, deleted, sha});
  }
  return result;
}

/** The commander action for `worktree remove --branch`. */
export async function runCheckoutRemove(
  branch: string,
  options: {dir?: string; force?: boolean; json?: boolean},
): Promise<void> {
  const result = checkoutRemove(branch, {
    dir: options.dir,
    force: options.force,
  });
  if (options.json)
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  else {
    const write = result.code === 0 ? console.log : console.error;
    for (const d of result.removed) write(`removed ${d}`);
    for (const b of result.branches)
      if (b.deleted) write(`deleted ${b.branch} (${b.repo})`);
    for (const m of result.messages) write(m);
  }
  process.exitCode = result.code;
}
