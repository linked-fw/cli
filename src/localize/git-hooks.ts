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
 * Each is a few lines of `sh` (from `hooks/hook-shim.cjs`) that hand over to
 * `hooks/git-hook.cjs` in the installed cli. The app may sit below the git
 * top level, so the hook records the app's path inside the repository (`git rev-parse --show-prefix`) and
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

import {samePath} from '../utils/platform.js';
import {requireHook} from './hook-module.js';

// The same text as in hooks/hook-shim.cjs; loading that module checks it.
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

interface HookShimModule {
  HOOK_MARKER: string;
  hookCommands: (hook: GitHook, prefix: string) => string[];
  hookLine: (hook: GitHook, prefix: string) => string;
}

let shim: HookShimModule | undefined;

/**
 * `hooks/hook-shim.cjs`: the hand-over the hook files run, shared with
 * lock-at-rest, which prints it for a hook file that is not ours.
 */
function shimModule(): HookShimModule {
  shim ??= requireHook<HookShimModule>(
    'hook-shim.cjs',
    (mod) =>
      mod.HOOK_MARKER === HOOK_MARKER &&
      typeof mod.hookCommands === 'function' &&
      typeof mod.hookLine === 'function',
  );
  return shim;
}

/** The hook file for `hook`: marker, then a hand-over that resolves the cli at run time. */
export function hookScript(hook: GitHook, prefix = ''): string {
  return [
    '#!/bin/sh',
    HOOK_MARKER,
    '# Runs @_linked/cli/hooks/git-hook.cjs from the app directory; does nothing without it.',
    ...shimModule().hookCommands(hook, prefix),
    '',
  ].join('\n');
}

/** The same hand-over as one line, in a subshell, for a hook file another tool owns. */
export function hookLine(hook: GitHook, prefix = ''): string {
  return shimModule().hookLine(hook, prefix);
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
    !samePath(
      realpath(path.resolve(appRoot, gitDir)),
      realpath(path.resolve(appRoot, commonDir)),
    );

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
    // LF even on Windows: Git for Windows runs hooks with its own sh.
    fs.writeFileSync(file, hookScript(hook, prefix));
    // writeFileSync's `mode` applies only to a new file. (A no-op on Windows,
    // where git runs a hook file whatever its mode.)
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
