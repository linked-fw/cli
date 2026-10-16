import fs from 'fs';
import os from 'os';
import path from 'path';
import {createViteConfig} from '../../src/vite-config';

// `resolve.dedupe` holds the standalone pair (the two context-holding packages
// a standalone app's two `ssrLoadModule` loads must share) and, in every mode,
// `react` and `react-dom` when the app has them. Localized checkouts are
// workspace members (`packages-local/*`), so npm links and dedupes them and
// Vite needs no list of its own.

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
      'react',
    ]);
  });

  it('outside standalone dev, dedupes react and react-dom where the app has them', async () => {
    expect((await resolvedConfig('production')).resolve.dedupe).toEqual([
      'react',
    ]);
    writeJson(path.join(app, 'node_modules', 'react-dom', 'package.json'), {
      name: 'react-dom',
      version: '19.0.0',
    });
    expect((await resolvedConfig('production')).resolve.dedupe).toEqual([
      'react',
      'react-dom',
    ]);
  });

  it('dedupes nothing outside standalone dev when the app has no React', async () => {
    fs.rmSync(path.join(app, 'node_modules', 'react'), {
      recursive: true,
      force: true,
    });
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

  it('with source workspaces, still keeps installed linked packages out of the dep optimizer', async () => {
    // An app made from the template: its own ontology package is a source
    // workspace, while the framework packages are installed from npm. Pre-bundling
    // those duplicates `@_linked/core` per chunk and renames shape classes
    // (`Person` → `Person3`), so they must be excluded here too.
    editJson(
      path.join(app, 'node_modules', '@_linked', 'core', 'package.json'),
      (pkg) => {
        pkg.linkedPackage = true;
      },
    );
    const ont = path.join(app, 'packages', 'acme-ont');
    writeJson(path.join(ont, 'package.json'), {
      name: 'acme-ont',
      version: '1.0.0',
      linkedPackage: true,
    });
    fs.mkdirSync(path.join(ont, 'src'), {recursive: true});
    fs.mkdirSync(path.join(app, 'node_modules'), {recursive: true});
    fs.symlinkSync(ont, path.join(app, 'node_modules', 'acme-ont'));
    editJson(path.join(app, 'package.json'), (pkg) => {
      pkg.workspaces = ['packages/*'];
      pkg.dependencies = {'@_linked/core': '^2.25.0', 'acme-ont': '^1.0.0'};
    });

    const config = await resolvedConfig('development');
    expect(config.resolve.conditions).toBeUndefined();
    expect(config.optimizeDeps.exclude).toEqual(['acme-ont', '@_linked/core']);
    expect(config.optimizeDeps.esbuildOptions).toEqual({keepNames: true});
  });

  it('keeps class names in pre-bundled chunks in every mode', async () => {
    for (const mode of ['development', 'production']) {
      const config = await resolvedConfig(mode);
      expect(config.optimizeDeps.esbuildOptions).toEqual({keepNames: true});
    }
    expect((await resolvedConfig('production')).optimizeDeps.exclude).toBeUndefined();
  });
});
