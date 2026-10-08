import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  isBarePackageSpecifier,
  lastClientDepScan,
  linkedClientDepIncludesPlugin,
  resolveExportsSubpath,
  scanLinkedClientDeps,
} from '../../src/client-dep-includes';

// Excluded framework packages are not crawled by Vite's optimizer, so their own
// client dependencies must be listed in optimizeDeps.include. The list is read
// from the import graph: what the packages' client files import, where npm put
// it, and whether it can run in a browser at all.

function write(file: string, content: string | object) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(
    file,
    typeof content === 'string' ? content : JSON.stringify(content, null, 2),
  );
}

/** A dependency package: CJS by default, `extra` merged into its package.json. */
function dep(
  root: string,
  name: string,
  files: Record<string, string>,
  extra: object = {},
) {
  const dir = path.join(root, 'node_modules', name);
  write(path.join(dir, 'package.json'), {
    name,
    version: '1.0.0',
    main: 'index.js',
    ...extra,
  });
  for (const [file, content] of Object.entries(files))
    write(path.join(dir, file), content);
  return dir;
}

const LIB_EXPORTS = {
  '.': {types: './lib/esm/index.d.ts', import: './lib/esm/index.js'},
  './*': {types: './lib/esm/*.d.ts', import: './lib/esm/*.js'},
};

