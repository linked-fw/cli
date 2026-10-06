import {execFileSync} from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {createViteConfig, linkedDedupe} from '../../src/vite-config';

// A localized checkout (`packages-local/<pkg>`, installed by `linked localize`)
// carries its own `node_modules`, pinned by ITS lockfile: its own
// `@_linked/core`, often older than the app's. Vite resolves a bare import from
// the importer, so without a dedupe the dev SSR backend loaded the checkout's
// core next to the app's — measured: three cores in one process with three
// localized packages. `createViteConfig` dedupes every installed `@_linked/*`
// package plus React, in every mode, which collapses them to the app's copy.

function writeJson(file: string, json: unknown) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, JSON.stringify(json, null, 2));
}

/** An ESM package whose `core` export says which copy it is. */
function fakeCore(dir: string, version: string, which: string) {
  writeJson(path.join(dir, 'package.json'), {
    name: '@_linked/core',
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

  beforeEach(() => {
    tmp = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'linked-dedupe-')),
    );
    app = path.join(tmp, 'app');
    writeJson(path.join(app, 'package.json'), {
      name: 'app',
      private: true,
      type: 'module',
      dependencies: {'@_linked/core': '^2.25.0', '@_linked/a': '^1.0.0'},
    });
    fakeCore(
      path.join(app, 'node_modules', '@_linked', 'core'),
      '2.25.0',
      'app',
    );
    writeJson(path.join(app, 'node_modules', 'react', 'package.json'), {
      name: 'react',
      version: '19.0.0',
    });

    // The localized checkout, linked in, with the older core its own install left.
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
    fakeCore(
      path.join(checkout, 'node_modules', '@_linked', 'core'),
      '2.22.8',
      'checkout',
    );
    fs.symlinkSync(
      checkout,
      path.join(app, 'node_modules', '@_linked', 'a'),
      'dir',
    );
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

  it('lists every installed @_linked/* package and React, and nothing that is not installed', () => {
    expect(linkedDedupe(app)).toEqual(['@_linked/a', '@_linked/core', 'react']);
  });

  it('finds packages hoisted to a node_modules above the app', () => {
    fakeCore(
      path.join(tmp, 'node_modules', '@_linked', 'hoisted'),
      '1.0.0',
      'hoisted',
    );
    writeJson(path.join(tmp, 'node_modules', 'react-dom', 'package.json'), {
      name: 'react-dom',
      version: '19.0.0',
    });
    expect(linkedDedupe(app)).toEqual([
      '@_linked/a',
      '@_linked/core',
      '@_linked/hoisted',
      'react',
      'react-dom',
    ]);
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
    const config = await resolvedConfig('development');
    expect(config.resolve.conditions).toEqual(['module', 'node']);
    expect(config.resolve.dedupe).toEqual([
      '@_linked/server-utils',
      '@_linked/react',
      '@_linked/core',
      'react',
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
          {cwd: path.join(__dirname, '..', '..'), encoding: 'utf8'},
        ),
      );
    // The control: what the checkout got before.
    expect(load({})).toEqual({core: 'checkout'});
    expect(load({dedupe: config.resolve.dedupe})).toEqual({core: 'app'});
  });
});
