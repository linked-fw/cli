/**
 * `linked branch fork` and `linked branch merge` -- carry a project branch into a package repo,
 * and land it in every repo of an app checkout (a `linked checkout` worktree, or a developer's
 * app with `packages-local/` clones).
 *
 * - `fork <branch> <package>`: the package checkout (usually a fallback detached at
 *   `origin/<default>`) gets `<branch>` from its current head, pushed. Idempotent.
 * - `fork <branch> <package> --worktree <dir> [--from <ref>]`: `<branch>` in a worktree of its own
 *   at `<dir>`, from the package's base clone (found through the package's checkout in the app),
 *   created from `<ref>` (default `origin/HEAD`) and pushed, or on origin's `<branch>` when it has
 *   one; the app checkout is not touched. Idempotent.
 * - `push <branch>`: every repo of the checkout on `<branch>` (the app and each package checkout on
 *   it) pushes what origin lacks, so a later `merge` (which refuses unpushed commits) finds them.
 *   With `--worktree <dir>`: that one worktree, on `<branch>`, only.
 * - `merge <branch> --into <default>`: the repos on `<branch>` (the app and each package
 *   checkout on it; fallbacks are skipped), packages in dependency order (with the
 *   `linked.unpublishedPackages` edges), the app last. `--mode push` (the default) merges
 *   `origin/<branch>` into `origin/<default>` with `--no-ff` in a temporary detached worktree and
 *   pushes `<default>`; `--mode update` merges `origin/<default>` into `<branch>` and pushes the
 *   branch, for a caller that may not push to a protected default branch and lands each repo by
 *   a PR in the order returned. Both stop at the first conflict or refused push.
 *
 * Credentials as in `linked checkout`: only `LINKED_GIT_TOKEN`, through the askpass environment
 * on fetch and push (integration/credentials.ts).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import {gitRunners, stripUserinfo} from '../integration/credentials.js';
import {
  withCheckoutLock,
  type RepoLockOptions,
} from '../integration/repo-lock.js';
import {listRepos, type RepoInfo} from '../integration/repos.js';
import {findAppRoot} from '../localize/app-root.js';
import {
  EXIT_NOT_FOUND,
  EXIT_REFUSED,
  EXIT_USAGE,
  LocalizeError,
} from '../localize/errors.js';
import {makeRun, type Run} from '../localize/run.js';
import {refExists, selectCheckouts, worktreesOf} from './branch.js';
import {realish} from './worktree.js';
import {dependencyOrder} from './release.js';

export interface ForkOptions {
  /** The app checkout; default the app root `cwd` is in. */
  dir?: string;
  /**
   * Make `<branch>` in a worktree of its own at this directory (from the package's base clone)
   * instead of in the app checkout's package checkout, which is left as it is.
   */
  worktree?: string;
  /** With `worktree`: what a new branch starts from; default `origin/HEAD`. */
  from?: string;
  env?: NodeJS.ProcessEnv;
  /** How long to wait for another run's lock on a shared base clone. */
  lock?: RepoLockOptions;
}

export interface ForkResult {
  code: number;
  package: string;
  dir: string;
  branch: string;
  /** The commit the branch starts from (its head when it already existed). */
  from: string;
  /** Whether this run pushed it. */
  pushed: boolean;
  messages: string[];
}

function commonSetup(
  run: Run | undefined,
  dir: string,
  env: NodeJS.ProcessEnv,
) {
  return gitRunners(run ?? makeRun(dir), env);
}

const out = (r: {stdout: string; stderr: string}): string =>
  (r.stderr || r.stdout).trim();

/**
 * `fn` under the lock of the git dir of the checkout at `dir` (integration/repo-lock.ts); a lock
 * another run held past the wait is answered by `refuse`.
 */
function locked<T, R>(
  run: Run,
  dir: string,
  what: string,
  options: {lock?: RepoLockOptions},
  refuse: (code: number, message: string) => R,
  fn: () => T,
): T | R {
  try {
    return withCheckoutLock(run, dir, what, fn, options.lock);
  } catch (e) {
    if (!(e instanceof LocalizeError)) throw e;
    return refuse(e.code, e.message);
  }
}