describe('scanLinkedClientDeps', () => {
  let app: string;

  beforeEach(() => {
    app = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'linked-client-deps-')),
    );
    write(path.join(app, 'package.json'), {
      name: 'app',
      dependencies: {'@_linked/ui': '*'},
    });

    // A published framework package: client components, and server code in the same lib.
    const ui = dep(
      app,
      '@_linked/ui',
      {
        'lib/esm/index.js': "export * from './Button.js';\n",
        'lib/esm/Button.js': [
          "import {Slot} from 'radix-slot';",
          "import Cookies from 'cjs-cookie';",
          "import {Drawer} from 'nested-drawer';",
          "import 'radix-slot/styles.css';",
          "import {helper} from './util/helper.js';",
          "import {Core} from '@_linked/core/Core';",
          'export const Button = () => [Slot, Cookies, Drawer, helper, Core];',
        ].join('\n'),
        'lib/esm/util/helper.js':
          "import {v4} from 'browser-uuid';\nexport const helper = v4;\n",
        // server code: imports a builtin directly
        'lib/esm/backend/Provider.js':
          "import fs from 'node:fs';\nimport jwt from 'server-jwt';\nexport const p = [fs, jwt];\n",
        // imports server code relatively: server code too, whatever else it imports
        'lib/esm/backend/index.js':
          "import {p} from './Provider.js';\nimport cors from 'only-from-server';\nexport {p, cors};\n",
        // imports a server-only package (no browser entry, reaches a builtin through its own dependency)
        'lib/esm/mail.js':
          "import send from 'mailer';\nexport const mail = send;\n",
        'lib/esm/types.d.ts': "import type {X} from 'types-only';\n",
      },
      {type: 'module', linkedPackage: true, exports: LIB_EXPORTS},
    );
    write(path.join(ui, 'node_modules', 'nested-drawer', 'package.json'), {
      name: 'nested-drawer',
      version: '0.9.0',
      module: 'index.mjs',
      peerDependencies: {react: '^18'},
    });
    write(
      path.join(ui, 'node_modules', 'nested-drawer', 'index.mjs'),
      'export const Drawer = 1;\n',
    );

    dep(
      app,
      'radix-slot',
      {'index.mjs': 'export const Slot = 1;\n'},
      {module: 'index.mjs'},
    );
    dep(app, 'cjs-cookie', {'index.js': 'module.exports = {get() {}};\n'});
    dep(
      app,
      'browser-uuid',
      {
        'index.js': "const c = require('crypto');\n",
        'browser.js': 'export const v4 = 1;\n',
      },
      {browser: 'browser.js'},
    );
    dep(app, 'server-jwt', {
      'index.js': "module.exports = require('./lib/sign');\n",
      'lib/sign.js': "const crypto = require('crypto');\n",
    });
    dep(app, 'only-from-server', {'index.js': 'module.exports = 1;\n'});
    dep(app, 'mailer', {
      'index.js': "module.exports = require('mail-transport');\n",
    });
    dep(app, 'mail-transport', {'index.js': "const net = require('net');\n"});
    dep(
      app,
      'nested-drawer',
      {'index.js': 'module.exports = "root copy";\n'},
      {version: '1.0.0'},
    );
  });

  afterEach(() => {
    fs.rmSync(app, {recursive: true, force: true});
  });

  test('lists the client imports of excluded framework packages', async () => {
    const scan = await scanLinkedClientDeps(['@_linked/ui'], {cwd: app});
    expect(scan.entries.map((e) => e.entry)).toEqual([
      '@_linked/ui > nested-drawer',
      'browser-uuid',
      'cjs-cookie',
      'radix-slot',
    ]);
  });

  test('a dependency npm nested under the framework package gets the nested form', async () => {
    const scan = await scanLinkedClientDeps(['@_linked/ui'], {cwd: app});
    const drawer = scan.entries.find((e) => e.depName === 'nested-drawer')!;
    expect(drawer.nested).toBe(true);
    expect(drawer.depRoot).toBe(
      path.join(
        app,
        'node_modules',
        '@_linked',
        'ui',
        'node_modules',
        'nested-drawer',
      ),
    );
    // hoisted ones resolve to the same copy from the app root
    expect(scan.entries.find((e) => e.entry === 'cjs-cookie')!.nested).toBe(
      false,
    );
  });

  test('a nested dependency the app root cannot resolve at all is nested too', async () => {
    fs.rmSync(path.join(app, 'node_modules', 'nested-drawer'), {
      recursive: true,
    });
    const scan = await scanLinkedClientDeps(['@_linked/ui'], {cwd: app});
    expect(scan.entries.map((e) => e.entry)).toContain(
      '@_linked/ui > nested-drawer',
    );
  });

  test('server-only packages and imports from server code are left out', async () => {
    const scan = await scanLinkedClientDeps(['@_linked/ui'], {cwd: app});
    const reasons = Object.fromEntries(
      scan.skipped.map((s) => [s.specifier, s.reason]),
    );
    expect(reasons['server-jwt']).toBe('server-only');
    // reaches a builtin only through its own dependency
    expect(reasons['mailer']).toBe('server-only');
    // harmless on its own, but only imported by a file that imports server code
    expect(reasons['only-from-server']).toBe('server-code');
    const entries = scan.entries.map((e) => e.entry);
    for (const name of [
      'server-jwt',
      'mailer',
      'only-from-server',
      'fs',
      'node:fs',
    ]) {
      expect(entries).not.toContain(name);
    }
  });

  test('a browser entry makes a dependency browser-capable even if its node entry uses builtins', async () => {
    const scan = await scanLinkedClientDeps(['@_linked/ui'], {cwd: app});
    expect(scan.entries.map((e) => e.entry)).toContain('browser-uuid');
  });

  test('assets, type-only imports and other framework packages are not listed', async () => {
    const entries = (
      await scanLinkedClientDeps(['@_linked/ui'], {cwd: app})
    ).entries.map((e) => e.specifier);
    expect(entries).not.toContain('radix-slot/styles.css');
    expect(entries).not.toContain('types-only');
    expect(entries).not.toContain('@_linked/core/Core');
  });

  test('dependencies the app excludes are skipped', async () => {
    const scan = await scanLinkedClientDeps(['@_linked/ui', 'cjs-cookie'], {
      cwd: app,
    });
    expect(scan.entries.map((e) => e.entry)).not.toContain('cjs-cookie');
    expect(scan.skipped).toContainEqual({
      specifier: 'cjs-cookie',
      from: '@_linked/ui',
      reason: 'excluded',
    });
  });

  test('deny matches the entry, the specifier or the package name', async () => {
    for (const deny of [
      ['@_linked/ui > nested-drawer'],
      ['nested-drawer'],
      [/drawer/],
    ]) {
      const scan = await scanLinkedClientDeps(['@_linked/ui'], {
        cwd: app,
        deny,
      });
      expect(scan.entries.map((e) => e.depName)).not.toContain('nested-drawer');
    }
  });

  test('excluded non-framework packages and command-line packages are not scanned', async () => {
    dep(
      app,
      '@_linked/tool',
      {'lib/esm/index.js': "import 'cjs-cookie';\n"},
      {type: 'module', bin: {tool: 'x.js'}, exports: LIB_EXPORTS},
    );
    dep(app, 'plain', {'index.js': "import 'radix-slot';\n"});
    const scan = await scanLinkedClientDeps(['@_linked/tool', 'plain'], {
      cwd: app,
    });
    expect(scan.entries).toEqual([]);
    expect(scan.frameworkPackages).toEqual([]);
  });

  test('a custom-scope package marked linkedPackage is scanned', async () => {
    dep(
      app,
      '@acme/shapes',
      {'lib/esm/index.js': "import 'radix-slot';\n"},
      {type: 'module', linkedPackage: true, exports: LIB_EXPORTS},
    );
    const scan = await scanLinkedClientDeps(['@acme/shapes'], {cwd: app});
    expect(scan.entries.map((e) => e.entry)).toEqual(['radix-slot']);
  });

  test('a source workspace is scanned from src, TypeScript and JSX included', async () => {
    const ws = path.join(app, 'packages', 'maps');
    write(path.join(ws, 'package.json'), {
      name: '@_linked/maps',
      version: '0.1.0',
      dependencies: {'map-gl': '*'},
    });
    write(
      path.join(ws, 'src', 'Map.tsx'),
      [
        "import type {Style} from 'style-types';",
        "import maplibre from 'map-gl';",
        "import {tile} from './tiles.js';",
        '@decorate class Holder {}',
        'export const Map = (p: {s: Style}) => <div>{String(maplibre)}{tile}</div>;',
        'function decorate(t: any) { return t; }',
      ].join('\n'),
    );
    write(
      path.join(ws, 'src', 'tiles.ts'),
      "import {PMTiles} from 'pm-tiles';\nexport const tile: number = PMTiles;\n",
    );
    write(path.join(ws, 'src', 'Map.test.ts'), "import 'test-only';\n");
    dep(
      app,
      'map-gl',
      {'index.mjs': 'export default 1;\n'},
      {module: 'index.mjs'},
    );
    dep(
      app,
      'pm-tiles',
      {'index.mjs': 'export const PMTiles = 1;\n'},
      {module: 'index.mjs'},
    );
    dep(app, 'react', {
      'index.js': 'module.exports = {};\n',
      'jsx-runtime.js': 'module.exports = {};\n',
    });
    dep(app, 'test-only', {'index.js': ''});
    const scan = await scanLinkedClientDeps(['@_linked/maps'], {
      cwd: app,
      sourceWorkspaces: [{name: '@_linked/maps', srcDir: path.join(ws, 'src')}],
    });
    expect(scan.entries.map((e) => e.entry)).toEqual([
      'map-gl',
      'pm-tiles',
      'react/jsx-runtime',
    ]);
  });

  test('typescript is never listed', async () => {
    dep(app, 'typescript', {'index.js': ''}, {browser: {fs: false}});
    write(
      path.join(app, 'node_modules', '@_linked', 'ui', 'lib', 'esm', 'keys.js'),
      "import ts from 'typescript';\n",
    );
    const scan = await scanLinkedClientDeps(['@_linked/ui'], {cwd: app});
    expect(scan.entries.map((e) => e.entry)).not.toContain('typescript');
  });

  test('react-native is never listed: a web build never loads it, and esbuild cannot parse its Flow source', async () => {
    dep(app, 'react-native', {'index.js': ''}, {browser: 'index.js'});
    write(
      path.join(app, 'node_modules', '@_linked', 'ui', 'lib', 'esm', 'native.js'),
      "import {View} from 'react-native';\nimport x from 'react-native/Libraries/Foo';\n",
    );
    const scan = await scanLinkedClientDeps(['@_linked/ui'], {cwd: app});
    expect(
      scan.entries.map((e) => e.entry).filter((e) => e.startsWith('react-native')),
    ).toEqual([]);
  });

  test('the cache returns the same result without rescanning', async () => {
    const cacheFile = path.join(
      app,
      'node_modules',
      '.cache',
      'linked',
      'client-deps.json',
    );
    const first = await scanLinkedClientDeps(['@_linked/ui'], {
      cwd: app,
      cacheFile,
    });
    expect(fs.existsSync(cacheFile)).toBe(true);
    // An installed package does not change without a version change, so its
    // graph comes from the cache: an edit that is not a reinstall goes unseen.
    write(
      path.join(app, 'node_modules', '@_linked', 'ui', 'lib', 'esm', 'Late.js'),
      "import 'late-dep';\n",
    );
    dep(app, 'late-dep', {'index.js': ''});
    const cached = await scanLinkedClientDeps(['@_linked/ui'], {
      cwd: app,
      cacheFile,
    });
    expect(cached.entries).toEqual(first.entries);
    const fresh = await scanLinkedClientDeps(['@_linked/ui'], {cwd: app});
    expect(fresh.entries.map((e) => e.entry)).toContain('late-dep');
  });

  test('an excluded name the app cannot resolve is reported', async () => {
    const scan = await scanLinkedClientDeps(
      ['@_linked/ui', '@_linked/missing'],
      {cwd: app},
    );
    expect(scan.unresolvedExcludes).toEqual(['@_linked/missing']);
  });

  describe('the Vite plugin', () => {
    const env = {command: 'serve', mode: 'development'};
    const run = async (plugins: any[], userConfig: any) =>
      plugins[1].config.handler(userConfig, env);

    test('adds the entries to the app’s include without replacing it and skips ones already listed', async () => {
      const plugins: any[] = linkedClientDepIncludesPlugin({cacheFile: false});
      expect(plugins[1].apply).toBe('serve');
      expect(plugins[1].config.order).toBe('post');
      const result = await run(plugins, {
        root: app,
        optimizeDeps: {
          exclude: ['@_linked/ui'],
          include: ['cjs-cookie', 'app-own'],
        },
      });
      // Vite concatenates this onto the app's own list.
      expect(result).toEqual({
        optimizeDeps: {
          include: [
            '@_linked/ui > nested-drawer',
            'browser-uuid',
            'radix-slot',
          ],
        },
      });
    });

    test('records the app’s own include as it was before other plugins added theirs', async () => {
      const plugins: any[] = linkedClientDepIncludesPlugin({cacheFile: false});
      expect(plugins[0].config.order).toBe('pre');
      plugins[0].config.handler(
        {optimizeDeps: {include: ['hand-written']}},
        env,
      );
      await run(plugins, {
        root: app,
        optimizeDeps: {
          exclude: ['@_linked/ui'],
          include: ['hand-written', 'react/jsx-runtime'],
        },
      });
      expect(lastClientDepScan.current?.appInclude).toEqual(['hand-written']);
      expect(lastClientDepScan.current?.scan.entries.length).toBe(4);
    });

    test('does nothing for an API-only server (no dependency discovery)', async () => {
      const plugins: any[] = linkedClientDepIncludesPlugin({cacheFile: false});
      expect(
        await run(plugins, {
          root: app,
          optimizeDeps: {exclude: ['@_linked/ui'], noDiscovery: true},
        }),
      ).toBeUndefined();
    });
  });
});

