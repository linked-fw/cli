// The `linked build` step that copies what tsc does not emit (JSON, declarations, CSS,
// SCSS) from src/ into lib/esm, and into lib/cjs when the package publishes CommonJS.
import fs from 'fs-extra';
import os from 'os';
import path from 'path';

// ora is ESM-only, which Jest's CommonJS loader cannot require.
jest.mock('ora', () => ({__esModule: true, default: () => ({})}));

import {planBuildSteps, removeOldFiles} from '../../src/cli-methods.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'linked-assets-'));
});

afterEach(() => {
  fs.removeSync(dir);
});

const write = (file: string, content = '') =>
  fs.outputFileSync(path.join(dir, file), content);

const copyStep = (pkgJson: object) => {
  write('package.json', JSON.stringify(pkgJson));
  const step = planBuildSteps(pkgJson, dir).find(
    (s) => s.name === 'Copying files to lib folder',
  );
  if (!step) throw new Error('no copy step');
  return step;
};

test('copies nested assets into lib/esm at the same relative path', async () => {
  write('src/index.ts', 'export {};\n');
  write('src/styles/theme.css', 'a{}');
  write('src/data/terms.json', '{}');
  write('src/types/extra.d.ts', 'export {};\n');
  write('src/deep/nested/vars.scss', '$a: 1;');
  write('src/data/terms.ttl', '<https://example.test/ont/terms/> a <http://www.w3.org/2002/07/owl#Ontology> .\n');

  const ok = await copyStep({name: 'p', type: 'module'}).apply();

  expect(ok).toBe(true);
  for (const f of [
    'styles/theme.css',
    'data/terms.json',
    'data/terms.ttl',
    'types/extra.d.ts',
    'deep/nested/vars.scss',
  ]) {
    expect(fs.existsSync(path.join(dir, 'lib/esm', f))).toBe(true);
  }
  expect(fs.existsSync(path.join(dir, 'lib/esm/index.ts'))).toBe(false);
  expect(fs.existsSync(path.join(dir, 'lib/cjs'))).toBe(false);
});

test('mirrors into lib/cjs when the package publishes CommonJS', async () => {
  write('src/theme.css', 'a{}');
  write('src/data/terms.ttl', '');

  const ok = await copyStep({
    name: 'p',
    exports: {
      '.': {import: './lib/esm/index.js', require: './lib/cjs/index.js'},
    },
  }).apply();

  expect(ok).toBe(true);
  expect(fs.existsSync(path.join(dir, 'lib/esm/theme.css'))).toBe(true);
  expect(fs.existsSync(path.join(dir, 'lib/cjs/theme.css'))).toBe(true);
  expect(fs.existsSync(path.join(dir, 'lib/cjs/data/terms.ttl'))).toBe(true);
});

test('a package without src assets copies nothing and succeeds', async () => {
  write('src/index.ts', 'export {};\n');
  expect(await copyStep({name: 'p', type: 'module'}).apply()).toBe(true);
});

test('stale-output cleanup keeps freshly copied assets', async () => {
  write('src/theme.css', 'a{}');
  await copyStep({name: 'p', type: 'module'}).apply();

  await removeOldFiles(dir);

  expect(fs.existsSync(path.join(dir, 'lib/esm/theme.css'))).toBe(true);
});