/**
 * Create `branch` in the `packages-local/` checkout `pkg` names (npm name, dir name or short
 * name) from its current head, and push it. Refuses (6) a dirty checkout, and a branch `origin`
 * already has unless the checkout is on it (then only unpushed commits are pushed; none: code 0,
 * `pushed: false`). A local branch that exists unpushed is switched to and pushed.
 */
export async function branchFork(
  appDir: string,
  branch: string,
  pkg: string,
  options: ForkOptions = {},
  run?: Run,
): Promise<ForkResult> {
  const env = options.env ?? process.env;
  const {local, remote} = commonSetup(run, appDir, env);
  const result: ForkResult = {
    code: 0,
    package: pkg,
    dir: '',
    branch,
    from: '',
    pushed: false,
    messages: [],
  };
  const refuse = (code: number, m: string): ForkResult => ({
    ...result,
    code,
    messages: [...result.messages, m],
  });
  if (
    local('git', ['check-ref-format', '--branch', branch], {cwd: appDir})
      .status !== 0
  ) {
    return refuse(EXIT_USAGE, `"${branch}" is not a valid branch name.`);
  }
  const repos = (await listRepos(appDir, local)).slice(1);
  const chosen = selectCheckouts(repos, [pkg]);
  if ('error' in chosen) return refuse(EXIT_USAGE, chosen.error);
  const repo = chosen.repos[0];
  result.package = repo.packageName ?? pkg;
  if (options.worktree !== undefined)
    return forkWorktree(repo, branch, options, {local, remote}, result, refuse);
  if (options.from !== undefined)
    return refuse(EXIT_USAGE, '--from goes with --worktree: without it the branch starts at the checkout\'s head.');
  result.dir = repo.dir;
  result.from = repo.head;
  if (repo.dirty)
    return refuse(
      EXIT_REFUSED,
      `${repo.rel} has uncommitted or untracked changes: commit or stash them first.`,
    );
  // The checkout's git dir is the package's base clone, which other app checkouts share.
  return locked(
    local,
    repo.dir,
    `linked branch fork ${branch}`,
    options,
    refuse,
    () => {
      const fetch = remote(repo.dir, ['fetch', '--prune', '-q', 'origin']);
      if (fetch.status !== 0)
        return refuse(
          EXIT_NOT_FOUND,
          `git fetch failed in ${repo.dir}: ${out(fetch)}`,
        );
      const onRemote = refExists(
        local,
        repo.dir,
        `refs/remotes/origin/${branch}`,
      );
      const push = (): ForkResult => {
        const r = remote(repo.dir, [
          'push',
          '-q',
          '--no-verify',
          '-u',
          'origin',
          branch,
        ]);
        if (r.status !== 0)
          return refuse(
            EXIT_REFUSED,
            `git push origin ${branch} failed in ${repo.dir}: ${out(r)}`,
          );
        result.pushed = true;
        result.messages.push(`${result.package}: pushed ${branch}`);
        return result;
      };

      if (repo.branch === branch) {
        if (!onRemote) return push();
        const ahead = local(
          'git',
          ['rev-list', '--count', `refs/remotes/origin/${branch}..HEAD`],
          {cwd: repo.dir},
        ).stdout.trim();
        if (ahead === '0') {
          result.messages.push(
            `${result.package}: on ${branch} already, pushed`,
          );
          return result;
        }
        return push();
      }
      if (onRemote) {
        return refuse(
          EXIT_REFUSED,
          `origin of ${result.package} has ${branch} already; \`linked checkout ${branch}\` switches the package worktree to it.`,
        );
      }
      const exists = refExists(local, repo.dir, `refs/heads/${branch}`);
      const args = exists
        ? ['switch', '-q', branch]
        : ['switch', '-q', '-c', branch];
      const sw = local('git', args, {cwd: repo.dir});
      if (sw.status !== 0)
        return refuse(
          EXIT_REFUSED,
          `git ${args.join(' ')} failed in ${repo.dir}: ${out(sw)}`,
        );
      result.from = local('git', ['rev-parse', 'HEAD'], {
        cwd: repo.dir,
      }).stdout.trim();
      result.messages.push(
        `${result.package}: ${exists ? 'switched to' : 'created'} ${branch} at ${result.from}`,
      );
      return push();
    },
  );
}

