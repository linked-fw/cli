/**
 * `hooks/manifests.cjs`: the dependency manifests the hooks watch follow the
 * app's own `workspaces`, in both forms npm reads, never the checkouts' glob.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {makeConsumer, rm, test} from './helpers.js';

const {manifestPathspecs, expandGlobs, trackedGlobs, LEAK} = require(
  path.resolve(__dirname, '../../../hooks/manifests.cjs'),
);

const consumer = (t, pkg = {}) => {
  const root = makeConsumer({pkg});
  t.after(() => rm(root));
  return root;
};

test('an array of workspaces: every glob but packages-local/*', (t) => {
  const appRoot = consumer(t, {workspaces: ['packages/*', 'apps/*', 'packages-local/*']});
  assert.deepEqual(manifestPathspecs(appRoot), [
    'package.json',
    'packages/*/package.json',
    'apps/*/package.json',
  ]);
});

test('the {packages: [...]} form, ./ prefixes, trailing slashes and negations', (t) => {
  const appRoot = consumer(t, {
    workspaces: {packages: ['./packages/*', 'tools/cli/', '!packages/skip', 'packages-local/**', 'apps/*']},
  });
  assert.deepEqual(manifestPathspecs(appRoot), [
    'package.json',
    'packages/*/package.json',
    'tools/cli/package.json',
    'apps/*/package.json',
  ]);
});

test('no workspaces, or no package.json, is the root manifest alone', (t) => {
  const appRoot = consumer(t);
  assert.deepEqual(manifestPathspecs(appRoot), ['package.json']);
  fs.rmSync(path.join(appRoot, 'package.json'));
  assert.deepEqual(manifestPathspecs(appRoot), ['package.json']);
  assert.deepEqual(trackedGlobs(appRoot, ['packages/*']), ['packages/*']);
});

test('globs expand to directories with a package.json, per glob, sorted', (t) => {
  const appRoot = consumer(t);
  for (const dir of ['apps/b', 'apps/a', 'apps/no-manifest', 'packages/x', 'packages/x/nested/deep', 'apps/.hidden']) {
    fs.mkdirSync(path.join(appRoot, dir), {recursive: true});
    if (!dir.endsWith('no-manifest')) fs.writeFileSync(path.join(appRoot, dir, 'package.json'), '{}');
  }
  assert.deepEqual(expandGlobs(appRoot, ['packages/*', 'apps/*']), ['packages/x', 'apps/a', 'apps/b']);
  assert.deepEqual(expandGlobs(appRoot, ['packages/**']), ['packages/x', 'packages/x/nested/deep']);
  assert.deepEqual(expandGlobs(appRoot, ['missing/*']), []);
});

test('the leak rule: a checkout entry, not the glob', () => {
  assert.ok(LEAK.test('"packages-local/a": {'));
  assert.ok(LEAK.test('"resolved": "packages-local/_linked-core"'));
  assert.ok(!LEAK.test('"workspaces": ["packages/*", "packages-local/*"]'));
});
