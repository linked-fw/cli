// Guards the CLI tarball against nested ignore files under defaults/. npm
// honours a nested .npmignore (and strips .gitignore) when packing the CLI, which
// silently dropped defaults/package/src from the published package.
import fs from 'fs';
import os from 'os';
import path from 'path';
import {glob} from 'glob';
import {renameShippedDotfiles} from '../../src/utils/shippedDotfiles.js';

const repoRoot = path.resolve(__dirname, '..', '..');

describe('packaging', () => {
  test('defaults ships no nested ignore files', async () => {
    const found = await glob('defaults/**/{.npmignore,.gitignore}', {
      cwd: repoRoot,
      dot: true,
      ignore: '**/node_modules/**',
    });
    expect(found).toEqual([]);
  });

  test('react-native template ships no dotfiles or dot-directories', async () => {
    const found = await glob('defaults/app-react-native/**/.*', {
      cwd: repoRoot,
      dot: true,
      ignore: '**/node_modules/**',
    });
    expect(found).toEqual([]);
  });

  test('renames nested dotfiles', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'linked-cli-dotfiles-'));
    try {
      fs.mkdirSync(path.join(tmp, 'services', 'api'), {recursive: true});
      fs.writeFileSync(path.join(tmp, 'services', 'api', 'env.example.template'), 'PORT=4000\n');
      fs.writeFileSync(path.join(tmp, 'services', 'gitignore.template'), 'lib/\n');
      fs.mkdirSync(path.join(tmp, 'node_modules', 'x'), {recursive: true});
      fs.writeFileSync(path.join(tmp, 'node_modules', 'x', 'gitignore.template'), '');

      renameShippedDotfiles(tmp);

      expect(fs.readFileSync(path.join(tmp, 'services', 'api', '.env.example'), 'utf8')).toBe(
        'PORT=4000\n',
      );
      expect(fs.existsSync(path.join(tmp, 'services', '.gitignore'))).toBe(true);
      // node_modules is never touched.
      expect(fs.existsSync(path.join(tmp, 'node_modules', 'x', 'gitignore.template'))).toBe(true);
    } finally {
      fs.rmSync(tmp, {recursive: true, force: true});
    }
  });

  test('createPackage renames npmignore.template', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'linked-cli-package-'));
    try {
      fs.cpSync(path.join(repoRoot, 'defaults', 'package'), tmp, {
        recursive: true,
      });
      renameShippedDotfiles(tmp);
      expect(fs.existsSync(path.join(tmp, '.npmignore'))).toBe(true);
      expect(fs.existsSync(path.join(tmp, 'npmignore.template'))).toBe(false);
    } finally {
      fs.rmSync(tmp, {recursive: true, force: true});
    }
  });
});

// The published lib/esm is loaded by Node's ESM resolver, which does not add
// extensions. `npm run build` is plain tsc and emits specifiers exactly as
// written, so an extensionless relative import in src ships broken — importing
// `@_linked/cli` failed with ERR_MODULE_NOT_FOUND on './tailwind.config' for
// that reason. Guard the source so the output is correct under any build path.
describe('esm specifiers in src', () => {
  test('every relative import names its .js file', async () => {
    const ts = require('typescript');
    const files = await glob('src/**/*.{ts,mts,cts}', {
      cwd: repoRoot,
      ignore: ['**/*.d.ts'],
    });
    const offenders: string[] = [];
    for (const file of files) {
      const text = fs.readFileSync(path.join(repoRoot, file), 'utf8');
      const {importedFiles} = ts.preProcessFile(text, true, true);
      for (const {fileName} of importedFiles) {
        if (!/^\.\.?(\/|$)/.test(fileName)) continue;
        if (/\.(js|mjs|cjs|json|css)$/.test(fileName)) continue;
        offenders.push(`${file}: '${fileName}'`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