describe('specifier helpers', () => {
  test('isBarePackageSpecifier', () => {
    for (const yes of [
      'vaul',
      '@radix-ui/react-slot',
      'use-sync-external-store/shim',
      'lodash.debounce',
    ]) {
      expect(isBarePackageSpecifier(yes)).toBe(true);
    }
    for (const no of [
      './x',
      '/abs',
      'node:fs',
      'fs',
      'virtual:foo',
      '#internal',
      'pkg/style.css',
      'x?raw',
      '',
    ]) {
      expect(isBarePackageSpecifier(no)).toBe(false);
    }
  });

  test('resolveExportsSubpath follows exact keys, patterns and conditions', () => {
    const json = {
      exports: {
        '.': {import: './esm/index.js', require: './cjs/index.js'},
        './shim/*': {browser: './b/*.js', default: './d/*.js'},
      },
    };
    expect(resolveExportsSubpath(json, '.', ['import'])).toBe('./esm/index.js');
    expect(
      resolveExportsSubpath(json, './shim/with-selector', ['browser']),
    ).toBe('./b/with-selector.js');
    expect(
      resolveExportsSubpath(json, './shim/with-selector', ['import']),
    ).toBe('./d/with-selector.js');
    expect(resolveExportsSubpath(json, './missing', ['import'])).toBeNull();
    expect(
      resolveExportsSubpath({main: 'x.js'}, '.', ['import']),
    ).toBeUndefined();
  });
});
