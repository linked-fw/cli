/**
 * The git hooks a clone that localizes gets, written into that clone's own
 * hooks directory -- nothing is committed, and a clone that never localizes
 * never runs them:
 *
 * - `post-merge`, `post-checkout`: `npm install` when the dependency
 *   manifests changed, which links the checkouts again on top of the new
 *   lockfile;
 * - `pre-commit`: refuse a `package.json` or `package-lock.json` that lists a
 *   checkout.
 *
 * Each is a few lines of `sh` that hand over to `hooks/git-hook.cjs` in the
 * installed cli. The app may sit below the git top level, so the hook records
 * the app's path inside the repository (`git rev-parse --show-prefix`) and
 * `cd`s there from the top level when it runs: moving the clone or
 * reinstalling the cli needs no rewrite, and a work tree without the cli (not
 * installed yet) skips the hook rather than blocking git. git starts a hook at
 * the top level and may export `GIT_DIR` and `GIT_INDEX_FILE` relative to it;
 * the hook makes them absolute, and pins `GIT_WORK_TREE` to the top level,
 * before it leaves.
 *
 * Where it writes nothing:
 *
 * - `core.hooksPath` is set (husky, a tracked hooks directory): that directory
 *   belongs to another tool or to the repository, so localize returns the
 *   one line to add to each hook there instead;
 * - outside a git work tree.
 *
 * In a linked worktree (`git worktree add`) the hooks directory is the main
 * repository's, so every worktree runs them; `git-hook.cjs` does nothing in a
 * work tree without checkouts, and localize says so once.
 *
 * A hook we wrote carries `HOOK_MARKER` and is rewritten on every run; any
 * other file in its place is the developer's and is left alone and reported.
 */
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const HOOK_MARKER = '# managed by linked localize';
export const GIT_HOOKS = ['post-merge', 'post-checkout', 'pre-commit'] as const;
export type GitHook = (typeof GIT_HOOKS)[number];

/** A hook localize could not write because `core.hooksPath` is set: add `line` to `file`. */
export interface ManualHook {
  hook: GitHook;
  /** The hook file to edit, as the developer would name it (`.husky/post-merge`). */
  file: string;
  line: string;
}

export interface HookInstall {
  written: string[];
  /** Hook files that are not ours, left alone. */
  skipped: string[];
  /** `core.hooksPath` is set: nothing was written; one line per hook to add by hand. */
  manual: ManualHook[];
  /** The value of `core.hooksPath`, when set. */
  hooksPath: string | null;
  /** A linked worktree: the hooks live in the main repository and run in every worktree. */
  sharedWithWorktrees: boolean;
}

/** `s` as one single-quoted `sh` word: survives spaces, `$`, quotes and backticks. */
function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * The commands that run `git-hook.cjs` for `hook` from the app at `prefix`
 * (relative to the git top level, `/`-terminated or empty). Each is one `sh`
 * command, so they can be lines of a file or `; `-joined in a subshell.
 */
function hookCommands(hook: GitHook, prefix: string): string[] {
  const dir = prefix
    ? `dir="$(git rev-parse --show-toplevel)"/${shQuote(prefix.replace(/\/$/, ''))}`
    : 'dir="$(git rev-parse --show-toplevel)"';
  return [
    dir,
    'script="$dir/node_modules/@_linked/cli/hooks/git-hook.cjs"',
    '{ [ -f "$script" ] && command -v node >/dev/null 2>&1; } || exit 0',
    // git starts a hook at the top level. With GIT_DIR set, git takes the
    // current directory for the top level unless GIT_WORK_TREE says otherwise,
    // and a relative path is relative to here: both stop holding after the cd.
    '[ -z "${GIT_DIR-}" ] || [ -n "${GIT_WORK_TREE-}" ] || export GIT_WORK_TREE="$PWD"',
    'for v in GIT_DIR GIT_INDEX_FILE GIT_WORK_TREE; do eval "p=\\${$v-}"; case "$p" in ""|/*) ;; *) export "$v=$PWD/$p" ;; esac; done',
    'cd "$dir" || exit 0',
    `exec node "$script" ${hook} "$@"`,
  ];
}

/** The hook file for `hook`: marker, then a hand-over that resolves the cli at run time. */
export function hookScript(hook: GitHook, prefix = ''): string {
  return [
    '#!/bin/sh',
    HOOK_MARKER,
    '# Runs @_linked/cli/hooks/git-hook.cjs from the app directory; does nothing without it.',
    ...hookCommands(hook, prefix),
    '',
  ].join('\n');
}

/** The same hand-over as one line, in a subshell, for a hook file another tool owns. */
export function hookLine(hook: GitHook, prefix = ''): string {
  return `(${hookCommands(hook, prefix).join('; ')})`;
}

/** husky (v9) points `core.hooksPath` at `.husky/_` and runs the scripts in `.husky/`. */
function manualHookFile(hooksPath: string, hook: GitHook): string {
  const p = hooksPath.replace(/\/+$/, '');
  const dir = /(^|\/)\.husky\/_$/.test(p) ? p.slice(0, -2) : p;
  return `${dir}/${hook}`;
}

function git(appRoot: string, ...args: string[]): string | null {
  const r = spawnSync('git', args, {cwd: appRoot, encoding: 'utf8'});
  return r.status === 0 ? (r.stdout ?? '').trim() : null;
}

/**
 * Write the three hooks into the repository's hooks directory, as git
 * resolves it (`--git-path hooks`; the common directory for a linked
 * worktree). With `core.hooksPath` set, write nothing and return the lines to
 * add. Not a git work tree: nothing at all.
 */
export function installGitHooks(appRoot: string): HookInstall {
  const result: HookInstall = {
    written: [],
    skipped: [],
    manual: [],
    hooksPath: null,
    sharedWithWorktrees: false,
  };
  const hooksDir = git(appRoot, 'rev-parse', '--git-path', 'hooks');
  const prefix = git(appRoot, 'rev-parse', '--show-prefix');
  if (!hooksDir || prefix === null) return result;

  const gitDir = git(appRoot, 'rev-parse', '--git-dir');
  const commonDir = git(appRoot, 'rev-parse', '--git-common-dir');
  result.sharedWithWorktrees =
    gitDir !== null &&
    commonDir !== null &&
    realpath(path.resolve(appRoot, gitDir)) !==
      realpath(path.resolve(appRoot, commonDir));

  const hooksPath = git(appRoot, 'config', 'core.hooksPath');
  if (hooksPath) {
    result.hooksPath = hooksPath;
    result.manual = GIT_HOOKS.map((hook) => ({
      hook,
      file: manualHookFile(hooksPath, hook),
      line: hookLine(hook, prefix),
    }));
    return result;
  }

  const dir = path.resolve(appRoot, hooksDir);
  fs.mkdirSync(dir, {recursive: true});
  for (const hook of GIT_HOOKS) {
    const file = path.join(dir, hook);
    let existing: string | null = null;
    try {
      existing = fs.readFileSync(file, 'utf8');
    } catch {
      /* not there yet */
    }
    if (existing !== null && !existing.includes(HOOK_MARKER)) {
      result.skipped.push(file);
      continue;
    }
    fs.writeFileSync(file, hookScript(hook, prefix));
    // writeFileSync's `mode` applies only to a new file.
    fs.chmodSync(file, 0o755);
    result.written.push(file);
  }
  return result;
}

function realpath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}
