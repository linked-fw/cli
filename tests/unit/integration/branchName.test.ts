/**
 * `isBranchName` agrees with `git check-ref-format --branch` over a table.
 */
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import os from 'node:os';

import {isBranchName} from '../../../src/integration/branchName.js';

const table = [
  'main',
  'change-1',
  'rene/topic',
  'feat/x/y',
  'a@b',
  '@',
  'x.lock.y',
  'a./b',
  'a/-b',
  'é',
  'v1.2',
  'HEAD',
  '-x',
  'a..b',
  'a b',
  'a\tb',
  'a\x01b',
  'a\x7fb',
  'a~b',
  'a^b',
  'a:b',
  'a?b',
  'a*b',
  'a[b',
  'a\\b',
  'a@{b',
  '@{-1}',
  '.a',
  'a/.b',
  'a.lock',
  'a/b.lock/c',
  'a/',
  '/a',
  'a//b',
  'a.',
  'a/b.',
  '',
];

describe('isBranchName', () => {
  test.each(table)('agrees with git check-ref-format --branch on %j', (name) => {
    // Run outside any repository, so `@{-1}` is not expanded against one.
    const git = spawnSync('git', ['check-ref-format', '--branch', name], {cwd: os.tmpdir()});
    assert.equal(isBranchName(name), git.status === 0, `git exit ${git.status} for ${JSON.stringify(name)}`);
  });
});
