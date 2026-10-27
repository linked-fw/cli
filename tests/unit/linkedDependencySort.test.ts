import fs from 'fs';
import os from 'os';
import path from 'path';
import {getLINCDDependencies, sortDependencyNames} from '../../src/utils';

// getLINCDDependencies orders the linked packages a package depends on, each after the
// packages it needs. A devDependency is not one of those: @_linked/core has @_linked/cli as
// a devDependency and the cli depends on core, which used to read as a cycle.

function writePackage(root: string, json: Record<string, unknown>) {
  const dir = path.join(root, 'node_modules', ...String(json.name).split('/'));
  fs.mkdirSync(dir, {recursive: true});
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(json));
}

describe('linked package sort', () => {
  let root: string;
  let cwd: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'linked-sort-'));
    cwd = process.cwd();
    process.chdir(root);
  });

  afterEach(() => {
    process.chdir(cwd);
    fs.rmSync(root, {recursive: true, force: true});
  });

  it('counts dependencies and peerDependencies, not devDependencies', () => {
    expect(
      sortDependencyNames({
        dependencies: {a: '1'},
        peerDependencies: {b: '1'},
        devDependencies: {c: '1'},
      } as any),
    ).toEqual(['a', 'b']);
  });

  it('orders core before the cli without reporting a cycle', () => {
    writePackage(root, {
      name: '@test/core',
      linked: {kind: 'assets'},
      devDependencies: {'@test/cli': '1'},
    });
    writePackage(root, {
      name: '@test/cli',
      linked: {kind: 'assets'},
      dependencies: {'@test/core': '1'},
    });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const sorted = getLINCDDependencies({
      name: 'app',
      dependencies: {'@test/cli': '1', '@test/core': '1'},
    });

    expect(warn).not.toHaveBeenCalled();
    expect(sorted.map(([name]) => name)).toEqual(['@test/core', '@test/cli']);
    warn.mockRestore();
  });
});
