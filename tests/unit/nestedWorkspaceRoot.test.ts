import fs from 'fs';
import os from 'os';
import path from 'path';
import {isWorkspaceRoot, readInstalledPkg} from '../../src/installed-packages';
import {discoverLocalPackages} from '../../src/lifecycle';
import {discoverWorkspaces} from '../../src/vite-config';

// An app made from the app template lists `packages-local/*` in its
// `workspaces` so it can localize packages standalone. Run inside a parent
// workspace (CN's `packages-local/<app>`) with no checkout of its own, npm
// hoisted its dependencies to the parent. A directory counts as a workspace
// root only when one of its globs matches a package that exists, so the
// node_modules walk goes on to the parent. Stopping at the app registered no
// localized package as source while Node loaded the parent's checkouts: two
// copies of `@_linked/core` in one process.

function writeJson(file: string, json: unknown) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, JSON.stringify(json, null, 2));
}

function makePackage(root: string, json: Record<string, unknown>) {
  writeJson(path.join(root, 'package.json'), json);
  fs.mkdirSync(path.join(root, 'src'), {recursive: true});
  fs.writeFileSync(path.join(root, 'src', 'index.ts'), 'export {};');
}

describe('an app with `packages-local/*` nested in a parent workspace', () => {
  let tmp: string;
  let parent: string;
  let checkout: string;
  let app: string;

  beforeEach(() => {
    tmp = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'linked-nested-')),
    );
    parent = path.join(tmp, 'parent');
    writeJson(path.join(parent, 'package.json'), {
      name: 'parent',
      private: true,
      workspaces: ['packages-local/*'],
    });
    checkout = path.join(parent, 'packages-local', '_fixture-pkg');
    makePackage(checkout, {
      name: '@fixture/pkg',
      version: '1.0.0',
      linkedPackage: true,
    });
    const nm = path.join(parent, 'node_modules', '@fixture');
    fs.mkdirSync(nm, {recursive: true});
    fs.symlinkSync(checkout, path.join(nm, 'pkg'), 'dir');

    app = path.join(parent, 'packages-local', 'app');
    makePackage(app, {
      name: 'app',
      private: true,
      workspaces: ['packages-local/*'],
      dependencies: {'@fixture/pkg': '^1.0.0'},
    });
  });

  afterEach(() => {
    fs.rmSync(tmp, {recursive: true, force: true});
  });

  describe.each([
    ['no packages-local/', () => {}],
    [
      'an empty packages-local/',
      () => fs.mkdirSync(path.join(app, 'packages-local')),
    ],
    [
      'only a dot directory in packages-local/',
      () =>
        makePackage(path.join(app, 'packages-local', '.repos', 'x'), {
          name: 'x',
        }),
    ],
    [
      'only a folder without package.json in packages-local/',
      () =>
        fs.mkdirSync(path.join(app, 'packages-local', 'stray'), {
          recursive: true,
        }),
    ],
  ])('with %s', (_label, setup) => {
    beforeEach(setup);

    it('is not a workspace root; the parent is', async () => {
      expect(await isWorkspaceRoot(app)).toBe(false);
      expect(await isWorkspaceRoot(parent)).toBe(true);
    });

    it("resolves the parent's installed packages", async () => {
      const found = await readInstalledPkg('@fixture/pkg', app);
      expect(found?.root).toBe(
        path.join(parent, 'node_modules', '@fixture', 'pkg'),
      );
    });

    it("registers the parent's localized checkout as a source workspace", async () => {
      const entries = await discoverWorkspaces([], app);
      const matches = entries.filter((e) => e.name === '@fixture/pkg');
      expect(matches).toHaveLength(1);
      expect(matches[0].srcDir).toBe(path.join(checkout, 'src'));
    });

    it("lists the parent's workspace members as local packages", () => {
      const names = discoverLocalPackages(app).map((p) => p.packageName);
      expect(names).toContain('@fixture/pkg');
    });
  });

  describe('with a checkout in its own packages-local/', () => {
    beforeEach(() => {
      makePackage(path.join(app, 'packages-local', '_fixture-own'), {
        name: '@fixture/own',
        version: '1.0.0',
        linkedPackage: true,
      });
    });

    it('still counts as a workspace root', async () => {
      expect(await isWorkspaceRoot(app)).toBe(true);
    });

    it('stops the node_modules walk at the app', async () => {
      expect(await readInstalledPkg('@fixture/pkg', app)).toBeNull();
    });

    it("lists its own members, not the parent's", () => {
      const names = discoverLocalPackages(app).map((p) => p.packageName);
      expect(names).toEqual(['@fixture/own']);
    });
  });

  it('does not count a member excluded by a negation', async () => {
    writeJson(path.join(app, 'package.json'), {
      name: 'app',
      private: true,
      workspaces: ['packages-local/*', '!packages-local/_fixture-own'],
      dependencies: {'@fixture/pkg': '^1.0.0'},
    });
    makePackage(path.join(app, 'packages-local', '_fixture-own'), {
      name: '@fixture/own',
    });
    expect(await isWorkspaceRoot(app)).toBe(false);
    expect(await readInstalledPkg('@fixture/pkg', app)).not.toBeNull();
  });

  it('counts an exact-path workspace that exists', async () => {
    writeJson(path.join(app, 'package.json'), {
      name: 'app',
      private: true,
      workspaces: ['tools/one'],
    });
    expect(await isWorkspaceRoot(app)).toBe(false);
    makePackage(path.join(app, 'tools', 'one'), {name: 'one'});
    expect(await isWorkspaceRoot(app)).toBe(true);
  });
});
