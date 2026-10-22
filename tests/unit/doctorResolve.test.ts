import fs from 'fs';
import os from 'os';
import path from 'path';
import {doctorResolve, linkedImports, nodeLoaded, resolveRows} from '../../src/commands/doctor';

// `linked doctor resolve` compares where Vite's dev SSR runner loads each
// package with where Node resolves it, so a worktree overlay is visible and a
// package loaded twice in one process is caught.

function writeJson(file: string, json: unknown) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, JSON.stringify(json, null, 2));
}

/** A source checkout: package.json without an exported ./package.json, plus src/. */
function sourcePkg(root: string, name: string) {
  writeJson(path.join(root, 'package.json'), {
    name,
    linkedPackage: true,
    exports: {'./*': './lib/esm/*.js'},
  });
  fs.mkdirSync(path.join(root, 'src'), {recursive: true});
  fs.writeFileSync(path.join(root, 'src', 'index.ts'), 'export {};');
}

function link(target: string, at: string) {
  fs.mkdirSync(path.dirname(at), {recursive: true});
  fs.symlinkSync(target, at, 'dir');
}

describe('linked doctor resolve', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'linked-doctor-')));
  });

  afterEach(() => {
    fs.rmSync(tmp, {recursive: true, force: true});
  });

  it('main-checkout layout: Vite and Node load the same checkout', async () => {
    const app = path.join(tmp, 'app');
    writeJson(path.join(app, 'package.json'), {
      name: 'app',
      workspaces: ['packages-local/*'],
      dependencies: {'@_linked/core': '*'},
    });
    const core = path.join(app, 'packages-local', '_linked-core');
    sourcePkg(core, '@_linked/core');
    link(core, path.join(app, 'node_modules', '@_linked', 'core'));

    const rows = await resolveRows(app);
    expect(rows).toEqual([
      {name: '@_linked/core', vite: core, node: core, bundled: true, flag: ''},
    ]);
    const out: string[] = [];
    expect(await doctorResolve({}, app, {}, (s) => out.push(s))).toBe(0);
    expect(out.join('')).toContain('app/packages-local/_linked-core');
  });

  it('worktree overlay: its own checkout wins in Vite, Node loads the main one; exit 0', async () => {
    // The main checkout: its node_modules links @_linked/server to its own checkout.
    const main = path.join(tmp, 'main');
    const mainServer = path.join(main, 'packages-local', '_linked-server');
    sourcePkg(mainServer, '@_linked/server');
    link(mainServer, path.join(main, 'node_modules', '@_linked', 'server'));
    // The worktree: node_modules is a symlink to the main checkout's, and its
    // packages-local holds its own checkout of @_linked/server.
    const wt = path.join(tmp, 'wt');
    writeJson(path.join(wt, 'package.json'), {
      name: 'app',
      workspaces: ['packages-local/*'],
      dependencies: {'@_linked/server': '*'},
    });
    link(path.join(main, 'node_modules'), path.join(wt, 'node_modules'));
    const wtServer = path.join(wt, 'packages-local', '_linked-server');
    sourcePkg(wtServer, '@_linked/server');

    const rows = await resolveRows(wt);
    expect(rows).toEqual([
      {name: '@_linked/server', vite: wtServer, node: mainServer, bundled: true, flag: 'overlay'},
    ]);
    expect(await doctorResolve({}, wt, {}, () => {})).toBe(0);
  });

  it('a bundled @_linked/cli with a different root than Node loads is two copies; exit 1', async () => {
    // Since the CLI is never bundled in dev, the bundling is passed in, as the
    // config was before it left the CLI to Node.
    const main = path.join(tmp, 'main');
    const mainCli = path.join(main, 'packages-local', '_linked-cli');
    sourcePkg(mainCli, '@_linked/cli');
    link(mainCli, path.join(main, 'node_modules', '@_linked', 'cli'));
    const wt = path.join(tmp, 'wt');
    writeJson(path.join(wt, 'package.json'), {name: 'app', workspaces: ['packages-local/*']});
    link(path.join(main, 'node_modules'), path.join(wt, 'node_modules'));
    const wtCli = path.join(wt, 'packages-local', '_linked-cli');
    sourcePkg(wtCli, '@_linked/cli');

    // Without inputs the real config leaves the CLI to Node: no flag.
    const [real] = await resolveRows(wt);
    expect(real).toEqual({name: '@_linked/cli', vite: 'external', node: mainCli, bundled: false, flag: ''});
    // Passed in ssr.noExternal too, ssr.external still wins.
    const [both] = await resolveRows(wt, {noExternal: ['@_linked/cli']});
    expect(both.bundled).toBe(false);

    const inputs = {noExternal: ['@_linked/cli'], external: []};
    const [row] = await resolveRows(wt, inputs);
    expect(row).toEqual({name: '@_linked/cli', vite: wtCli, node: mainCli, bundled: true, flag: 'two-copies'});
    const out: string[] = [];
    expect(await doctorResolve({}, wt, inputs, (s) => out.push(s))).toBe(1);
    expect(out.join('')).toContain('@_linked/cli: Vite bundles a different copy');
  });

  it('NODE_LOADED from the app\'s vite config: an overlay of a package it imports is two copies', async () => {
    // The main checkout and a worktree overlaying @_linked/auth and @_linked/server.
    const main = path.join(tmp, 'main');
    const wt = path.join(tmp, 'wt');
    writeJson(path.join(wt, 'package.json'), {name: 'app', workspaces: ['packages-local/*']});
    link(path.join(main, 'node_modules'), path.join(wt, 'node_modules'));
    for (const short of ['auth', 'server']) {
      const mainPkg = path.join(main, 'packages-local', `_linked-${short}`);
      sourcePkg(mainPkg, `@_linked/${short}`);
      link(mainPkg, path.join(main, 'node_modules', '@_linked', short));
      sourcePkg(path.join(wt, 'packages-local', `_linked-${short}`), `@_linked/${short}`);
    }

    // No vite config: only the CLI is loaded by Node, so both are overlays.
    expect(nodeLoaded(wt)).toEqual(['@_linked/cli']);
    expect((await resolveRows(wt)).map((r) => r.flag)).toEqual(['overlay', 'overlay']);

    fs.writeFileSync(
      path.join(wt, 'vite.config.ts'),
      [
        "import {defineConfig} from 'vite';",
        "import {AUTH_COOKIE} from '@_linked/auth/utils/cookieNames';",
        "import type {Shape} from '@_linked/core/shapes/Shape';",
        "// import '@_linked/maps';",
        "const x = await import('@_linked/rdfs');",
        'export default defineConfig({});',
      ].join('\n'),
    );
    expect(nodeLoaded(wt)).toEqual(['@_linked/auth', '@_linked/cli', '@_linked/rdfs']);
    const rows = await resolveRows(wt);
    expect(rows.map((r) => [r.name, r.flag])).toEqual([
      ['@_linked/auth', 'two-copies'],
      ['@_linked/server', 'overlay'],
    ]);
    expect(await doctorResolve({}, wt, {}, () => {})).toBe(1);
  });

  it('linkedImports reads import, export-from, dynamic import and require specifiers', () => {
    const source = [
      "import a from '@_linked/a';",
      'import "@_linked/b/side-effect";',
      "export {c} from '@_linked/c/sub/path';",
      "const d = require('@_linked/d');",
      "const e = await import ( '@_linked/e/x' );",
      "export type {F} from '@_linked/f';",
      "/* import g from '@_linked/g'; */",
      "import h from '@other/h';",
    ].join('\n');
    expect(linkedImports(source).sort()).toEqual([
      '@_linked/a',
      '@_linked/b',
      '@_linked/c',
      '@_linked/d',
      '@_linked/e',
    ]);
  });

  it('--json prints the rows with name, vite, node, bundled and flag', async () => {
    const app = path.join(tmp, 'app');
    writeJson(path.join(app, 'package.json'), {
      name: 'app',
      workspaces: ['packages-local/*'],
      dependencies: {'@_linked/core': '*'},
    });
    const core = path.join(app, 'packages-local', '_linked-core');
    sourcePkg(core, '@_linked/core');
    link(core, path.join(app, 'node_modules', '@_linked', 'core'));
    // An installed, published package: lib only, so not bundled.
    writeJson(path.join(app, 'node_modules', '@_linked', 'rdfs', 'package.json'), {
      name: '@_linked/rdfs',
      linkedPackage: true,
    });

    const out: string[] = [];
    expect(await doctorResolve({json: true}, app, {}, (s) => out.push(s))).toBe(0);
    const rows = JSON.parse(out.join(''));
    expect(rows.map((r: {name: string}) => r.name)).toEqual(['@_linked/core', '@_linked/rdfs']);
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(['bundled', 'flag', 'name', 'node', 'vite']);
    }
    expect(rows[1]).toEqual({
      name: '@_linked/rdfs',
      vite: 'external',
      node: path.join(app, 'node_modules', '@_linked', 'rdfs'),
      bundled: false,
      flag: '',
    });
  });
});
