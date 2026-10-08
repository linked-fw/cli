import {spawnSync} from 'node:child_process';
import process from 'node:process';

/**
 * The single seam through which localize reaches the outside world.
 *
 * Every subprocess -- `git`, `npm`, a configured build command -- goes through
 * the `run` function on the deps object. Tests may replace it, but note that
 * the real-localize test deliberately does NOT: a stubbed runner cannot show
 * that `npm install` ran in the right directory, which is the one property
 * this tool has to get right.
 */
export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  shell?: boolean;
}

export interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

export type Run = (cmd: string, args: string[], opts?: RunOptions) => RunResult;

/**
 * Everything localize needs from the outside world. A public contract: callers
 * pass their own to point localize at another root or capture its output.
 */
export interface Deps {
  appRoot: string;
  run: Run;
  log: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}

export function makeRun(defaultCwd: string): Run {
  return function run(cmd, args, opts: RunOptions = {}) {
    const r = spawnSync(cmd, args, {
      cwd: opts.cwd ?? defaultCwd,
      encoding: 'utf8',
      env: opts.env ?? process.env,
      shell: opts.shell ?? false,
      maxBuffer: 64 * 1024 * 1024,
    });
    return {
      status: r.status === null ? 1 : r.status,
      stdout: r.stdout ?? '',
      stderr: r.stderr ?? (r.error ? String(r.error.message) : ''),
    };
  };
}

/** Build the default dependency bundle for a consumer root. */
export function defaultDeps(appRoot: string = process.cwd()): Deps {
  return {
    appRoot,
    run: makeRun(appRoot),
    log: (m) => console.log(m),
    warn: (m) => console.warn(m),
    error: (m) => console.error(m),
  };
}
