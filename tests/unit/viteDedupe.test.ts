import {execFileSync} from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {createViteConfig, localizedDedupe} from '../../src/vite-config';
import {describeSkipped} from '../../src/localized-dedupe';

// A localized checkout (`packages-local/<pkg>`, installed by `linked localize`)
// carries its own `node_modules`, pinned by ITS lockfile: its own
// `@_linked/core`, often older than the app's. Vite resolves a bare import from
// the importer, so without a dedupe the dev SSR backend loaded the checkout's
// core next to the app's — measured: three cores in one process with three
// localized packages.
//
// The duplicates come from LOCALIZATION, so that is what `createViteConfig`
// detects: it dedupes the localized packages, what their checkouts import that
// the app has at a version they accept, and React.

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

const LOADER = path.join(
  __dirname,
  '..',
  'fixtures',
  'vite-dedupe',
  'load-through-ssr.mjs',
);

describe('resolve.dedupe', () => {
  let tmp: string;
  let app: string;
  let checkout: string;
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
      dependencies: {
        '@_linked/core': '^2.25.0',
        '@_linked/a': '^1.0.0',
        lodash: '^4.0.0',
      },
    });
    fakePkg(
      path.join(app, 'node_modules', '@_linked', 'core'),
      '@_linked/core',
      '2.25.0',
      'app',
    );
    fakePkg(
      path.join(app, 'node_modules', 'lodash'),
      'lodash',
      '4.17.21',
      'app',
    );
    writeJson(path.join(app, 'node_modules', 'react', 'package.json'), {
      name: 'react',
      version: '19.0.0',
    });

    // The localized checkout, linked in and recorded, with the older core its own install left.
    checkout = path.join(app, 'packages-local', '_linked-a');
    writeJson(path.join(checkout, 'package.json'), {
      name: '@_linked/a',
      version: '1.0.0',
      type: 'module',
      linkedPackage: true,
      exports: {'.': {development: './src/index.js', import: './lib/index.js'}},
      dependencies: {'@_linked/core': '^2.22.8'},
    });
    fs.mkdirSync(path.join(checkout, 'src'), {recursive: true});
    fs.writeFileSync(
      path.join(checkout, 'src', 'index.js'),
      "import {which} from '@_linked/core';\nexport const core = which;\n",
    );
    fakePkg(
      path.join(checkout, 'node_modules', '@_linked', 'core'),
      '@_linked/core',
      '2.22.8',
      'checkout',
    );
    fs.symlinkSync(
      checkout,
      path.join(app, 'node_modules', '@_linked', 'a'),
      'dir',
    );
    writeJson(path.join(app, 'local-packages.json'), {
      version: 1,
      packages: {
        '@_linked/a': {path: 'packages-local/_linked-a', branch: 'main'},
      },
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

  it('lists the localized packages, what their checkouts import that the app has, and React', async () => {
    expect((await localizedDedupe(app)).names).toEqual([
      '@_linked/a',
      '@_linked/core',
      'react',
    ]);
  });

  it('dedupes by what is localized, not by package flag or scope', async () => {
    // A checkout's runtime dependency with no linked flag and no @_linked scope.
    editJson(path.join(checkout, 'package.json'), (pkg) => {
      pkg.dependencies.lodash = '^4.17.0';
    });
    expect((await localizedDedupe(app)).names).toContain('lodash');
    // ...and nothing when nothing is localized: the app's own packages are not duplicated.
    fs.rmSync(path.join(app, 'local-packages.json'));
    expect((await localizedDedupe(app)).names).toEqual(['react']);
  });

  it('leaves out a dependency whose range the app does not satisfy, and says so', async () => {
    editJson(path.join(checkout, 'package.json'), (pkg) => {
      pkg.peerDependencies = {lodash: '^5.0.0'};
    });
    const {names, skipped} = await localizedDedupe(app);
    expect(names).not.toContain('lodash');
    expect(describeSkipped(skipped)).toBe(
      "[linked] dedupe: 1 package a localized checkout keeps its own copy of, because the app's " +
        'version is outside its range: lodash (@_linked/a asks ^5.0.0; app 4.17.21)',
    );
  });

  it('leaves out a name a registry install nests its own copy of: deduping would hand it the wrong version', async () => {
    editJson(path.join(checkout, 'package.json'), (pkg) => {
      pkg.dependencies.lodash = '^4.17.0';
    });
    fakePkg(
      path.join(app, 'node_modules', 'old-tool', 'node_modules', 'lodash'),
      'lodash',
      '3.10.1',
      'old',
    );
    const {names, skipped} = await localizedDedupe(app);
    expect(names).not.toContain('lodash');
    expect(skipped).toEqual([
      {
        name: 'lodash',
        reason: 'nested',
        nestedAt: path.join(
          'node_modules',
          'old-tool',
          'node_modules',
          'lodash',
        ),
      },
    ]);
  });

  it('always dedupes a localized package, which every importer should reach live', async () => {
    // A registry install with its own copy of the localized package does not stop it.
    fakePkg(
      path.join(
        app,
        'node_modules',
        'old-tool',
        'node_modules',
        '@_linked',
        'a',
      ),
      '@_linked/a',
      '0.9.0',
      'old',
    );
    expect((await localizedDedupe(app)).names).toContain('@_linked/a');
  });

  it('is set in workspace mode — a localized checkout makes this app a workspace app', async () => {
    const config = await resolvedConfig('development');
    expect(config.resolve.dedupe).toEqual([
      '@_linked/a',
      '@_linked/core',
      'react',
    ]);
    // Workspace mode still keeps Vite's default conditions (`development` → src).
    expect(config.resolve.conditions).toBeUndefined();
  });

  it('is set for a build too', async () => {
    const config = await resolvedConfig('production');
    expect(config.resolve.dedupe).toEqual([
      '@_linked/a',
      '@_linked/core',
      'react',
    ]);
  });

  it('keeps the standalone pair even when they are not installed', async () => {
    fs.rmSync(path.join(app, 'packages-local'), {recursive: true, force: true});
    fs.rmSync(path.join(app, 'node_modules', '@_linked', 'a'));
    fs.rmSync(path.join(app, 'local-packages.json'));
    const config = await resolvedConfig('development');
    expect(config.resolve.conditions).toEqual(['module', 'node']);
    expect(config.resolve.dedupe).toEqual([
      '@_linked/server-utils',
      '@_linked/react',
      'react',
    ]);
  });

  it('standalone: keeps linked packages out of the dep optimizer by flag, not by scope', async () => {
    fs.rmSync(path.join(app, 'packages-local'), {recursive: true, force: true});
    fs.rmSync(path.join(app, 'node_modules', '@_linked', 'a'));
    fs.rmSync(path.join(app, 'local-packages.json'));
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

  it("makes the checkout's import of @_linked/core load the app's copy in Vite SSR", async () => {
    const config = await resolvedConfig('development');
    const load = (resolve: unknown) =>
      JSON.parse(
        execFileSync(
          process.execPath,
          [
            LOADER,
            app,
            path.join(checkout, 'src', 'index.js'),
            JSON.stringify(resolve),
          ],
          {
            cwd: path.join(__dirname, '..', '..'),
            encoding: 'utf8',
          },
        ),
      );
    // The control: what the checkout got before.
    expect(load({})).toEqual({core: 'checkout'});
    expect(load({dedupe: config.resolve.dedupe})).toEqual({core: 'app'});
  });
});
