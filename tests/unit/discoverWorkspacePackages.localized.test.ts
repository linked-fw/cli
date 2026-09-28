import fs from 'fs';
import os from 'os';
import path from 'path';
import {discoverWorkspacePackages} from '../../src/commands/start';

// The HMR watch set feeds `onSourceChange(name)` — the dispose-and-re-index
// cycle that replaces a package's registered backend providers. Built from
// `workspaces` alone it cannot contain a LOCALIZED checkout
// (`packages-local/<pkg>`, in no workspace glob, reachable only through its
// `node_modules` symlink), so `workspacePackageForPath` returns null for it and
// the backend keeps serving the instance it registered at boot: the edit is
// reloaded by Vite and then has no effect.
//
// The watch set must therefore be discovered the same way `discoverWorkspaces`'
// dependency pass is — walk dependencies + devDependencies, keep
// `linkedPackage: true`, register those shipping `src/` — so the two lists
// cannot disagree about what is source.

function writeJson(file: string, json: unknown) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, JSON.stringify(json, null, 2));
}

function makePackage(root: string, json: Record<string, unknown>, withSrc = true) {
  writeJson(path.join(root, 'package.json'), json);
  if (withSrc) {
    fs.mkdirSync(path.join(root, 'src'), {recursive: true});
    fs.writeFileSync(path.join(root, 'src', 'index.ts'), 'export {};');
  }
}

function link(from: string, to: string) {
  fs.mkdirSync(path.dirname(to), {recursive: true});
  fs.symlinkSync(from, to, 'dir');
}

describe('discoverWorkspacePackages with a localized checkout', () => {
  let tmp: string;
  let app: string;
  let checkout: string;

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'linked-watchset-')));
    app = path.join(tmp, 'app');
    writeJson(path.join(app, 'package.json'), {
      name: 'app',
      private: true,
      workspaces: ['packages/*'],
      dependencies: {
        '@fixture/pkg': '^1.0.0',
        '@fixture/published': '^1.0.0',
        '@fixture/plain': '^1.0.0',
        '@fixture/shipssrc': '^1.0.0',
      },
    });
    fs.mkdirSync(path.join(app, 'src'), {recursive: true});
    // One ordinary workspace package, so the globs pass has something to find.
    makePackage(path.join(app, 'packages', 'inglob'), {
      name: '@fixture/inglob',
      linkedPackage: true,
    });

    // The localized checkout: in no glob, reachable only via node_modules.
    checkout = path.join(app, 'packages-local', 'pkg');
    makePackage(checkout, {name: '@fixture/pkg', version: '1.0.0', linkedPackage: true});
    link(checkout, path.join(app, 'node_modules', '@fixture', 'pkg'));

    // Control 1: a linked dep installed normally — published, so no `src/`.
    // Watching it is meaningless; there is no source to edit.
    makePackage(
      path.join(app, 'node_modules', '@fixture', 'published'),
      {name: '@fixture/published', version: '1.0.0', linkedPackage: true},
      false,
    );
    // Control 2: a dep that ships `src/` but is not a linked package.
    makePackage(path.join(app, 'node_modules', '@fixture', 'plain'), {
      name: '@fixture/plain',
      version: '1.0.0',
    });
    // Control 3: a linked dep whose tarball ships `src/` but which is installed
    // normally, so it stays inside node_modules. The resolver registers it (it
    // serves that source), but Vite's watcher ignores node_modules, so it must
    // not be counted as watched.
    makePackage(path.join(app, 'node_modules', '@fixture', 'shipssrc'), {
      name: '@fixture/shipssrc',
      version: '1.0.0',
      linkedPackage: true,
    });
  });

  afterEach(() => {
    fs.rmSync(tmp, {recursive: true, force: true});
  });

  it('watches the localized checkout under its npm name, at its realpath', async () => {
    const pkgs = await discoverWorkspacePackages(app);
    const match = pkgs.filter((p) => p.name === '@fixture/pkg');
    expect(match).toHaveLength(1);
    expect(match[0].root).toBe(checkout);
    expect(match[0].srcDir).toBe(path.join(checkout, 'src'));
  });

  it('does not watch a linked dep that ships no src/, nor a non-linked dep', async () => {
    const names = (await discoverWorkspacePackages(app)).map((p) => p.name);
    expect(names).not.toContain('@fixture/published');
    expect(names).not.toContain('@fixture/plain');
  });

  it('does not watch a published linked dep that ships src/ inside node_modules', async () => {
    const names = (await discoverWorkspacePackages(app)).map((p) => p.name);
    expect(names).not.toContain('@fixture/shipssrc');
  });

  it('keeps the app itself and its workspace-glob packages', async () => {
    const names = (await discoverWorkspacePackages(app)).map((p) => p.name).sort();
    expect(names).toEqual(['@fixture/inglob', '@fixture/pkg', 'app']);
  });
});
