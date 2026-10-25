import fs from 'fs';
import os from 'os';
import path from 'path';
import {createViteConfig, viteCacheDir} from '../../src/vite-config';

// A git worktree shares the main checkout's install through a symlinked
// node_modules. Vite's default cache (`node_modules/.vite`) would then be the
// main checkout's, so the worktree gets its own.
describe('Vite cacheDir', () => {
  const made: string[] = [];
  const tempRoot = (prefix: string) => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
    made.push(dir);
    return dir;
  };
  afterAll(() => {
    for (const dir of made) fs.rmSync(dir, {recursive: true, force: true});
  });

  async function configIn(appRoot: string): Promise<any> {
    const cwd = process.cwd();
    process.chdir(appRoot);
    try {
      return await (createViteConfig({port: 4999}) as any)({mode: 'production', command: 'build'});
    } finally {
      process.chdir(cwd);
    }
  }

  it('symlinked node_modules → cacheDir under the app root', async () => {
    const main = tempRoot('vite-cache-main-');
    fs.mkdirSync(path.join(main, 'node_modules'));
    const app = tempRoot('vite-cache-wt-');
    fs.symlinkSync(path.join(main, 'node_modules'), path.join(app, 'node_modules'));

    const config = await configIn(app);
    expect(config.cacheDir).toBe(path.join(app, '.vite-cache'));
    expect(viteCacheDir(app)).toBe(path.join(app, '.vite-cache'));
  });

  it('node_modules link farm → cacheDir under the app root', () => {
    const main = tempRoot('vite-cache-main-');
    fs.mkdirSync(path.join(main, 'node_modules'));
    const app = tempRoot('vite-cache-farm-');
    fs.mkdirSync(path.join(app, 'node_modules'));
    fs.writeFileSync(
      path.join(app, 'node_modules', '.linked-worktree.json'),
      JSON.stringify({installRoot: main, overlays: {}}),
    );
    expect(viteCacheDir(app)).toBe(path.join(app, '.vite-cache'));
  });

  it('real node_modules → default cacheDir', async () => {
    const app = tempRoot('vite-cache-app-');
    fs.mkdirSync(path.join(app, 'node_modules'));

    const config = await configIn(app);
    expect(config.cacheDir).toBeUndefined();
  });

  it('no node_modules → default cacheDir', () => {
    expect(viteCacheDir(tempRoot('vite-cache-none-'))).toBeUndefined();
  });
});
