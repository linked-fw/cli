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
 * installed cli. The path is found when the hook runs, from the work tree's
 * top level, so moving the clone or reinstalling the cli needs no rewrite, and
 * a work tree without the cli (not installed yet) skips the hook rather than
 * blocking git.
 *
 * A hook we wrote carries `HOOK_MARKER` and is rewritten on every run; any
 * other file in its place is the developer's and is left alone and reported.
 */
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const HOOK_MARKER = '# managed by linked localize';
export const GIT_HOOKS = ['post-merge', 'post-checkout', 'pre-commit'] as const;

/** The hook file for `hook`: marker, then a hand-over that resolves the cli at run time. */
export function hookScript(hook: string): string {
  return [
    '#!/bin/sh',
    HOOK_MARKER,
    '# Runs @_linked/cli/hooks/git-hook.cjs from this work tree; does nothing without it.',
    'script="$(git rev-parse --show-toplevel)/node_modules/@_linked/cli/hooks/git-hook.cjs"',
    '[ -f "$script" ] && command -v node >/dev/null 2>&1 || exit 0',
    `exec node "$script" ${hook} "$@"`,
    '',
  ].join('\n');
}

/**
 * Write the three hooks into the repository's hooks directory -- as git
 * resolves it, so a linked work tree and `core.hooksPath` get them where git
 * looks. Not a git work tree: nothing written, nothing skipped.
 */
export function installGitHooks(appRoot: string): {
  written: string[];
  skipped: string[];
} {
  const written: string[] = [];
  const skipped: string[] = [];
  const r = spawnSync('git', ['rev-parse', '--git-path', 'hooks'], {
    cwd: appRoot,
    encoding: 'utf8',
  });
  const out = r.status === 0 ? (r.stdout ?? '').trim() : '';
  if (!out) return {written, skipped};
  const dir = path.resolve(appRoot, out);
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
      skipped.push(file);
      continue;
    }
    fs.writeFileSync(file, hookScript(hook));
    // writeFileSync's `mode` applies only to a new file.
    fs.chmodSync(file, 0o755);
    written.push(file);
  }
  return {written, skipped};
}
