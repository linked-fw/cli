/**
 * Credentials for the git calls that reach a remote, through the environment only.
 *
 * A caller that needs a token (CN, with a short-lived GitHub App installation token) puts it in
 * `LINKED_GIT_TOKEN`; the cli never takes it on the command line and never writes it anywhere.
 * Every `git clone | fetch | push | ls-remote` the cli runs gets `remoteEnv(env)`:
 *
 * - `GIT_ASKPASS` -> `hooks/git-askpass.cjs`, which answers git's `Username` prompt with
 *   `x-access-token` (or `LINKED_GIT_USERNAME`) and its `Password` prompt with the token;
 * - `GIT_TERMINAL_PROMPT=0`, so a missing or wrong token fails instead of waiting for a terminal;
 * - an empty `credential.helper`, through `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_n` /
 *   `GIT_CONFIG_VALUE_n` (not `-c`, which shows in `ps`), so a keychain helper never stores the
 *   token askpass supplied;
 * - `core.hooksPath` pointed at an empty directory (and `--no-verify` on every push), so no git
 *   hook -- `pre-push`, `reference-transaction`, a husky hook the app's `prepare` registered --
 *   runs while the token is in the environment.
 *
 * Every other subprocess -- local git, `npm install`, builds -- gets `localEnv(env)`: the token
 * removed, so a git hook or an npm lifecycle script never sees it. URLs are stripped of userinfo
 * before they reach git (a URL with a token in it would land in `.git/config`), and git's error
 * text is scrubbed of the token before it is printed.
 *
 * Without `LINKED_GIT_TOKEN` nothing is added: the developer's own git credentials apply.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {hookPath} from '../localize/hook-module.js';

/** The variable a caller puts the token in. */
export const TOKEN_VAR = 'LINKED_GIT_TOKEN';
/** The username askpass answers with; GitHub App installation tokens use `x-access-token`. */
export const USERNAME_VAR = 'LINKED_GIT_USERNAME';

/** `url` without `user[:password]@`; `stripped` says whether there was any. */
export function stripUserinfo(url: string): {url: string; stripped: boolean} {
  const m = /^([a-z][a-z0-9+.-]*:\/\/)([^/@]*@)(.*)$/i.exec(url.trim());
  if (!m) return {url: url.trim(), stripped: false};
  return {url: m[1] + m[3], stripped: true};
}

/** The askpass program for this platform: the `.cjs` itself, or its `.cmd` twin on Windows. */
export function askpassProgram(): string {
  if (process.platform === 'win32') return hookPath('git-askpass.cmd');
  const file = hookPath('git-askpass.cjs');
  // npm keeps the mode it packed; a copy that lost it would make git skip askpass silently.
  try {
    fs.accessSync(file, fs.constants.X_OK);
  } catch {
    try {
      fs.chmodSync(file, 0o755);
    } catch {
      /* read-only install: git reports the failed prompt */
    }
  }
  return file;
}

/** An empty directory for `core.hooksPath`: git then finds no hook to run. */
function noHooksDir(): string {
  if (process.platform !== 'win32') return '/dev/null';
  const dir = path.join(os.tmpdir(), 'linked-no-git-hooks');
  fs.mkdirSync(dir, {recursive: true});
  return dir;
}

/**
 * The variables a remote git call adds when `LINKED_GIT_TOKEN` is set; empty otherwise. An
 * existing `GIT_CONFIG_COUNT` is extended, not replaced.
 */
export function gitRemoteEnv(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  if (!env[TOKEN_VAR]) return {};
  const count = Number.parseInt(env.GIT_CONFIG_COUNT ?? '0', 10);
  const n = Number.isInteger(count) && count > 0 ? count : 0;
  return {
    GIT_ASKPASS: askpassProgram(),
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: String(n + 2),
    [`GIT_CONFIG_KEY_${n}`]: 'credential.helper',
    [`GIT_CONFIG_VALUE_${n}`]: '',
    [`GIT_CONFIG_KEY_${n + 1}`]: 'core.hooksPath',
    [`GIT_CONFIG_VALUE_${n + 1}`]: noHooksDir(),
  };
}

/** The environment for a git call that reaches a remote. */
export function remoteEnv(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {...env, ...gitRemoteEnv(env)};
}

/** The environment for everything else: the token and its username removed. */
export function localEnv(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const out = {...env};
  delete out[TOKEN_VAR];
  delete out[USERNAME_VAR];
  return out;
}

/** `text` with the token (when set) replaced by `***`, and userinfo removed from any URL in it. */
export function scrubSecret(
  text: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const token = env[TOKEN_VAR];
  let out = token ? text.split(token).join('***') : text;
  out = out.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]*@/gi, '$1');
  return out;
}

/** A `Run` for one command line: `cmd`, `args`, options. */
type RunLike = (
  cmd: string,
  args: string[],
  opts?: {cwd?: string; env?: NodeJS.ProcessEnv; shell?: boolean},
) => {status: number; stdout: string; stderr: string};

/**
 * The two ways the cli runs a subprocess once a token may be in `env`: `local` (git, npm,
 * builds) without the token, `remote` (clone, fetch, push, ls-remote) with the askpass
 * environment and its error text scrubbed.
 */
export function gitRunners<R extends RunLike>(
  run: R,
  env: NodeJS.ProcessEnv = process.env,
): {local: R; remote: (cwd: string, args: string[]) => ReturnType<R>} {
  const local = ((cmd, args, opts = {}) =>
    run(cmd, args, {...opts, env: opts.env ?? localEnv(env)})) as R;
  const remote = (cwd: string, args: string[]) => {
    const r = run('git', args, {cwd, env: remoteEnv(env)});
    return {
      ...r,
      stderr: scrubSecret(r.stderr, env),
      stdout: scrubSecret(r.stdout, env),
    } as ReturnType<R>;
  };
  return {local, remote};
}
