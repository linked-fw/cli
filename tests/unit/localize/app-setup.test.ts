/**
 * `ensureAppSetup` edits the app's package.json and .gitignore once and then
 * never again; `conflictingOverrides` names the overrides npm would refuse.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  LOCK_AT_REST_COMMAND,
  conflictingOverrides,
  ensureAppSetup,
} from '../../../src/localize/app-setup.js';
import {makeConsumer, rm, test} from './helpers.js';

const HOOK = LOCK_AT_REST_COMMAND;

const consumer = (t, pkg = {}) => {
  const root = makeConsumer({pkg});
  t.after(() => rm(root));
  return root;
};

const readPkg = (appRoot) =>
  JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8'));

test('adds the glob and both hook scripts once; a second call changes nothing', (t) => {
  const appRoot = consumer(t, {workspaces: ['packages/*']});
  const first = ensureAppSetup(appRoot);
  assert.deepEqual(
    first.filter((c) => c.file === 'package.json').map((c) => c.what),
    [
      'workspaces += "packages-local/*"',
      `scripts.postinstall: "${HOOK}"`,
      `scripts.dependencies: "${HOOK}"`,
    ],
  );
  const pkg = readPkg(appRoot);
  assert.deepEqual(pkg.workspaces, ['packages/*', 'packages-local/*']);
  assert.equal(pkg.scripts.postinstall, HOOK);
  assert.equal(pkg.scripts.dependencies, HOOK);

  const before = fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8');
  assert.deepEqual(ensureAppSetup(appRoot), []);
  assert.equal(
    fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8'),
    before,
  );
});

test('an app without workspaces gets the glob as its only one', (t) => {
  const appRoot = consumer(t);
  ensureAppSetup(appRoot);
  assert.deepEqual(readPkg(appRoot).workspaces, ['packages-local/*']);
});

test('replaces linked localize --relink, appends to any other script, keeps one that runs the hook', (t) => {
  const appRoot = consumer(t, {
    workspaces: ['packages-local/*'],
    scripts: {
      postinstall: 'linked localize --relink',
      dependencies: 'foo',
    },
  });
  ensureAppSetup(appRoot);
  let scripts = readPkg(appRoot).scripts;
  assert.equal(scripts.postinstall, HOOK);
  assert.equal(scripts.dependencies, `foo && ${HOOK}`);

  fs.writeFileSync(
    path.join(appRoot, 'package.json'),
    JSON.stringify({
      name: 'consumer',
      workspaces: ['packages-local/*'],
      scripts: {
        postinstall: 'foo && npx linked localize --relink',
        dependencies: `${HOOK} && bar`,
      },
    }),
  );
  ensureAppSetup(appRoot);
  scripts = readPkg(appRoot).scripts;
  assert.equal(scripts.postinstall, `foo && ${HOOK}`);
  assert.equal(scripts.dependencies, `${HOOK} && bar`);
});

test('the hook is guarded: it runs only when the cli is installed', () => {
  assert.equal(
    HOOK,
    `node -e "const p='node_modules/@_linked/cli/hooks/lock-at-rest.cjs';require('fs').existsSync(p)&&require(require('path').resolve(p))"`,
  );
});

test('upgrades the unguarded hook in place, alone or inside an && chain', (t) => {
  const OLD = 'node node_modules/@_linked/cli/hooks/lock-at-rest.cjs';
  const appRoot = consumer(t, {
    workspaces: ['packages-local/*'],
    scripts: {postinstall: OLD, dependencies: `foo && ${OLD} && bar`},
  });
  const changes = ensureAppSetup(appRoot);
  assert.deepEqual(
    changes.filter((c) => c.file === 'package.json').map((c) => c.what),
    [
      `scripts.postinstall: "${OLD}" -> "${HOOK}"`,
      `scripts.dependencies: "foo && ${OLD} && bar" -> "foo && ${HOOK} && bar"`,
    ],
  );
  const text = fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8');
  const {scripts} = JSON.parse(text);
  assert.equal(scripts.postinstall, HOOK);
  assert.equal(scripts.dependencies, `foo && ${HOOK} && bar`);
  // Written as JSON: the quotes inside the command are escaped, and it reads back unchanged.
  assert.ok(text.includes(JSON.stringify(HOOK)));
  assert.deepEqual(ensureAppSetup(appRoot), []);
});

test('keeps the indentation, key order and trailing newline', (t) => {
  const appRoot = consumer(t);
  const file = path.join(appRoot, 'package.json');
  fs.writeFileSync(
    file,
    JSON.stringify(
      {name: 'app', scripts: {build: 'x'}, workspaces: ['packages/*'], z: 1},
      null,
      2,
    ) + '\n',
  );
  ensureAppSetup(appRoot);
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.endsWith('}\n'));
  assert.match(
    text,
    /^\{\n {2}"name": "app",\n {2}"scripts": \{\n {4}"build": "x",/,
  );
  assert.deepEqual(Object.keys(JSON.parse(text)), [
    'name',
    'scripts',
    'workspaces',
    'z',
  ]);

  fs.writeFileSync(file, JSON.stringify({name: 'app'}, null, '\t'));
  ensureAppSetup(appRoot);
  const tabbed = fs.readFileSync(file, 'utf8');
  assert.match(tabbed, /^\{\n\t"name": "app",/);
  assert.ok(!tabbed.endsWith('\n'));
});

test('.gitignore lines are added once, under a comment, and an equivalent line counts', (t) => {
  const appRoot = consumer(t, {workspaces: ['packages-local/*']});
  const file = path.join(appRoot, '.gitignore');
  fs.writeFileSync(file, 'node_modules\n/packages-local');
  const changes = ensureAppSetup(appRoot);
  assert.deepEqual(
    changes.filter((c) => c.file === '.gitignore'),
    [{file: '.gitignore', what: 'ignore .packages-local.parked/'}],
  );
  assert.equal(
    fs.readFileSync(file, 'utf8'),
    'node_modules\n/packages-local\n\n# linked localize\n.packages-local.parked/\n',
  );
  assert.deepEqual(ensureAppSetup(appRoot), []);
});

test('a missing .gitignore is created', (t) => {
  const appRoot = consumer(t);
  ensureAppSetup(appRoot);
  assert.equal(
    fs.readFileSync(path.join(appRoot, '.gitignore'), 'utf8'),
    '# linked localize\npackages-local/\n.packages-local.parked/\n',
  );
});

test('conflictingOverrides finds a root and a nested scoped override, nothing else', (t) => {
  const appRoot = consumer(t, {
    overrides: {
      '@_linked/core': '$@_linked/core',
      react: '$react',
      '@_linked/auth': {'@_linked/core@^2': '2.28.0', '.': '1.0.0'},
      foo: {bar: {'@_linked/react': '1.0.0'}},
    },
  });
  assert.deepEqual(conflictingOverrides(appRoot, ['@_linked/core']), [
    '@_linked/core',
    '@_linked/auth > @_linked/core@^2',
  ]);
  assert.deepEqual(conflictingOverrides(appRoot, ['@_linked/react']), [
    'foo > bar > @_linked/react',
  ]);
  assert.deepEqual(conflictingOverrides(appRoot, ['@_linked/shape-ui']), []);
});

test('conflictingOverrides with no overrides is empty', (t) => {
  const appRoot = consumer(t);
  assert.deepEqual(conflictingOverrides(appRoot, ['@_linked/core']), []);
});
