/**
 * One lock per base clone (integration/repo-lock.ts): held around a run's git work on one repo,
 * waited for up to a bound, taken over from a dead holder, re-entered by its own process; and
 * `linked checkout`, `branch fork`, `branch push` and `branch merge` wait for it and are refused
 * when it stays held.
 */
import assert from 'node:assert/strict';
import {spawn, spawnSync, type ChildProcess} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {branchFork, branchMerge, branchPush} from '../../../src/commands/branch-fork-merge.js';
import {checkoutRemove} from '../../../src/commands/checkout.js';
import {linkedHome, REPO_LOCK_FILE, withMachineLockAsync, withRepoLock, withRepoLockAsync} from '../../../src/integration/repo-lock.js';
import {cleanup, gitEnv, setup, TOKEN} from './helpers.js';

const children: ChildProcess[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const c of children.splice(0)) c.kill();
  for (const d of dirs.splice(0)) fs.rmSync(d, {recursive: true, force: true});
  cleanup();
});

const lockIn = (dir: string) => path.join(dir, REPO_LOCK_FILE);

/** A live process holding the lock of `gitDir`, as another linked run would. */
function holdBy(gitDir: string, releaseAfterMs = 60_000): ChildProcess {
  const script = `
    const fs = require('fs');
    const file = ${JSON.stringify(lockIn(gitDir))};
    fs.writeFileSync(file, JSON.stringify({pid: process.pid, host: require('os').hostname(), at: new Date().toISOString(), what: 'linked checkout other'}), {flag: 'wx'});
    setTimeout(() => { fs.rmSync(file, {force: true}); process.exit(0); }, ${releaseAfterMs});
  `;
  const child = spawn(process.execPath, ['-e', script], {stdio: 'ignore'});
  children.push(child);
  const until = Date.now() + 5000;
  while (!fs.existsSync(lockIn(gitDir))) {
    if (Date.now() > until) throw new Error('the holder never took the lock');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
  return child;
}

function gitDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-lock-'));
  dirs.push(d);
  return d;
}

describe('withRepoLock', () => {
  test('holds the lock file while it runs and removes it after, also when fn throws', () => {
    const d = gitDir();
    const seen = withRepoLock(d, 'test', () => JSON.parse(fs.readFileSync(lockIn(d), 'utf8')));
    assert.equal(seen.pid, process.pid);
    assert.equal(seen.what, 'test');
    assert.equal(fs.existsSync(lockIn(d)), false);
    assert.throws(() => withRepoLock(d, 'test', () => { throw new Error('boom'); }), /boom/);
    assert.equal(fs.existsSync(lockIn(d)), false);
  });

  test('re-enters a lock its own process holds; released by the outermost', () => {
    const d = gitDir();
    withRepoLock(d, 'outer', () => {
      withRepoLock(d, 'inner', () => assert.ok(fs.existsSync(lockIn(d))), {timeoutMs: 100});
      assert.ok(fs.existsSync(lockIn(d)));
    });
    assert.equal(fs.existsSync(lockIn(d)), false);
  });

  test('waits for another run to release it', () => {
    const d = gitDir();
    holdBy(d, 600);
    const started = Date.now();
    withRepoLock(d, 'test', () => undefined, {timeoutMs: 10_000, pollMs: 50});
    assert.ok(Date.now() - started >= 300, `waited ${Date.now() - started} ms`);
  });

  test('is refused after the wait, naming the holder', () => {
    const d = gitDir();
    const holder = holdBy(d);
    assert.throws(
      () => withRepoLock(d, 'test', () => undefined, {timeoutMs: 300, pollMs: 50}),
      (e: Error & {code?: number}) =>
        e.code === 6 && e.message.includes(`pid ${holder.pid}`) && e.message.includes('linked checkout other'),
    );
    assert.ok(fs.existsSync(lockIn(d)), 'the holder keeps its lock');
  });

  test('takes over a lock whose holder is gone, never one from another host', () => {
    const d = gitDir();
    const dead = spawnSync(process.execPath, ['-e', '']).pid;
    const write = (host: string) =>
      fs.writeFileSync(lockIn(d), JSON.stringify({pid: dead, host, at: 'then', what: 'crashed run'}));
    write(os.hostname());
    assert.equal(withRepoLock(d, 'test', () => 'ran', {timeoutMs: 300}), 'ran');
    write('elsewhere.example');
    assert.throws(() => withRepoLock(d, 'test', () => undefined, {timeoutMs: 200, pollMs: 50}), /crashed run/);
  });
});

