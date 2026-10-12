/**
 * `driftProblems` against hand-written hidden lockfiles
 * (`node_modules/.package-lock.json`) and real checkouts on disk: each kind
 * of drift, the clean tree, and a tree npm has not installed yet.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {describeDrift, driftProblems} from '../../../src/localize/drift.js';
import {makeConsumer, rm, test} from './helpers.js';

const consumer = (t, pkg = {}) => {
  const root = makeConsumer({pkg});
  t.after(() => rm(root));
  return root;
};

function checkout(appRoot, dirName, pkg) {
  const dir = path.join(appRoot, 'packages-local', dirName);
  fs.mkdirSync(dir, {recursive: true});
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg));
}

function hiddenLock(appRoot, packages) {
  fs.writeFileSync(
    path.join(appRoot, 'node_modules', '.package-lock.json'),
    JSON.stringify({name: 'consumer', lockfileVersion: 3, packages}),
  );
}

/** Two checkouts, linked the way npm links workspace members. */
function linkedPair(appRoot) {
  checkout(appRoot, 'a', {name: '@x/a', version: '1.2.0'});
  checkout(appRoot, 'b', {
    name: '@x/b',
    version: '2.0.0',
    dependencies: {'@x/a': '^1.0.0'},
  });
  return {
    'packages-local/a': {name: '@x/a', version: '1.2.0'},
    'packages-local/b': {name: '@x/b', version: '2.0.0'},
    'node_modules/@x/a': {resolved: 'packages-local/a', link: true},
    'node_modules/@x/b': {resolved: 'packages-local/b', link: true},
    'node_modules/@_linked/core': {version: '2.28.4'},
  };
}

test('a clean linked tree has no drift', (t) => {
  const appRoot = consumer(t, {dependencies: {'@x/a': '^1.1.0'}});
  hiddenLock(appRoot, linkedPair(appRoot));
  assert.deepEqual(driftProblems(appRoot), []);
});

test('no hidden lockfile: nothing installed yet is not drift', (t) => {
  const appRoot = consumer(t, {dependencies: {'@x/a': '^9.0.0'}});
  linkedPair(appRoot);
  assert.deepEqual(driftProblems(appRoot), []);
});

test('a nested copy of a localized package is a second copy', (t) => {
  const appRoot = consumer(t);
  hiddenLock(appRoot, {
    ...linkedPair(appRoot),
    'packages-local/b/node_modules/@x/a': {version: '1.0.3'},
  });
  assert.deepEqual(driftProblems(appRoot), [
    {
      kind: 'second-copy',
      name: '@x/a',
      version: '1.0.3',
      at: 'packages-local/b/node_modules/@x/a',
    },
  ]);
});

test('a nested copy of a singleton that is not localized is flagged', (t) => {
  const appRoot = consumer(t);
  hiddenLock(appRoot, {
    ...linkedPair(appRoot),
    'node_modules/foo': {version: '1.0.0'},
    'node_modules/foo/node_modules/@_linked/core': {version: '2.20.0'},
  });
  const drift = driftProblems(appRoot);
  assert.deepEqual(drift, [
    {
      kind: 'singleton-copy',
      name: '@_linked/core',
      version: '2.20.0',
      at: 'node_modules/foo/node_modules/@_linked/core',
    },
  ]);
  assert.match(describeDrift(drift[0]), /nested copy of @_linked\/core@2\.20\.0/);
});

test("a root range the checkout misses is a range-miss of '<root>'", (t) => {
  const appRoot = consumer(t, {dependencies: {'@_linked/core': '^2.28.4'}});
  checkout(appRoot, '_linked-core', {name: '@_linked/core', version: '2.28.3'});
  hiddenLock(appRoot, {
    'packages-local/_linked-core': {name: '@_linked/core', version: '2.28.3'},
    'node_modules/@_linked/core': {resolved: 'packages-local/_linked-core', link: true},
  });
  const drift = driftProblems(appRoot);
  assert.deepEqual(drift, [
    {
      kind: 'range-miss',
      name: '@_linked/core',
      version: '2.28.3',
      dir: 'packages-local/_linked-core',
      range: '^2.28.4',
      field: 'dependencies',
      importer: '<root>',
    },
  ]);
  assert.equal(
    describeDrift(drift[0]),
    '@_linked/core@2.28.3 (packages-local/_linked-core) does not satisfy dependencies "^2.28.4" of <root>',
  );
});

test('ranges come from packages/* and from other checkouts too', (t) => {
  const appRoot = consumer(t);
  hiddenLock(appRoot, linkedPair(appRoot));
  // b's live manifest moves ahead of a; the hidden lockfile has not seen it yet.
  checkout(appRoot, 'b', {name: '@x/b', version: '2.0.0', peerDependencies: {'@x/a': '^1.3.0'}});
  fs.mkdirSync(path.join(appRoot, 'packages', 'site'), {recursive: true});
  fs.writeFileSync(
    path.join(appRoot, 'packages', 'site', 'package.json'),
    JSON.stringify({name: 'site', devDependencies: {'@x/b': '^3.0.0', '@x/a': 'workspace:*'}}),
  );
  assert.deepEqual(
    driftProblems(appRoot).map((d) => d.kind === 'range-miss' && `${d.importer} ${d.field} ${d.name}`),
    ['packages/site devDependencies @x/b', 'packages-local/b peerDependencies @x/a'],
  );
});

test('a lock entry for a checkout that is gone is a missing dir', (t) => {
  const appRoot = consumer(t);
  hiddenLock(appRoot, {
    ...linkedPair(appRoot),
    'packages-local/gone': {name: '@x/gone', version: '1.0.0'},
    'node_modules/@x/gone': {resolved: 'packages-local/gone', link: true},
  });
  const drift = driftProblems(appRoot);
  assert.deepEqual(drift, [{kind: 'missing-dir', dir: 'packages-local/gone'}]);
  assert.match(describeDrift(drift[0]), /packages-local\/gone .*npm install/);
});
