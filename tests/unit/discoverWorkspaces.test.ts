import fs from 'fs';
import os from 'os';
import path from 'path';
import {discoverWorkspaces} from '../../src/vite-config';

// Linked-package discovery must resolve deps the way Node does: an app inside
// an npm-workspaces monorepo finds its deps HOISTED to the root node_modules.
// Missing them flips `linked start` into standalone mode.

function writeJson(file: string, json: unknown) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, JSON.stringify(json, null, 2));
}

function makePackage(root: string, json: Record<string, unknown>) {
  writeJson(path.join(root, 'package.json'), json);
  fs.mkdirSync(path.join(root, 'src'), {recursive: true});
  fs.writeFileSync(path.join(root, 'src', 'index.ts'), 'export {};');
}

describe('discoverWorkspaces', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'linked-discover-')));
  });

  afterEach(() => {
    fs.rmSync(tmp, {recursive: true, force: true});
  });

  // <mono>/package.json declares workspaces. The app at services/api depends on
  // `shapes` (linked), which depends on `nested-linked` (linked). npm hoists all
  // workspace packages as symlinks into <mono>/node_modules; the app has no
  // node_modules of its own.
  function makeMonorepo(mono: string, appDeps: Record<string, string>) {
    writeJson(path.join(mono, 'package.json'), {
      name: 'root',
      private: true,
      workspaces: ['packages/*', 'services/*'],
    });
    makePackage(path.join(mono, 'packages', 'shapes'), {
      name: 'shapes',
      linked: {kind: 'assets'},
      dependencies: {'nested-linked': '1.0.0'},
    });
    makePackage(path.join(mono, 'packages', 'nested-linked'), {
      name: 'nested-linked',
      linked: {kind: 'assets'},
    });
    makePackage(path.join(mono, 'packages', 'plain'), {name: 'plain'});
    const app = path.join(mono, 'services', 'api');
    makePackage(app, {name: 'api', dependencies: appDeps});
    const rootNm = path.join(mono, 'node_modules');
    fs.mkdirSync(rootNm, {recursive: true});
    for (const name of ['shapes', 'nested-linked', 'plain']) {
      fs.symlinkSync(path.join(mono, 'packages', name), path.join(rootNm, name), 'dir');
    }
    return app;
  }

  it('finds linked packages hoisted to the workspace root node_modules', async () => {
    const app = makeMonorepo(tmp, {shapes: '1.0.0', plain: '1.0.0', missing: '1.0.0'});
    const names = (await discoverWorkspaces([], app)).map((w) => w.name).sort();
    expect(names).toEqual(['nested-linked', 'shapes']);
  });

  it('does not resolve past the workspace root', async () => {
    const mono = path.join(tmp, 'mono');
    const app = makeMonorepo(mono, {shapes: '1.0.0', outside: '1.0.0'});
    // A linked package installed ABOVE the workspace root is out of scope.
    makePackage(path.join(tmp, 'node_modules', 'outside'), {
      name: 'outside',
      linked: {kind: 'assets'},
    });
    const names = (await discoverWorkspaces([], app)).map((w) => w.name);
    expect(names).toContain('shapes');
    expect(names).not.toContain('outside');
  });
});
