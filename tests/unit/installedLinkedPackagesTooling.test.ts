// A `tooling` package (a build or dev tool) is built by `linked build` but is
// not a linked package: the walk of an app's installed linked packages, which
// hosts read to load, sync and list packages, leaves it out.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {discoverInstalledLinkedPackages} from '../../src/installed-packages';

function writePkg(dir: string, json: object) {
  fs.mkdirSync(dir, {recursive: true});
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(json));
}

describe('discoverInstalledLinkedPackages and tooling', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'linked-tooling-'));
  });
  afterEach(() => fs.rmSync(root, {recursive: true, force: true}));

  test('skips a tooling dependency, keeps a library one', async () => {
    writePkg(root, {
      name: 'app',
      linked: {kind: 'app'},
      dependencies: {'@x/lib': '1.0.0'},
      devDependencies: {'@x/tool': '1.0.0'},
    });
    writePkg(path.join(root, 'node_modules/@x/lib'), {
      name: '@x/lib',
      version: '1.0.0',
      linked: {kind: 'library'},
    });
    writePkg(path.join(root, 'node_modules/@x/tool'), {
      name: '@x/tool',
      version: '1.0.0',
      linked: {kind: 'tooling'},
    });
    const found = await discoverInstalledLinkedPackages(root);
    expect(found.map((p) => p.name)).toEqual(['@x/lib']);
  });
});
