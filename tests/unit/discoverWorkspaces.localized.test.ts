import fs from 'fs';
import os from 'os';
import path from 'path';
import {discoverWorkspaces} from '../../src/vite-config';

// A LOCALIZED package (`semantu localize`) is a git checkout in the app's
// `packages-local/<pkg>` that is in NO workspace glob, reachable only through
// the `node_modules/<name>` symlink the localizer writes. The dependency pass
// must register it — that is the mechanism the dev loop rests on — but it must
// register it under the checkout's REAL path.
//
// Registering the `node_modules` spelling instead makes Vite serve one file
// under two ids (`/node_modules/@fixture/pkg/src/…` from this table,
// `/packages-local/pkg/src/…` from Vite's own realpathing resolver), which
// means two module instances: measured in CN as
// `useAuth must be used within a ProvideAuth component`.

function writeJson(file: string, json: unknown) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, JSON.stringify(json, null, 2));
}

function makePackage(root: string, json: Record<string, unknown>) {
  writeJson(path.join(root, 'package.json'), json);
  fs.mkdirSync(path.join(root, 'src'), {recursive: true});
  fs.writeFileSync(path.join(root, 'src', 'index.ts'), 'export {};');
}

describe('discoverWorkspaces with a localized checkout', () => {
  let tmp: string;
  let app: string;
  let checkout: string;

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'linked-localized-')));
    app = path.join(tmp, 'app');
    // The app is a workspace root whose globs cover `packages/*` only —
    // `packages-local/` is deliberately outside every glob.
    writeJson(path.join(app, 'package.json'), {
      name: 'app',
      private: true,
      workspaces: ['packages/*'],
      dependencies: {'@fixture/pkg': '^1.0.0'},
    });
    fs.mkdirSync(path.join(app, 'src'), {recursive: true});
    checkout = path.join(app, 'packages-local', 'pkg');
    makePackage(checkout, {name: '@fixture/pkg', version: '1.0.0', linkedPackage: true});
    const nm = path.join(app, 'node_modules', '@fixture');
    fs.mkdirSync(nm, {recursive: true});
    fs.symlinkSync(checkout, path.join(nm, 'pkg'), 'dir');
  });

  afterEach(() => {
    fs.rmSync(tmp, {recursive: true, force: true});
  });

  it('registers the checkout exactly once, at its realpath', async () => {
    const entries = await discoverWorkspaces([], app);
    const matches = entries.filter((e) => e.name === '@fixture/pkg');
    expect(matches).toHaveLength(1);
    expect(matches[0].srcDir).toBe(path.join(checkout, 'src'));
  });

  it('never registers the node_modules spelling of the checkout', async () => {
    const entries = await discoverWorkspaces([], app);
    const srcDirs = entries.map((e) => e.srcDir);
    expect(srcDirs).not.toContain(
      path.join(app, 'node_modules', '@fixture', 'pkg', 'src'),
    );
  });

  it('still registers a plain symlinked workspace package at its realpath', async () => {
    // Same rule for the ordinary `packages/*` case: the glob pass already uses
    // real directories, so this only pins that the fix does not regress it.
    const real = path.join(tmp, 'elsewhere', 'other');
    makePackage(real, {name: '@fixture/other', version: '1.0.0', linkedPackage: true});
    const appPkgPath = path.join(app, 'package.json');
    const appPkg = JSON.parse(fs.readFileSync(appPkgPath, 'utf8'));
    appPkg.dependencies['@fixture/other'] = '^1.0.0';
    writeJson(appPkgPath, appPkg);
    fs.symlinkSync(real, path.join(app, 'node_modules', '@fixture', 'other'), 'dir');
    const entries = await discoverWorkspaces([], app);
    const match = entries.find((e) => e.name === '@fixture/other');
    expect(match?.srcDir).toBe(path.join(real, 'src'));
  });
});

// Two localized packages where one depends on the other: A's checkout has its
// own `npm install`, so `packages-local/a/node_modules/@fixture/b` is a
// registry copy of B (lib only, no `src/`). The walk reaches that copy through
// A before it reaches the app's own `@fixture/b`, which is the localized B.
// Measured in a scratch app with `@_linked/dcat` and `@_linked/dcmi` localized:
// the table held only dcat, so Vite served the localized dcmi from `lib/`, and
// dcat's own import of dcmi went to the nested registry copy.
describe('discoverWorkspaces with two localized checkouts, one depending on the other', () => {
  let tmp: string;
  let app: string;

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'linked-localized-pair-')));
    app = path.join(tmp, 'app');
    writeJson(path.join(app, 'package.json'), {
      name: 'app',
      private: true,
      workspaces: ['packages/*'],
      // Alphabetical, as npm writes it: A is walked first.
      dependencies: {'@fixture/a': '^1.0.0', '@fixture/b': '^1.0.0'},
    });
    const a = path.join(app, 'packages-local', '_fixture-a');
    const b = path.join(app, 'packages-local', '_fixture-b');
    makePackage(a, {
      name: '@fixture/a',
      version: '1.0.0',
      linkedPackage: true,
      dependencies: {'@fixture/b': '^1.0.0'},
    });
    makePackage(b, {name: '@fixture/b', version: '1.0.0', linkedPackage: true});
    // A's own install: a published, lib-only copy of B.
    writeJson(path.join(a, 'node_modules', '@fixture', 'b', 'package.json'), {
      name: '@fixture/b',
      version: '1.0.0',
      linkedPackage: true,
    });
    const nm = path.join(app, 'node_modules', '@fixture');
    fs.mkdirSync(nm, {recursive: true});
    fs.symlinkSync(a, path.join(nm, 'a'), 'dir');
    fs.symlinkSync(b, path.join(nm, 'b'), 'dir');
  });

  afterEach(() => {
    fs.rmSync(tmp, {recursive: true, force: true});
  });

  it('registers both checkouts, at their realpaths', async () => {
    const entries = await discoverWorkspaces([], app);
    expect(
      entries
        .filter((e) => e.name.startsWith('@fixture/'))
        .map((e) => [e.name, path.relative(app, e.srcDir)])
        .sort(),
    ).toEqual([
      ['@fixture/a', path.join('packages-local', '_fixture-a', 'src')],
      ['@fixture/b', path.join('packages-local', '_fixture-b', 'src')],
    ]);
  });
});
