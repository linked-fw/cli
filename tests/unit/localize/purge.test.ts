/**
 * `delocalize --purge` against real git: it deletes a checkout only when git
 * says its work is saved elsewhere, and refuses (exit 6) whenever it cannot
 * tell -- no `.git`, a git that fails -- or the work is not: uncommitted
 * changes, a commit on any branch no remote has, a stash. `--force` deletes
 * anyway. npm is stubbed; git is not.
 */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import {delocalize} from '../../../src/localize/delocalize.js';
import {makeRun} from '../../../src/localize/run.js';
import {makeConsumer, rm, test, tmpdir} from './helpers.js';

const gitEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'purge tests',
  GIT_AUTHOR_EMAIL: 'tests@localize.invalid',
  GIT_COMMITTER_NAME: 'purge tests',
  GIT_COMMITTER_EMAIL: 'tests@localize.invalid',
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, {cwd, encoding: 'utf8', env: gitEnv, stdio: 'pipe'});

/** Deps with real git (in `env`) and npm stubbed out. */
function deps(appRoot: string, env: NodeJS.ProcessEnv = gitEnv) {
  const real = makeRun(appRoot);
  const out: string[] = [];
  return {
    appRoot,
    run: (cmd: string, args: string[], opts = {}) =>
      cmd === 'npm'
        ? {status: 0, stdout: '', stderr: ''}
        : real(cmd, args, {...opts, env}),
    log: (m: string) => out.push(m),
    warn: (m: string) => out.push(m),
    error: (m: string) => out.push(m),
    output: () => out.join('\n'),
  };
}

/**
 * An app with `packages-local/x-a`: a clone of a bare origin, everything
 * pushed, on `main`. The state a purge may delete.
 */
function pushedCheckout(t) {
  const scratch = tmpdir('localize-purge-');
  const appRoot = makeConsumer();
  t.after(() => {
    rm(scratch);
    rm(appRoot);
  });
  const origin = path.join(scratch, 'origin.git');
  git(scratch, 'init', '-q', '--bare', '-b', 'main', origin);
  const checkout = path.join(appRoot, 'packages-local', 'x-a');
  git(scratch, 'clone', '-q', origin, checkout);
  fs.writeFileSync(
    path.join(checkout, 'package.json'),
    JSON.stringify({name: '@x/a', version: '1.0.0'}),
  );
  git(checkout, 'checkout', '-q', '-b', 'main');
  git(checkout, 'add', '-A');
  git(checkout, 'commit', '-q', '-m', 'init');
  git(checkout, 'push', '-q', '-u', 'origin', 'main');
  return {appRoot, checkout, scratch};
}

function refuses(appRoot: string, checkout: string, reason: RegExp, d = deps(appRoot)) {
  assert.equal(delocalize(['@x/a'], {purge: true}, d), 6, d.output());
  assert.match(d.output(), /not deleting/);
  assert.match(d.output(), reason);
  assert.ok(fs.existsSync(path.join(checkout, 'package.json')), 'kept');
}

test('everything pushed: --purge deletes', (t) => {
  const {appRoot, checkout} = pushedCheckout(t);
  const d = deps(appRoot);
  assert.equal(delocalize(['@x/a'], {purge: true}, d), 0, d.output());
  assert.equal(fs.existsSync(checkout), false);
});

test('no .git: refused, and --force deletes', (t) => {
  const {appRoot, checkout} = pushedCheckout(t);
  rm(path.join(checkout, '.git'));
  refuses(appRoot, checkout, /not a git checkout/);
  assert.equal(delocalize(['@x/a'], {purge: true, force: true}, deps(appRoot)), 0);
  assert.equal(fs.existsSync(checkout), false);
});

test('a git that fails: refused, never read as "nothing unsaved"', (t) => {
  const {appRoot, checkout, scratch} = pushedCheckout(t);
  const bin = path.join(scratch, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'git'), '#!/bin/sh\necho "fatal: broken" >&2\nexit 128\n');
  fs.chmodSync(path.join(bin, 'git'), 0o755);
  const broken = deps(appRoot, {...gitEnv, PATH: `${bin}${path.delimiter}${process.env.PATH}`});
  refuses(appRoot, checkout, /`git status --porcelain` failed \(fatal: broken\)/, broken);
});

test('uncommitted changes: refused', (t) => {
  const {appRoot, checkout} = pushedCheckout(t);
  fs.writeFileSync(path.join(checkout, 'wip.txt'), 'x');
  refuses(appRoot, checkout, /1 uncommitted change\b/);
});

test('a commit on another branch that no remote has: refused, though main is pushed', (t) => {
  const {appRoot, checkout} = pushedCheckout(t);
  git(checkout, 'checkout', '-q', '-b', 'wip');
  fs.writeFileSync(path.join(checkout, 'wip.txt'), 'x');
  git(checkout, 'add', '-A');
  git(checkout, 'commit', '-q', '-m', 'wip');
  git(checkout, 'checkout', '-q', 'main');
  refuses(appRoot, checkout, /1 commit on a branch no remote has/);
});

test('a stash: refused, and --force deletes', (t) => {
  const {appRoot, checkout} = pushedCheckout(t);
  fs.writeFileSync(path.join(checkout, 'package.json'), '{"name": "@x/a", "version": "1.0.1"}');
  git(checkout, 'stash', '-q');
  refuses(appRoot, checkout, /1 stash entry/);
  const d = deps(appRoot);
  assert.equal(delocalize(['@x/a'], {purge: true, force: true}, d), 0, d.output());
  assert.match(d.output(), /--force: deleting packages-local\/x-a although it has 1 stash entry/);
  assert.equal(fs.existsSync(checkout), false);
});