describe('withRepoLockAsync', () => {
  const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  test('holds the lock until fn\'s promise settles; a waiter gets it only after', async () => {
    const d = gitDir();
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const first = withRepoLockAsync(d, 'first', async () => {
      order.push('first in');
      await gate;
      assert.ok(fs.existsSync(lockIn(d)), 'held across the await');
      order.push('first out');
    });
    await tick(30);
    // Another process waits on the file; simulate it with a sync acquire in a child.
    const child = spawn(
      process.execPath,
      ['-e', `const fs=require('fs');const f=${JSON.stringify(lockIn(d))};const t=Date.now();for(;;){try{fs.writeFileSync(f,JSON.stringify({pid:process.pid,host:require('os').hostname(),at:'x',what:'child'}),{flag:'wx'});fs.rmSync(f);process.stdout.write(String(Date.now()));process.exit(0)}catch{} if(Date.now()-t>10000)process.exit(1); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20)}`],
      {stdio: ['ignore', 'pipe', 'ignore']},
    );
    children.push(child);
    let out = '';
    child.stdout!.on('data', (b) => (out += b));
    const exited = new Promise<number | null>((resolve) => child.on('exit', resolve));
    await tick(300);
    assert.equal(out, '', 'the other run is still waiting');
    const releasedAt = Date.now();
    release();
    await first;
    assert.equal(await exited, 0);
    assert.ok(Number(out) >= releasedAt, 'the other run got it after the promise settled');
    assert.deepEqual(order, ['first in', 'first out']);
    assert.equal(fs.existsSync(lockIn(d)), false);
  });

  test('two overlapping calls in one process run one after the other, also when one throws', async () => {
    const d = gitDir();
    const events: string[] = [];
    const call = (name: string, fail = false) =>
      withRepoLockAsync(d, name, async () => {
        events.push(`${name} in`);
        await tick(50);
        events.push(`${name} out`);
        if (fail) throw new Error(`${name} failed`);
        return name;
      });
    const [a, b, c] = await Promise.allSettled([call('a', true), call('b'), call('c')]);
    assert.equal(a.status, 'rejected');
    assert.deepEqual([b, c].map((r) => r.status === 'fulfilled' && r.value), ['b', 'c']);
    assert.deepEqual(events, ['a in', 'a out', 'b in', 'b out', 'c in', 'c out']);
    assert.equal(fs.existsSync(lockIn(d)), false);
  });

  test('takes over a stale holder; refuses after the wait with exit 6 naming the holder', async () => {
    const d = gitDir();
    const dead = spawnSync(process.execPath, ['-e', '']).pid;
    fs.writeFileSync(lockIn(d), JSON.stringify({pid: dead, host: os.hostname(), at: 'then', what: 'crashed run'}));
    assert.equal(await withRepoLockAsync(d, 'test', async () => 'ran', {timeoutMs: 300}), 'ran');

    const holder = holdBy(d);
    await assert.rejects(
      withRepoLockAsync(d, 'test', async () => undefined, {timeoutMs: 300, pollMs: 50}),
      (e: Error & {code?: number}) =>
        e.code === 6 && e.message.includes(`pid ${holder.pid}`) && e.message.includes('linked checkout other'),
    );
    assert.ok(fs.existsSync(lockIn(d)), 'the holder keeps its lock');
  });

  test('withMachineLockAsync locks <LINKED_HOME>/locks/<name>, made on demand', async () => {
    const home = gitDir();
    const before = process.env.LINKED_HOME;
    process.env.LINKED_HOME = path.join(home, 'home');
    try {
      assert.equal(linkedHome(), path.join(home, 'home'));
      const lockDir = path.join(home, 'home', 'locks', 'master-ports');
      const seen = await withMachineLockAsync('master-ports', 'test', async () => JSON.parse(fs.readFileSync(lockIn(lockDir), 'utf8')));
      assert.equal(seen.what, 'test');
      assert.equal(fs.existsSync(lockIn(lockDir)), false);
      assert.ok(fs.statSync(lockDir).isDirectory());
    } finally {
      process.env.LINKED_HOME = before;
    }
  });
});

describe('the commands that touch a shared base clone take its lock', () => {
  const env = {...gitEnv, LINKED_GIT_TOKEN: TOKEN};
  const lock = {timeoutMs: 300, pollMs: 50};

  test('checkout, fork, push, merge and worktree remove are refused while another run holds it', async () => {
    const {root, run} = setup();
    const co = run('change-1');
    assert.equal(co.code, 0, co.messages.join('\n'));
    const ontBase = path.join(root, '.repos', 'acme', 'acme-ont.git');
    const appBase = path.join(root, '.repos', 'acme', 'acme-app.git');
    // A run leaves no lock and no half-made clone behind.
    for (const base of fs.readdirSync(path.join(root, '.repos', 'acme'))) {
      assert.match(base, /^acme-(app|ont|assets)\.git$/);
      assert.equal(fs.existsSync(lockIn(path.join(root, '.repos', 'acme', base))), false);
    }
    const appDir = co.app!.dir;

    holdBy(ontBase);
    const again = run('change-1', {lock});
    assert.equal(again.code, 6);
    assert.match(again.messages.join('\n'), /acme-ont\.git is locked by linked checkout other/);

    const fork = await branchFork(appDir, 'change-1', 'acme-ont', {env, lock});
    assert.equal(fork.code, 6);
    assert.match(fork.messages.join('\n'), /is locked/);

    for (const c of children.splice(0)) c.kill();
    fs.rmSync(lockIn(ontBase), {force: true});
    holdBy(appBase);
    const push = await branchPush(appDir, 'change-1', {env, lock});
    assert.equal(push.code, 6);
    assert.match(push.messages.join('\n'), /acme-app\.git is locked/);
    const merge = await branchMerge(appDir, 'change-1', 'main', {env, lock});
    assert.equal(merge.code, 6);
    assert.match(merge.messages.join('\n'), /is locked/);
    const removed = checkoutRemove('change-1', {dir: appDir, force: true, env, lock});
    assert.equal(removed.code, 6);
    assert.match(removed.messages.join('\n'), /acme-app\.git is locked/);
    assert.ok(fs.existsSync(appDir), 'nothing of the app was removed');
  });

  test('a first clone is made beside its place and renamed into it', () => {
    const {root, run} = setup();
    const res = run('change-1');
    assert.equal(res.code, 0, res.messages.join('\n'));
    assert.match(res.messages.join('\n'), /base clone .*acme-ont\.git <- /);
    assert.equal(
      fs.readdirSync(path.join(root, '.repos', 'acme')).sort().join(' '),
      'acme-app.git acme-assets.git acme-ont.git',
    );
  });
});
