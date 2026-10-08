/**
 * Test helpers.
 *
 * `makeConsumer` builds a throwaway consumer root with a real filesystem --
 * never a mocked one. The whole tool is about what `node_modules/<name>`
 * actually is, and asserting against a model of symlinks rather than against
 * symlinks would prove nothing.
 *
 * `stubbed` replaces the subprocess runner and records every invocation, which
 * is how the recursion guard is asserted: no npm, on any code path. The
 * real-localize test deliberately does NOT use it.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {makeRun} from '../../../src/localize/run.js';

type Cleanup = () => void;
export interface TestContext {
  after: (fn: Cleanup) => void;
}

export function test(
  name: string,
  body: (t: TestContext) => void | Promise<void>,
  timeout?: number,
): void {
  globalThis.test(
    name,
    async () => {
      const cleanups: Cleanup[] = [];
      try {
        await body({after: (fn) => cleanups.push(fn)});
      } finally {
        for (const fn of cleanups.reverse()) fn();
      }
    },
    timeout,
  );
}

export function tmpdir(prefix = 'localize-') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

export function makeConsumer({pkg} = {}) {
  const appRoot = tmpdir('localize-consumer-');
  fs.mkdirSync(path.join(appRoot, 'node_modules'), {recursive: true});
  fs.writeFileSync(
    path.join(appRoot, 'package.json'),
    JSON.stringify(
      {name: 'consumer', version: '1.0.0', private: true, ...pkg},
      null,
      2,
    ) + '\n',
  );
  return appRoot;
}

/**
 * The environment for a real `npm` in a test: the developer's own npm
 * settings stay out. Run as `npm run test:unit`, npm hands its children its
 * whole configuration as `npm_config_*` (registry, cache, `install-links`,
 * `legacy-peer-deps`, …), and the user's `~/.npmrc` would apply on top -- so
 * the same test could install differently on two machines. Every
 * `npm_config_*` is dropped and the user config is pointed at /dev/null.
 */
export function scrubbedNpmEnv(
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (/^npm_config_/i.test(key)) continue;
    env[key] = value;
  }
  env.npm_config_userconfig = '/dev/null';
  return env;
}

/** Deps with a REAL subprocess runner, in a scrubbed npm environment. Used by the real-localize test. */
export function realDeps(appRoot) {
  const logs = [];
  const warns = [];
  const errors = [];
  const env = scrubbedNpmEnv();
  const run = makeRun(appRoot);
  return {
    appRoot,
    run: (cmd, args, opts = {}) =>
      run(cmd, args, {...opts, env: opts.env ?? env}),
    log: (m) => logs.push(m),
    warn: (m) => warns.push(m),
    error: (m) => errors.push(m),
    logs,
    warns,
    errors,
    output: () => [...logs, ...warns, ...errors].join('\n'),
  };
}

/** Deps whose subprocesses are stubbed and recorded. */
export function stubbed(appRoot, handler) {
  const calls = [];
  const logs = [];
  const warns = [];
  const errors = [];
  return {
    appRoot,
    calls,
    logs,
    warns,
    errors,
    output: () => [...logs, ...warns, ...errors].join('\n'),
    npmCalls: () => calls.filter((c) => /(^|[/\\])npm(\.cmd)?$/.test(c.cmd)),
    run: (cmd, args, opts = {}) => {
      const inv = {cmd, args, cwd: opts.cwd};
      calls.push(inv);
      return handler?.(inv) ?? {status: 0, stdout: '', stderr: ''};
    },
    log: (m) => logs.push(m),
    warn: (m) => warns.push(m),
    error: (m) => errors.push(m),
  };
}

export const ok = (stdout = '') => ({status: 0, stdout, stderr: ''});
export const fail = (stderr = 'boom', status = 1) => ({
  status,
  stdout: '',
  stderr,
});

export function rm(dir) {
  fs.rmSync(dir, {recursive: true, force: true});
}
