import fs from 'fs';
import os from 'os';
import path from 'path';
import {createViteConfig} from '../../src/vite-config';

// A worktree that symlinks the main checkout's node_modules must not share
// Vite's default cache (node_modules/.vite) with the main checkout's server.

describe('Vite cacheDir', () => {
  let tmp: string;
  const cwd = process.cwd();

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'linked-cachedir-')));
  });
  afterEach(() => {
    process.chdir(cwd);
    fs.rmSync(tmp, {recursive: true, force: true});
  });

  async function configFor(app: string) {
    fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({name: 'app'}));
    process.chdir(app);
    return (createViteConfig() as any)({command: 'serve', mode: 'development'});
  }

  it('symlinked node_modules → cacheDir under the app root', async () => {
    const app = path.join(tmp, 'wt');
    const main = path.join(tmp, 'main');
    fs.mkdirSync(path.join(main, 'node_modules'), {recursive: true});
    fs.mkdirSync(app);
    fs.symlinkSync(path.join(main, 'node_modules'), path.join(app, 'node_modules'), 'dir');
    const config = await configFor(app);
    expect(config.cacheDir).toBe(path.join(app, '.vite-cache'));
  });

  it('real node_modules → default cacheDir', async () => {
    const app = path.join(tmp, 'main');
    fs.mkdirSync(path.join(app, 'node_modules'), {recursive: true});
    const config = await configFor(app);
    expect(config.cacheDir).toBeUndefined();
  });
});