/**
 * `branch fork --worktree`: `branch` in a worktree of its own at `options.worktree`, of the base
 * clone of the package checkout `repo` (shared with every app checkout of the package, so under its
 * lock). A worktree already there on `branch` is reused (unpushed commits pushed); otherwise the
 * worktree is added on the local `branch`, else on origin's (tracked), else on a new `branch` from
 * `options.from` (default `origin/HEAD`), pushed `-u`. Refuses (6) a directory that is something
 * else, a worktree there on another branch, and a `branch` another worktree holds.
 */
function forkWorktree(
  repo: RepoInfo,
  branch: string,
  options: ForkOptions,
  git: {local: Run; remote: (cwd: string, args: string[]) => {status: number; stdout: string; stderr: string}},
  result: ForkResult,
  refuse: (code: number, m: string) => ForkResult,
): ForkResult {
  const {local, remote} = git;
  const target = realish(path.resolve(options.worktree ?? ''));
  result.dir = target;
  const common = local('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {cwd: repo.dir});
  if (common.status !== 0) return refuse(EXIT_REFUSED, `${repo.dir} is not a git checkout: ${out(common)}`);
  const base = realish(common.stdout.trim());
  return locked(local, repo.dir, `linked branch fork ${branch} --worktree`, options, refuse, () => {
    const fetch = remote(base, ['fetch', '--prune', '-q', 'origin']);
    if (fetch.status !== 0) return refuse(EXIT_NOT_FOUND, `git fetch failed in ${base}: ${out(fetch)}`);
    const onRemote = refExists(local, base, `refs/remotes/origin/${branch}`);
    // A worktree whose directory is gone (deleted without git) still holds its branch until pruned.
    local('git', ['worktree', 'prune'], {cwd: base});
    const all = worktreesOf(local, base);
    const here = all.find((wt) => realish(wt.path) === target);
    const head = () => local('git', ['rev-parse', 'HEAD'], {cwd: target}).stdout.trim();
    const push = (): ForkResult => {
      const r = remote(target, ['push', '-q', '--no-verify', '-u', 'origin', branch]);
      if (r.status !== 0) return refuse(EXIT_REFUSED, `git push origin ${branch} failed in ${target}: ${out(r)}`);
      result.pushed = true;
      result.messages.push(`${result.package}: pushed ${branch}`);
      return result;
    };
    /** Behind origin's branch and clean: fast-forward (a local branch can be older than origin's). */
    const catchUp = (): ForkResult | null => {
      if (!refExists(local, base, `refs/remotes/origin/${branch}`)) return null;
      const behind = local('git', ['rev-list', '--count', `HEAD..refs/remotes/origin/${branch}`], {cwd: target}).stdout.trim();
      if (behind === '0') return null;
      if (local('git', ['status', '--porcelain'], {cwd: target}).stdout.trim() !== '')
        return refuse(EXIT_REFUSED, `${target} is behind origin/${branch} and has uncommitted changes.`);
      const ff = local('git', ['merge', '--ff-only', '-q', `refs/remotes/origin/${branch}`], {cwd: target});
      if (ff.status !== 0) return refuse(EXIT_REFUSED, `${target} has diverged from origin/${branch}: ${out(ff)}`);
      result.messages.push(`${result.package}: ${target} fast-forwarded to origin/${branch}`);
      return null;
    };
    const pushIfAhead = (): ForkResult => {
      const stop = catchUp();
      if (stop) return stop;
      result.from = head();
      if (!refExists(local, base, `refs/remotes/origin/${branch}`)) return push();
      const ahead = local('git', ['rev-list', '--count', `refs/remotes/origin/${branch}..HEAD`], {cwd: target}).stdout.trim();
      return ahead === '0' ? result : push();
    };
    if (here) {
      if (here.branch !== branch)
        return refuse(EXIT_REFUSED, `${target} is a worktree of ${result.package} on ${here.branch ?? 'a detached HEAD'}, not ${branch}.`);
      result.messages.push(`${result.package}: ${target} is on ${branch} already`);
      return pushIfAhead();
    }
    if (fs.existsSync(target))
      return refuse(EXIT_REFUSED, `${target} exists and is not a worktree of ${result.package}'s base clone. Move it out of the way.`);
    const holder = all.find((wt) => wt.branch === branch);
    if (holder) {
      // A pinned app checkout's package worktree took the branch while it had no worktree of its
      // own: the branch's own worktree comes first, so that checkout lets go (detached at the same commit) when nothing
      // in it would be lost; its next `linked checkout` keeps it detached at origin/<branch>.
      const hold = (args: string[]) => local('git', args, {cwd: holder.path});
      const inAppCheckout =
        path.basename(path.dirname(holder.path)) === 'packages-local' && fs.existsSync(path.join(path.dirname(path.dirname(holder.path)), '.git'));
      const clean = inAppCheckout && fs.existsSync(holder.path) && hold(['status', '--porcelain']).stdout.trim() === '';
      const pushed = clean && hold(['for-each-ref', '--contains', 'HEAD', '--format=%(refname)', 'refs/remotes/origin']).stdout.trim() !== '';
      if (!pushed || hold(['checkout', '-q', '--detach']).status !== 0)
        return refuse(EXIT_REFUSED, `${branch} is checked out in ${holder.path} already (a branch can be in one worktree only).`);
      result.messages.push(`${result.package}: ${holder.path} let go of ${branch} (detached at the same commit)`);
    }
    fs.mkdirSync(path.dirname(target), {recursive: true});
    let args: string[];
    if (refExists(local, base, `refs/heads/${branch}`)) args = ['worktree', 'add', '-q', target, branch];
    else if (onRemote) args = ['worktree', 'add', '-q', '--track', '-b', branch, target, `origin/${branch}`];
    else {
      const from = options.from ?? 'origin/HEAD';
      const sha = local('git', ['rev-parse', '--verify', '--quiet', `${from}^{commit}`], {cwd: base});
      if (sha.status !== 0) return refuse(EXIT_USAGE, `--from ${from}: no such branch or commit in ${base}.`);
      args = ['worktree', 'add', '-q', '--no-track', '-b', branch, target, sha.stdout.trim()];
    }
    const add = local('git', args, {cwd: base});
    if (add.status !== 0) return refuse(EXIT_REFUSED, `git ${args.join(' ')} failed in ${base}: ${out(add)}`);
    result.messages.push(`${result.package}: ${target} on ${branch}${onRemote ? ` (origin's)` : ''}`);
    return pushIfAhead();
  });
}

export interface PushOptions {
  /** The app checkout; default the app root `cwd` is in. */
  dir?: string;
  /** Push only this worktree (on `<branch>`), not the repos of an app checkout. */
  worktree?: string;
  env?: NodeJS.ProcessEnv;
  /** How long to wait for another run's lock on a shared base clone. */
  lock?: RepoLockOptions;
}

export type PushRepoResult = 'pushed' | 'up-to-date' | 'refused';

export interface PushRepo {
  /** The package name, or the app's. */
  name: string;
  dir: string;
  /** Its origin, without userinfo. */
  repo: string;
  result: PushRepoResult;
  /** The branch tip: what origin has after the push. */
  sha: string;
}

export interface PushResult {
  code: number;
  branch: string;
  /** The app first, then the package checkouts on the branch. */
  repos: PushRepo[];
  messages: string[];
}

/**
 * Push `branch` in every repo of the app checkout that is on it: the app (which must be on it)
 * and each `packages-local/` checkout on it; detached fallbacks and checkouts on another branch
 * are left alone. Each is fetched first; a repo whose `origin/<branch>` is not an ancestor of its
 * head (diverged) is refused, never forced, and later repos still push. Uncommitted changes stay
 * where they are: only commits are pushed.
 */
export async function branchPush(
  appDir: string,
  branch: string,
  options: PushOptions = {},
  run?: Run,
): Promise<PushResult> {
  const env = options.env ?? process.env;
  const {local, remote} = commonSetup(run, appDir, env);
  const result: PushResult = {code: 0, branch, repos: [], messages: []};
  const refuse = (code: number, m: string): PushResult => ({
    ...result,
    code,
    messages: [...result.messages, m],
  });
  if (
    local('git', ['check-ref-format', '--branch', branch], {cwd: appDir})
      .status !== 0
  ) {
    return refuse(EXIT_USAGE, `"${branch}" is not a valid branch name.`);
  }
  let repos: Pick<RepoInfo, 'dir' | 'packageName' | 'head'>[];
  if (options.worktree !== undefined) {
    const dir = realish(path.resolve(options.worktree));
    const on = local('git', ['symbolic-ref', '--short', '-q', 'HEAD'], {cwd: dir});
    if (on.status !== 0 || on.stdout.trim() !== branch) {
      return refuse(EXIT_REFUSED, `${dir} is not a worktree on ${branch}.`);
    }
    let packageName: string | undefined;
    try {
      const name = (JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as {name?: unknown}).name;
      packageName = typeof name === 'string' ? name : undefined;
    } catch {
      packageName = undefined;
    }
    const head = local('git', ['rev-parse', 'HEAD'], {cwd: dir}).stdout.trim();
    repos = [{dir, head, ...(packageName ? {packageName} : {})}];
  } else {
    const all = await listRepos(appDir, local);
    const [app] = all;
    if (app.branch !== branch) {
      return refuse(
        EXIT_REFUSED,
        `${appDir} is on ${app.branch ?? 'a detached HEAD'}, not ${branch}.`,
      );
    }
    repos = all.filter((x) => x.branch === branch);
  }
  for (const r of repos) {
    // Each repo under its git dir's lock: a package's base clone is shared between app checkouts.
    const stop = locked(
      local,
      r.dir,
      `linked branch push ${branch}`,
      options,
      refuse,
      (): PushResult | null => {
        const entry: PushRepo = {
          name: r.packageName ?? path.basename(r.dir),
          dir: r.dir,
          repo: stripUserinfo(
            local('git', ['config', '--get', 'remote.origin.url'], {
              cwd: r.dir,
            }).stdout.trim(),
          ).url,
          result: 'up-to-date',
          sha: r.head,
        };
        result.repos.push(entry);
        const f = remote(r.dir, ['fetch', '--prune', '-q', 'origin']);
        if (f.status !== 0)
          return refuse(
            EXIT_NOT_FOUND,
            `git fetch failed in ${r.dir}: ${out(f)}`,
          );
        const originBranch = `refs/remotes/origin/${branch}`;
        if (refExists(local, r.dir, originBranch)) {
          const ahead = local(
            'git',
            ['rev-list', '--count', `${originBranch}..HEAD`],
            {cwd: r.dir},
          ).stdout.trim();
          if (ahead === '0') {
            // Nothing to push; origin may be ahead, which a merge's fast-forward takes.
            return null;
          }
          const diverged =
            local(
              'git',
              ['merge-base', '--is-ancestor', originBranch, 'HEAD'],
              {
                cwd: r.dir,
              },
            ).status !== 0;
          if (diverged) {
            entry.result = 'refused';
            result.code = EXIT_REFUSED;
            result.messages.push(
              `${entry.name}: ${branch} has diverged from origin/${branch}; nothing was pushed for it.`,
            );
            return null;
          }
        }
        const p = remote(r.dir, [
          'push',
          '-q',
          '--no-verify',
          '-u',
          'origin',
          branch,
        ]);
        if (p.status !== 0) {
          entry.result = 'refused';
          result.code = EXIT_REFUSED;
          result.messages.push(
            `${entry.name}: git push origin ${branch} was refused: ${out(p)}`,
          );
          return null;
        }
        entry.result = 'pushed';
        result.messages.push(`${entry.name}: pushed ${branch}`);
        return null;
      },
    );
    if (stop) return stop;
  }
  return result;
}

export type MergeMode = 'push' | 'update';

export interface MergeOptions {
  dir?: string;
  mode?: MergeMode;
  env?: NodeJS.ProcessEnv;
  /** How long to wait for another run's lock on a shared base clone. */
  lock?: RepoLockOptions;
}

export type MergeRepoResult =
  'merged' | 'up-to-date' | 'conflict' | 'push-refused' | 'skipped';

export interface MergeRepo {
  /** The package name, or the app's. */
  name: string;
  dir: string;
  /** Its origin, without userinfo: where a `--mode update` caller opens the PR. */
  repo: string;
  result: MergeRepoResult;
  /** The commit pushed: the merge commit, or the branch tip (`update`). */
  sha?: string;
  /** The conflicting files. */
  files?: string[];
  /** Whether `origin/<into>` contains `origin/<branch>` now: no PR needed. */
  landed: boolean;
}

export interface MergeResult {
  code: number;
  branch: string;
  into: string;
  mode: MergeMode;
  /** In merge order: packages by dependency, the app last. */
  repos: MergeRepo[];
  messages: string[];
}

/** Merge `branch` into `into` across the app checkout; see the module header. */
export async function branchMerge(
  appDir: string,
  branch: string,
  into: string,
  options: MergeOptions = {},
  run?: Run,
): Promise<MergeResult> {
  const env = options.env ?? process.env;
  const mode: MergeMode = options.mode ?? 'push';
  const {local, remote} = commonSetup(run, appDir, env);
  const result: MergeResult = {
    code: 0,
    branch,
    into,
    mode,
    repos: [],
    messages: [],
  };
  const refuse = (code: number, ...m: string[]): MergeResult => ({
    ...result,
    code,
    messages: [...result.messages, ...m],
  });
  if (mode !== 'push' && mode !== 'update')
    return refuse(EXIT_USAGE, `--mode is push or update, not ${String(mode)}.`);
  if (!into) return refuse(EXIT_USAGE, '--into <default branch> is required.');
  if (branch === into)
    return refuse(EXIT_USAGE, `"${branch}" is the branch it would merge into.`);
  for (const ref of [branch, into]) {
    if (
      local('git', ['check-ref-format', '--branch', ref], {cwd: appDir})
        .status !== 0
    ) {
      return refuse(EXIT_USAGE, `"${ref}" is not a valid branch name.`);
    }
  }

  const all = await listRepos(appDir, local);
  const [app] = all;
  if (app.branch !== branch) {
    return refuse(
      EXIT_REFUSED,
      `${appDir} is on ${app.branch ?? 'a detached HEAD'}, not ${branch}.`,
    );
  }
  const repos = all.filter((r) => r.branch === branch);
  const dirty = repos.filter((r) => r.dirty);
  if (dirty.length) {
    return refuse(
      EXIT_REFUSED,
      `Uncommitted or untracked changes in ${dirty.map((r) => r.dir).join(', ')}; nothing was merged.`,
    );
  }
  const problems: string[] = [];
  for (const r of repos) {
    const f = locked(
      local,
      r.dir,
      `linked branch merge ${branch}`,
      options,
      refuse,
      () => remote(r.dir, ['fetch', '--prune', '-q', 'origin']),
    );
    if ('code' in f) return f;
    if (f.status !== 0)
      return refuse(EXIT_NOT_FOUND, `git fetch failed in ${r.dir}: ${out(f)}`);
    if (!refExists(local, r.dir, `refs/remotes/origin/${into}`))
      problems.push(`${r.dir}: origin has no ${into}.`);
    else if (!refExists(local, r.dir, `refs/remotes/origin/${branch}`))
      problems.push(`${r.dir}: origin has no ${branch}: push it.`);
    else {
      const ahead = local(
        'git',
        ['rev-list', '--count', `refs/remotes/origin/${branch}..HEAD`],
        {cwd: r.dir},
      ).stdout.trim();
      if (ahead !== '0')
        problems.push(
          `${r.dir}: ${branch} has ${ahead} commit(s) origin lacks: push them.`,
        );
    }
  }
  if (problems.length)
    return refuse(EXIT_REFUSED, ...problems, 'Nothing was merged.');

  const nameOf = (r: RepoInfo) => r.packageName ?? path.basename(r.dir);
  const originOf = (r: RepoInfo) =>
    stripUserinfo(
      local('git', ['config', '--get', 'remote.origin.url'], {
        cwd: r.dir,
      }).stdout.trim(),
    ).url;
  const isAncestor = (dir: string, a: string, b: string) =>
    local('git', ['merge-base', '--is-ancestor', a, b], {cwd: dir}).status ===
    0;
  const ordered = dependencyOrder(repos);
  let stopped = false;
  for (const r of ordered) {
    const entry: MergeRepo = {
      name: nameOf(r),
      dir: r.dir,
      repo: originOf(r),
      result: 'skipped',
      landed: false,
    };
    result.repos.push(entry);
    const originBranch = `refs/remotes/origin/${branch}`;
    const originInto = `refs/remotes/origin/${into}`;
    entry.landed = isAncestor(r.dir, originBranch, originInto);
    if (stopped) continue;
    const step = locked(
      local,
      r.dir,
      `linked branch merge ${branch}`,
      options,
      (_c, m) => m,
      () =>
        mode === 'push' ? mergePush(r.dir, entry) : mergeUpdate(r.dir, entry),
    );
    if (step) {
      stopped = true;
      result.code = EXIT_REFUSED;
      result.messages.push(step);
    }
    entry.landed = isAncestor(r.dir, originBranch, originInto);
  }
  return result;

  /** `origin/<branch>` into `origin/<into>`, `--no-ff`, in a temporary worktree; push `<into>`. Returns why it stopped. */
  function mergePush(dir: string, entry: MergeRepo): string | null {
    if (
      isAncestor(
        dir,
        `refs/remotes/origin/${branch}`,
        `refs/remotes/origin/${into}`,
      )
    ) {
      entry.result = 'up-to-date';
      return null;
    }
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'linked-merge-'));
    fs.rmdirSync(tmp);
    const add = local(
      'git',
      ['worktree', 'add', '-q', '--detach', tmp, `refs/remotes/origin/${into}`],
      {cwd: dir},
    );
    if (add.status !== 0) {
      entry.result = 'conflict';
      return `${entry.name}: git worktree add failed: ${out(add)}`;
    }
    try {
      const m = local(
        'git',
        [
          'merge',
          '--no-ff',
          '-q',
          '-m',
          `Merge branch '${branch}' into ${into}`,
          `refs/remotes/origin/${branch}`,
        ],
        {cwd: tmp},
      );
      if (m.status !== 0) {
        entry.result = 'conflict';
        entry.files = local('git', ['diff', '--name-only', '--diff-filter=U'], {
          cwd: tmp,
        })
          .stdout.split('\n')
          .filter(Boolean);
        local('git', ['merge', '--abort'], {cwd: tmp});
        return `${entry.name}: merging ${branch} into ${into} conflicts in ${entry.files.join(', ') || '(no file named)'}: ${out(m)}. Later repos were skipped.`;
      }
      entry.sha = local('git', ['rev-parse', 'HEAD'], {cwd: tmp}).stdout.trim();
      const p = remote(tmp, [
        'push',
        '-q',
        '--no-verify',
        'origin',
        `HEAD:refs/heads/${into}`,
      ]);
      if (p.status !== 0) {
        entry.result = 'push-refused';
        return `${entry.name}: git push origin HEAD:${into} was refused: ${out(p)}. If ${into} is protected, use --mode update; if origin/${into} moved since the fetch, run this again. Later repos were skipped.`;
      }
      entry.result = 'merged';
      return null;
    } finally {
      local('git', ['worktree', 'remove', '--force', tmp], {cwd: dir});
      local('git', ['worktree', 'prune'], {cwd: dir});
    }
  }

  /** `origin/<into>` into `<branch>` in the checkout itself; push `<branch>`. Returns why it stopped. */
  function mergeUpdate(dir: string, entry: MergeRepo): string | null {
    const ff = local(
      'git',
      ['merge', '--ff-only', '-q', `refs/remotes/origin/${branch}`],
      {cwd: dir},
    );
    if (ff.status !== 0) {
      entry.result = 'conflict';
      return `${entry.name}: ${branch} could not fast-forward to origin/${branch}: ${out(ff)}`;
    }
    if (isAncestor(dir, `refs/remotes/origin/${into}`, 'HEAD')) {
      entry.result = 'up-to-date';
      entry.sha = local('git', ['rev-parse', 'HEAD'], {cwd: dir}).stdout.trim();
      return null;
    }
    const m = local(
      'git',
      [
        'merge',
        '--no-ff',
        '-q',
        '-m',
        `Merge branch '${into}' into ${branch}`,
        `refs/remotes/origin/${into}`,
      ],
      {cwd: dir},
    );
    if (m.status !== 0) {
      entry.result = 'conflict';
      entry.files = local('git', ['diff', '--name-only', '--diff-filter=U'], {
        cwd: dir,
      })
        .stdout.split('\n')
        .filter(Boolean);
      local('git', ['merge', '--abort'], {cwd: dir});
      return `${entry.name}: merging ${into} into ${branch} conflicts in ${entry.files.join(', ') || '(no file named)'}: ${out(m)}. Later repos were skipped.`;
    }
    entry.sha = local('git', ['rev-parse', 'HEAD'], {cwd: dir}).stdout.trim();
    const p = remote(dir, [
      'push',
      '-q',
      '--no-verify',
      'origin',
      `HEAD:refs/heads/${branch}`,
    ]);
    if (p.status !== 0) {
      entry.result = 'push-refused';
      return `${entry.name}: git push origin ${branch} was refused: ${out(p)}. Later repos were skipped.`;
    }
    entry.result = 'merged';
    return null;
  }
}

const resolveDir = (dir?: string): string =>
  findAppRoot(dir ? path.resolve(process.cwd(), dir) : process.cwd());

function print(
  json: boolean | undefined,
  result: {code: number; messages: string[]},
  text: () => string[],
): void {
  if (json) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  else {
    const write = result.code === 0 ? console.log : console.error;
    for (const m of text()) write(m);
  }
  process.exitCode = result.code;
}

/** The commander action for `branch fork`. */
export async function runBranchFork(
  branch: string,
  pkg: string,
  options: {dir?: string; worktree?: string; from?: string; json?: boolean},
): Promise<void> {
  const result = await branchFork(resolveDir(options.dir), branch, pkg, {
    ...(options.worktree !== undefined ? {worktree: path.resolve(options.worktree)} : {}),
    ...(options.from !== undefined ? {from: options.from} : {}),
  });
  print(options.json, result, () => result.messages);
}

/** The commander action for `branch push`. */
export async function runBranchPush(
  branch: string,
  options: {dir?: string; worktree?: string; json?: boolean},
): Promise<void> {
  // One worktree needs no app checkout around it.
  const result =
    options.worktree !== undefined
      ? await branchPush(path.resolve(options.worktree), branch, {worktree: path.resolve(options.worktree)})
      : await branchPush(resolveDir(options.dir), branch);
  print(options.json, result, () => [
    ...result.repos.map((r) => `${r.name}  ${r.result} ${r.sha.slice(0, 12)}`),
    ...result.messages,
  ]);
}

/** The commander action for `branch merge`. */
export async function runBranchMerge(
  branch: string,
  options: {into: string; dir?: string; mode?: string; json?: boolean},
): Promise<void> {
  const result = await branchMerge(
    resolveDir(options.dir),
    branch,
    options.into,
    {mode: options.mode as MergeMode | undefined},
  );
  print(options.json, result, () => [
    ...result.repos.map(
      (r) =>
        `${r.name}  ${r.result}${r.sha ? ` ${r.sha.slice(0, 12)}` : ''}${r.files?.length ? ` (${r.files.join(', ')})` : ''}`,
    ),
    ...result.messages,
  ]);
}
