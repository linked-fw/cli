import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  createViteConfig,
  discoverWorkspaces,
  ssrNoExternal,
  SSR_ENTRY_PACKAGES,
  workspaceDependents,
} from '../../src/vite-config';

// In workspace mode only the source workspaces go through Vite SSR. Published
// framework packages (lib-only, under node_modules) must stay external so Vite-
// loaded source and Node-native `import()` (core's `loadStores`) share ONE
// `@_linked/core` instance.

function writeJson(file: string, json: unknown) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, JSON.stringify(json, null, 2));
}

// Mirrors Vite: `ssr.noExternal` entries are matched against the bare package name.
function bundled(noExternal: (string | RegExp)[], pkgName: string): boolean {
  return noExternal.some((p) => (typeof p === 'string' ? p === pkgName : p.test(pkgName)));
}

describe('ssr.noExternal', () => {
  let tmp: string;
  const cwd = process.cwd();

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'linked-ssr-')));
  });

  afterEach(() => {
    process.chdir(cwd);
    fs.rmSync(tmp, {recursive: true, force: true});
  });

  it('bundles only source workspaces; published @_linked packages stay external', async () => {
    writeJson(path.join(tmp, 'package.json'), {
      name: 'root',
      private: true,
      workspaces: ['packages/*', 'services/*'],
    });
    const shapes = path.join(tmp, 'packages', 'shapes');
    writeJson(path.join(shapes, 'package.json'), {
      name: 'shapes',
      linkedPackage: true,
      dependencies: {'@_linked/core': '1.0.0'},
    });
    fs.mkdirSync(path.join(shapes, 'src'), {recursive: true});
    fs.writeFileSync(path.join(shapes, 'src', 'index.ts'), 'export {};');
    // Published core: lib only, installed at the root.
    const core = path.join(tmp, 'node_modules', '@_linked', 'core');
    writeJson(path.join(core, 'package.json'), {name: '@_linked/core', linkedPackage: true});
    fs.mkdirSync(path.join(core, 'lib'), {recursive: true});
    fs.symlinkSync(shapes, path.join(tmp, 'node_modules', 'shapes'), 'dir');
    const app = path.join(tmp, 'services', 'api');
    writeJson(path.join(app, 'package.json'), {
      name: 'api',
      dependencies: {'@_linked/core': '1.0.0', shapes: '*'},
    });

    process.chdir(app);
    const factory = createViteConfig() as any;
    const config = await factory({command: 'serve', mode: 'development'});
    const noExternal = config.ssr.noExternal as (string | RegExp)[];

    // `@_linked/server` is the one published exception: `start` loads its entry
    // through Vite, so it is bundled rather than split across two loaders.
    expect(noExternal).toEqual(['shapes', '@_linked/server']);
    expect(bundled(noExternal, 'shapes')).toBe(true);
    for (const pkg of ['@_linked/core', '@_linked/fuseki', '@_linked/server-utils', 'lincd-foo']) {
      expect(bundled(noExternal, pkg)).toBe(false);
    }
    // Workspace mode keeps Vite's default conditions (`development` → src).
    expect(config.resolve).toBeUndefined();
    expect(config.ssr.resolve).toBeUndefined();
  });

  // Helpers for workspaceDependents fixtures.
  const sourcePkg = (dir: string, json: Record<string, unknown>) => {
    writeJson(path.join(dir, 'package.json'), json);
    fs.mkdirSync(path.join(dir, 'src'), {recursive: true});
    fs.writeFileSync(path.join(dir, 'src', 'index.ts'), 'export {};');
  };
  const publishedPkg = (name: string, json: Record<string, unknown> = {}) => {
    const dir = path.join(tmp, 'node_modules', ...name.split('/'));
    writeJson(path.join(dir, 'package.json'), {name, ...json});
    fs.mkdirSync(path.join(dir, 'lib'), {recursive: true});
  };
  const link = (name: string, target: string) => {
    const at = path.join(tmp, 'node_modules', ...name.split('/'));
    fs.mkdirSync(path.dirname(at), {recursive: true});
    fs.symlinkSync(target, at, 'dir');
  };

  it('published-core layout: published core, so fuseki stays external', async () => {
    writeJson(path.join(tmp, 'package.json'), {name: 'root', workspaces: ['packages/*', 'services/*']});
    const shapes = path.join(tmp, 'packages', 'shapes');
    sourcePkg(shapes, {name: 'shapes', linkedPackage: true, dependencies: {'@_linked/core': '1'}});
    link('shapes', shapes);
    publishedPkg('@_linked/core');
    publishedPkg('@_linked/fuseki', {dependencies: {'@_linked/core': '1'}});
    publishedPkg('left-pad');
    const app = path.join(tmp, 'services', 'api');
    writeJson(path.join(app, 'package.json'), {
      name: 'api',
      dependencies: {'@_linked/core': '1', '@_linked/fuseki': '1', shapes: '*', 'left-pad': '1'},
    });

    const workspaces = await discoverWorkspaces([], app);
    expect(workspaces.map((w) => w.name)).toEqual(['shapes']);
    const dependents = await workspaceDependents(workspaces, app);
    expect(dependents).toEqual([]);
    expect(ssrNoExternal(workspaces, dependents)).toEqual(['shapes', '@_linked/server']);
  });

  it('core-as-workspace layout: fuseki and its transitive dependents go through Vite', async () => {
    writeJson(path.join(tmp, 'package.json'), {
      name: 'root',
      workspaces: ['packages/*'],
      dependencies: {'@_linked/core': '*', shapes: '*', app: '1', 'left-pad': '1'},
    });
    const core = path.join(tmp, 'packages', 'core');
    sourcePkg(core, {name: '@_linked/core', linkedPackage: true});
    link('@_linked/core', core);
    const shapes = path.join(tmp, 'packages', 'shapes');
    sourcePkg(shapes, {name: 'shapes', linkedPackage: true, dependencies: {'@_linked/core': '*'}});
    link('shapes', shapes);
    publishedPkg('@_linked/fuseki', {peerDependencies: {'@_linked/core': '1'}});
    publishedPkg('uses-fuseki', {dependencies: {'@_linked/fuseki': '1'}});
    publishedPkg('app', {dependencies: {'uses-fuseki': '1', missing: '1'}});
    publishedPkg('left-pad', {dependencies: {'also-missing': '1'}});

    const workspaces = await discoverWorkspaces([], tmp);
    expect(workspaces.map((w) => w.name).sort()).toEqual(['@_linked/core', 'shapes']);
    const dependents = await workspaceDependents(workspaces, tmp);
    expect(dependents).toEqual(['@_linked/fuseki', 'app', 'uses-fuseki']);
    const noExternal = ssrNoExternal(workspaces, dependents);
    for (const pkg of ['@_linked/core', 'shapes', '@_linked/fuseki', 'uses-fuseki']) {
      expect(bundled(noExternal, pkg)).toBe(true);
    }
    expect(bundled(noExternal, 'left-pad')).toBe(false);
  });

  it('a production build force-bundles nothing, so the backend shares the server\'s framework copies', async () => {
    // No workspaces, as for a standalone app — but not dev. Compiling
    // server-utils into lib/ gave the backend its own ShapeProvider class, and
    // LinkedServer (installed) dropped every provider the app exported.
    writeJson(path.join(tmp, 'package.json'), {name: 'app', dependencies: {'@_linked/core': '1'}});
    process.chdir(tmp);
    const factory = createViteConfig() as any;
    const config = await factory({command: 'build', mode: 'production'});
    const noExternal = config.ssr.noExternal as (string | RegExp)[];
    for (const pkg of ['@_linked/server-utils', '@_linked/react', '@_linked/core']) {
      expect(bundled(noExternal, pkg)).toBe(false);
    }
  });

  it('standalone bundles only the context-holding framework packages', () => {
    const noExternal = ssrNoExternal([]);
    expect(bundled(noExternal, '@_linked/server-utils')).toBe(true);
    expect(bundled(noExternal, '@_linked/react')).toBe(true);
    expect(bundled(noExternal, '@_linked/core')).toBe(false);
  });

  // `start` loads LinkedServer through `vite.ssrLoadModule`, so Vite evaluates the
  // server package whatever `noExternal` says. Externalizing its bare imports as well
  // would evaluate some of its files a second time through Node.
  it('bundles the package start loads through Vite, in both modes', () => {
    expect(SSR_ENTRY_PACKAGES).toEqual(['@_linked/server']);
    const standalone = ssrNoExternal([]);
    const workspace = ssrNoExternal([{name: 'shapes'}], ['@_linked/fuseki']);
    for (const noExternal of [standalone, workspace]) {
      expect(bundled(noExternal, '@_linked/server')).toBe(true);
    }
    expect(ssrNoExternal([{name: '@_linked/server'}])).toEqual(['@_linked/server']);
  });
});
