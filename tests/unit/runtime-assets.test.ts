import fs from 'fs-extra';
import os from 'os';
import path from 'path';

jest.mock('ora', () => ({__esModule: true, default: () => ({})}));

import {
  copyRuntimeAssets,
  removeOldFiles,
} from '../../src/cli-methods.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'linked-assets-'));
});

afterEach(() => {
  fs.removeSync(dir);
});

test('copyRuntimeAssets puts CSS next to the compiled ESM output', async () => {
  const css = '.form { color: black; }\n';
  await fs.outputFile(path.join(dir, 'src/components/Form.module.css'), css);
  await fs.outputJson(path.join(dir, 'package.json'), {
    name: 'example',
    type: 'module',
    main: 'lib/esm/index.js',
  });

  expect(await copyRuntimeAssets(dir)).toBe(true);
  expect(
    await fs.readFile(
      path.join(dir, 'lib/esm/components/Form.module.css'),
      'utf8',
    ),
  ).toBe(css);
  expect(
    await fs.pathExists(path.join(dir, 'lib/cjs/components/Form.module.css')),
  ).toBe(false);
});

test('removeOldFiles keeps a source asset and deletes stale compiler output', async () => {
  const cssPath = path.join(dir, 'lib/esm/components/Form.module.css');
  const staleJs = path.join(dir, 'lib/esm/removed.js');
  await fs.outputFile(path.join(dir, 'src/components/Form.module.css'), '.a{}\n');
  await fs.outputFile(cssPath, '.a{}\n');
  await fs.outputFile(staleJs, 'export {}\n');
  const old = new Date(Date.now() - 10 * 60 * 1000);
  await fs.utimes(cssPath, old, old);
  await fs.utimes(staleJs, old, old);

  expect(await removeOldFiles(dir)).toBe(true);
  expect(await fs.pathExists(cssPath)).toBe(true);
  expect(await fs.pathExists(staleJs)).toBe(false);
});
