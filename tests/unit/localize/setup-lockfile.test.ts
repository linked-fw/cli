/**
 * The set-up's lockfile as an edit of the root entry: exact or nothing.
 * A wrong edit is a committed lockfile npm disagrees with; a `null` only
 * sends the set-up to `npm install --package-lock-only`.
 */
import assert from 'node:assert/strict';

import {setupLockfileByEdit} from '../../../src/localize/setup-lockfile.js';

const lockOf = (root: object, extra: object = {}, indent: string | number = 2) =>
  JSON.stringify(
    {
      name: 'app',
      version: '1.0.0',
      lockfileVersion: 3,
      requires: true,
      packages: {
        '': {
          name: 'app',
          version: '1.0.0',
          hasInstallScript: true,
          workspaces: ['packages/*'],
          dependencies: {lodash: '^4.17.0'},
          ...root,
        },
        'node_modules/lodash': {version: '4.17.21'},
      },
      ...extra,
    },
    null,
    indent,
  ) + '\n';

/** `package.json`'s `workspaces` before the set-up added the glob: what the lockfile has. */
const BEFORE = ['packages/*'];

const pkg = {
  name: 'app',
  version: '1.0.0',
  workspaces: ['packages/*', 'packages-local/*'],
  scripts: {postinstall: 'node -e "…"'},
  dependencies: {lodash: '^4.17.0'},
};

test('the root entry gains the glob and nothing else changes', () => {
  const before = lockOf({});
  const after = setupLockfileByEdit(before, pkg, BEFORE);
  assert.equal(after, lockOf({workspaces: ['packages/*', 'packages-local/*']}));
});

test('indentation, CRLF and the object form of workspaces are kept', () => {
  const tabs = lockOf({}, {}, '\t').replace(/\n/g, '\r\n');
  const objPkg = {...pkg, workspaces: {packages: ['packages/*', 'packages-local/*']}};
  const after = setupLockfileByEdit(tabs, objPkg, BEFORE);
  assert.equal(
    after,
    lockOf({workspaces: objPkg.workspaces}, {}, '\t').replace(/\n/g, '\r\n'),
  );
});

test('null when npm must decide: no workspaces or install script yet, a v1 lockfile, unlocked dependencies, odd layout', () => {
  const noWs = JSON.parse(lockOf({}));
  delete noWs.packages[''].workspaces;
  assert.equal(setupLockfileByEdit(JSON.stringify(noWs, null, 2) + '\n', pkg, BEFORE), null, 'no workspaces key');
  assert.equal(setupLockfileByEdit(lockOf({hasInstallScript: undefined}), pkg, BEFORE), null, 'no install script');
  assert.equal(setupLockfileByEdit(lockOf({}, {lockfileVersion: 1}), pkg, BEFORE), null, 'v1');
  assert.equal(
    setupLockfileByEdit(lockOf({}), {...pkg, dependencies: {lodash: '^4.17.0', zod: '^3'}}, BEFORE),
    null,
    'a dependency npm has not locked',
  );
  assert.equal(
    setupLockfileByEdit(lockOf({}), {...pkg, devDependencies: {jest: '^29'}}, BEFORE),
    null,
    'a dev dependency npm has not locked',
  );
  assert.equal(setupLockfileByEdit(lockOf({}).replace('{\n  "name"', '{"name"'), pkg, BEFORE), null, 'layout');
  assert.equal(setupLockfileByEdit('not json', pkg, BEFORE), null);
  assert.equal(setupLockfileByEdit(lockOf({}), {...pkg, workspaces: undefined}, BEFORE), null);
});

test('an empty dependency object in package.json matches its absence in the lockfile', () => {
  assert.notEqual(setupLockfileByEdit(lockOf({}), {...pkg, devDependencies: {}}, BEFORE), null);
});

test('null when the lockfile root\'s workspaces are not package.json\'s before the set-up', () => {
  // package.json gained "apps/*" since the lockfile was last written: the edit would hide that.
  assert.equal(setupLockfileByEdit(lockOf({}), pkg, ['packages/*', 'apps/*']), null);
  assert.equal(setupLockfileByEdit(lockOf({}), pkg, undefined), null, 'no workspaces before');
  assert.equal(
    setupLockfileByEdit(lockOf({workspaces: ['apps/*', 'packages/*']}), pkg, BEFORE),
    null,
    'the same globs in another order',
  );
});
