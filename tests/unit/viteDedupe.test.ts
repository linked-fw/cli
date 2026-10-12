import fs from 'fs';
import os from 'os';
import path from 'path';
import {createViteConfig} from '../../src/vite-config';

// `resolve.dedupe` holds only the standalone pair: the two context-holding
// packages a standalone app's two `ssrLoadModule` loads must share. Localized
// checkouts are workspace members (`packages-local/*`), so npm links and
// dedupes them and Vite needs no list of its own.

function writeJson(file: string, json: unknown) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, JSON.stringify(json, null, 2));
}

const readJson = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));

/** An ESM package whose `which` export says which copy it is. */
function fakePkg(dir: string, name: string, version: string, which: string) {
  writeJson(path.join(dir, 'package.json'), {
    name,
    version,
    type: 'module',
    exports: {'.': './index.js'},
  });
  fs.writeFileSync(
    path.join(dir, 'index.js'),
    `export const which = ${JSON.stringify(which)};\n`,
  );
}

describe('resolve.dedupe', () => {
  let tmp: string;
  let app: string;
  const cwd = process.cwd();

  const editJson = (file: string, edit: (json: any) => void) => {
    const json = readJson(file);
    edit(json);
    writeJson(file, json);
  };

  beforeEach(() => {
    tmp = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'linked-dedupe-')),
    );
    app = path.join(tmp, 'app');
    writeJson(path.join(app, 'package.json'), {
      name: 'app',
      private: true,
      type: 'module',
      dependencies: {'@_linked/core': '^2.25.0'},
    });
    fakePkg(
      path.join(app, 'node_modules', '@_linked', 'core'),
      '@_linked/core',
      '2.25.0',
      'app',
    );
    writeJson(path.join(app, 'node_modules', 'react', 'package.json'), {
      name: 'react',
      version: '19.0.0',
    });
  });

  afterEach(() => {
    process.chdir(cwd);
    fs.rmSync(tmp, {recursive: true, force: true});
  });

  async function resolvedConfig(mode: string) {
    process.chdir(app);
    const factory = createViteConfig() as any;
    return factory({mode, command: mode === 'development' ? 'serve' : 'build'});
  }

  it('keeps the standalone pair even when they are not installed', async () => {
    const config = await resolvedConfig('development');
    expect(config.resolve.conditions).toEqual(['module', 'node']);
    expect(config.resolve.dedupe).toEqual([
      '@_linked/server-utils',
      '@_linked/react',
    ]);
  });

  it('dedupes nothing outside standalone dev', async () => {
    const config = await resolvedConfig('production');
    expect(config.resolve.dedupe).toEqual([]);
  });

  it('standalone: keeps linked packages out of the dep optimizer by flag, not by scope', async () => {
    editJson(
      path.join(app, 'node_modules', '@_linked', 'core', 'package.json'),
      (pkg) => {
        pkg.linkedPackage = true;
      },
    );
    fakePkg(
      path.join(app, 'node_modules', '@acme', 'widgets'),
      '@acme/widgets',
      '1.0.0',
      'widgets',
    );
    editJson(
      path.join(app, 'node_modules', '@acme', 'widgets', 'package.json'),
      (pkg) => {
        pkg.linkedPackage = true;
      },
    );
    // Under @_linked, but a plain tool with no flag; and one still carrying only the old `lincd` flag.
    writeJson(
      path.join(app, 'node_modules', '@_linked', 'tool', 'package.json'),
      {name: '@_linked/tool', version: '1.0.0'},
    );
    writeJson(path.join(app, 'node_modules', 'lincd-old', 'package.json'), {
      name: 'lincd-old',
      version: '1.0.0',
      lincd: true,
    });
    editJson(path.join(app, 'package.json'), (pkg) => {
      pkg.dependencies = {
        '@_linked/core': '^2.25.0',
        '@acme/widgets': '^1.0.0',
        '@_linked/tool': '^1.0.0',
        'lincd-old': '^1.0.0',
      };
    });

    const config = await resolvedConfig('development');
    expect(config.optimizeDeps.exclude).toEqual([
      '@_linked/core',
      '@acme/widgets',
    ]);
  });
});
