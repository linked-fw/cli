// `linked start` keeps one Vite dev server for the life of the process: a
// `.env` change must not restart it. A restart closes the SSR module runner the
// backend was loaded by, so every later `import()` in it failed — `POST
// /admin/sync-shapes` answered "Vite module runner has been closed." until the
// app was restarted.
import {execFileSync} from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {isDevServerRestartTrigger} from '../../src/plugins/keep-dev-server-alive';

const RUN = path.join(__dirname, '..', 'fixtures', 'dev-server-restart', 'run.mjs');

type Outcome = {
  lazyImport: {ok: boolean; value?: number; error?: string};
  sameInstance: boolean;
  warnings: string[];
};

describe('keepDevServerAlive with a real Vite server', () => {
  let root: string;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'linked-restart-')));
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({name: 'probe', private: true}));
    fs.writeFileSync(path.join(root, '.env'), 'A=1\n');
    fs.writeFileSync(
      path.join(root, 'lazy.js'),
      "export const instance = {};\nexport const later = () => import('./later.js');\n",
    );
    fs.writeFileSync(path.join(root, 'later.js'), 'export const value = 42;\n');
  });

  afterEach(() => {
    fs.rmSync(root, {recursive: true, force: true});
  });

  function run(mode: 'plugin' | 'stock' | 'restart'): Outcome {
    const out = execFileSync(process.execPath, [RUN, root, mode], {
      cwd: path.join(__dirname, '..', '..'),
      encoding: 'utf8',
    });
    return JSON.parse(out);
  }

  test('after a .env change, a module loaded before still imports, from the same runner', () => {
    const outcome = run('plugin');
    expect(outcome.lazyImport).toEqual({ok: true, value: 42});
    expect(outcome.sameInstance).toBe(true);
    expect(outcome.warnings).toEqual([]);
  }, 60_000);

  test('without it, the same change closes the runner the module was loaded by', () => {
    // The failure the plugin prevents, so this suite notices if it comes back.
    const outcome = run('stock');
    expect(outcome.lazyImport.ok).toBe(false);
    expect(outcome.lazyImport.error).toMatch(/module runner has been closed/);
    // And a module loaded again is a second copy, not the one already in use.
    expect(outcome.sameInstance).toBe(false);
  }, 60_000);

  test('a restart that happens anyway says the process must be restarted', () => {
    const outcome = run('restart');
    expect(outcome.warnings).toHaveLength(1);
    expect(outcome.warnings[0]).toMatch(/Restart `linked start`/);
  }, 60_000);
});

describe('isDevServerRestartTrigger', () => {
  const config = {envDir: '/app', configFile: '/app/vite.config.ts'};

  test.each(['/app/.env', '/app/.env.local', '/app/.env.development', '/app/.env.production.local'])(
    '%s is an env file',
    (file) => {
      expect(isDevServerRestartTrigger(file, config)).toBe(true);
    },
  );

  test('the loaded config file is one', () => {
    expect(isDevServerRestartTrigger('/app/vite.config.ts', config)).toBe(true);
  });

  test.each(['/app/src/.env', '/app/src/App.tsx', '/app/.envrc', '/app/env.ts', '/app'])(
    '%s is not',
    (file) => {
      expect(isDevServerRestartTrigger(file, config)).toBe(false);
    },
  );

  test('with env files off, only the config file is', () => {
    expect(isDevServerRestartTrigger('/app/.env', {envDir: false})).toBe(false);
    expect(isDevServerRestartTrigger('/app/vite.config.ts', {envDir: false, ...config})).toBe(true);
  });
});
