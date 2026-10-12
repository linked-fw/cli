/**
 * The record is the directories: what `localMembers` and `parkedMembers`
 * count as a checkout, read from a real filesystem.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  localMembers,
  parkedMembers,
  LOCAL_DIR,
  PARKED_DIR,
} from '../../../src/localize/members.js';
import {makeConsumer, rm, test} from './helpers.js';

const consumer = (t) => {
  const root = makeConsumer();
  t.after(() => rm(root));
  return root;
};

function dir(appRoot, rel, pkg?) {
  const full = path.join(appRoot, rel);
  fs.mkdirSync(full, {recursive: true});
  if (pkg !== undefined)
    fs.writeFileSync(
      path.join(full, 'package.json'),
      typeof pkg === 'string' ? pkg : JSON.stringify(pkg),
    );
}

test('no packages-local/ means no members', (t) => {
  const appRoot = consumer(t);
  assert.deepEqual(localMembers(appRoot), []);
  assert.deepEqual(parkedMembers(appRoot), []);
});

test('a directory counts only with a readable, named package.json; sorted by name', (t) => {
  const appRoot = consumer(t);
  dir(appRoot, `${LOCAL_DIR}/zz`, {name: '@x/b', version: '2.0.0'});
  dir(appRoot, `${LOCAL_DIR}/aa`, {name: '@x/c', version: '1.0.0'});
  dir(appRoot, `${LOCAL_DIR}/mm`, {name: '@x/a', version: '3.1.0'});
  dir(appRoot, `${LOCAL_DIR}/empty`);
  dir(appRoot, `${LOCAL_DIR}/broken`, '{not json');
  dir(appRoot, `${LOCAL_DIR}/nameless`, {version: '1.0.0'});
  fs.writeFileSync(path.join(appRoot, LOCAL_DIR, 'README.md'), 'a file');

  assert.deepEqual(localMembers(appRoot), [
    {name: '@x/a', version: '3.1.0', dir: 'packages-local/mm'},
    {name: '@x/b', version: '2.0.0', dir: 'packages-local/zz'},
    {name: '@x/c', version: '1.0.0', dir: 'packages-local/aa'},
  ]);
});

test('parked checkouts are their own list, not members', (t) => {
  const appRoot = consumer(t);
  dir(appRoot, `${LOCAL_DIR}/a`, {name: 'a', version: '1.0.0'});
  dir(appRoot, `${PARKED_DIR}/b`, {name: 'b', version: '2.0.0'});

  assert.deepEqual(
    localMembers(appRoot).map((m) => m.name),
    ['a'],
  );
  assert.deepEqual(parkedMembers(appRoot), [
    {name: 'b', version: '2.0.0', dir: '.packages-local.parked/b'},
  ]);
});
