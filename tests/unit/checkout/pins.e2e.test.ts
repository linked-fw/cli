/**
 * `linked checkout --pin / --pins-only`, `linked branch fork --worktree` and `linked branch push
 * --worktree` against real git with `file://` remotes (helpers.ts): a pinned package follows its
 * pin (attached, or detached while another worktree holds the branch), `--pins-only` drops the
 * same-name rule, a changed pin moves a clean worktree, and a working branch lives in a worktree of
 * its own outside every app checkout.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {branchFork, branchPush} from '../../../src/commands/branch-fork-merge.js';
import {parsePins, type CheckoutResult} from '../../../src/commands/checkout.js';
import {assertNoToken, cleanup, commitOn, git, gitEnv, keyAppBranch, setup, TOKEN} from './helpers.js';

afterEach(cleanup);

const env = {...gitEnv, LINKED_GIT_TOKEN: TOKEN};
const byName = (res: CheckoutResult, name: string) => {
  const p = res.packages.find((x) => x.name === name);
  assert.ok(p, `${name} in ${JSON.stringify(res.packages.map((x) => x.name))}`);
  return p;
};
const where = (p: CheckoutResult['packages'][number]) => ({
  branch: p.branch,
  detached: p.detached,
  fellBack: p.fellBack,
  pin: p.pin,
  status: p.status,
});

describe('linked checkout --pin / --pins-only', () => {
  test("a pin to another branch is followed detached; --pins-only drops the same-name rule", () => {
    const {r, root, run} = setup();
    const pinned = commitOn(r.base, r.ont, 'u1/edits', 'work.ttl', '# working\n');
    const res = run('change-1', {pins: {'acme-ont': 'u1/edits'}, pinsOnly: true});
    console.log(JSON.stringify(res.packages, null, 2));
    assert.equal(res.code, 0, res.messages.join('\n'));
    const ont = byName(res, 'acme-ont');
    // Written elsewhere (its own worktree): the checkout only reads it.
    assert.deepEqual(where(ont), {branch: 'u1/edits', detached: true, fellBack: false, pin: 'u1/edits', status: 'created'});
    assert.equal(ont.head, pinned);
    // acme-assets has change-1 on origin, but --pins-only sits it at origin/main.
    assert.deepEqual(where(byName(res, 'acme-assets')), {branch: 'main', detached: true, fellBack: true, pin: undefined, status: 'created'});
    assertNoToken(root);
  });

  test('pinned checkouts stay detached, fast-forward, and move when the pin goes; a pin to the run branch attaches', () => {
    const {r, run} = setup();
    commitOn(r.base, r.ont, 'u1/edits', 'work.ttl', '# working\n');
    const pins = {'acme-ont': 'u1/edits'};
    const a = run('change-1', {pins, pinsOnly: true});
    assert.equal(a.code, 0, a.messages.join('\n'));
    assert.equal(byName(a, 'acme-ont').detached, true);
    const b = run('change-2', {pins, pinsOnly: true});
    assert.equal(b.code, 0, b.messages.join('\n'));
    assert.deepEqual(where(byName(b, 'acme-ont')), {branch: 'u1/edits', detached: true, fellBack: false, pin: 'u1/edits', status: 'created'});

    const next = commitOn(r.base, r.ont, 'u1/edits', 'more.ttl', '# more\n');
    const b2 = byName(run('change-2', {pins, pinsOnly: true}), 'acme-ont');
    assert.deepEqual({status: b2.status, detached: b2.detached, head: b2.head}, {status: 'updated', detached: true, head: next});
    const a2 = byName(run('change-1', {pins, pinsOnly: true}), 'acme-ont');
    assert.deepEqual({status: a2.status, detached: a2.detached, head: a2.head}, {status: 'updated', detached: true, head: next});

    // change-1 loses its pin: its clean worktree moves to origin/main.
    const unpinned = byName(run('change-1', {pinsOnly: true}), 'acme-ont');
    assert.deepEqual(where(unpinned), {branch: 'main', detached: true, fellBack: true, pin: undefined, status: 'updated'});
    assert.equal(unpinned.head, git(r.ont, 'rev-parse', 'refs/heads/main'));
    // A pin to the run's own branch (a fork of its name) is written here: attached.
    commitOn(r.base, r.ont, 'change-2', 'fork.ttl', '# fork\n');
    const own = byName(run('change-2', {pins: {'acme-ont': 'change-2'}, pinsOnly: true}), 'acme-ont');
    assert.deepEqual(where(own), {branch: 'change-2', detached: false, fellBack: false, pin: 'change-2', status: 'switched'});
  });

  test('a worktree with commits origin lacks is kept when its pin changes', () => {
    const {r, run} = setup();
    commitOn(r.base, r.ont, 'u1/edits', 'work.ttl', '# working\n');
    const res = run('change-1', {pins: {'acme-ont': 'u1/edits'}, pinsOnly: true});
    const dir = byName(res, 'acme-ont').dir;
    fs.writeFileSync(path.join(dir, 'local.ttl'), '# local\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'local');
    const kept = byName(run('change-1', {pinsOnly: true}), 'acme-ont');
    assert.equal(kept.status, 'kept');
    assert.match(kept.reason ?? '', /lacks/);
    assert.ok(kept.reason?.startsWith(dir), kept.reason);
    assert.equal(git(dir, 'log', '-1', '--format=%s'), 'local');
  });

  test('a worktree with uncommitted changes is refused, named, when its pin changes; once clean it moves', () => {
    const {r, run} = setup();
    commitOn(r.base, r.ont, 'u1/edits', 'work.ttl', '# working\n');
    const dir = byName(run('change-1', {pins: {'acme-ont': 'u1/edits'}, pinsOnly: true}), 'acme-ont').dir;
    const before = git(dir, 'rev-parse', 'HEAD');
    fs.writeFileSync(path.join(dir, 'pending.ttl'), '# pending\n');
    const res = run('change-1', {pinsOnly: true});
    const kept = byName(res, 'acme-ont');
    assert.equal(kept.status, 'kept');
    assert.match(kept.reason ?? '', /uncommitted changes/);
    assert.ok(kept.reason?.startsWith(dir), kept.reason);
    assert.ok(res.messages.some((m) => m.includes(dir) && m.includes('not moved')), res.messages.join('\n'));
    assert.equal(git(dir, 'rev-parse', 'HEAD'), before);
    fs.rmSync(path.join(dir, 'pending.ttl'));
    const moved = byName(run('change-1', {pinsOnly: true}), 'acme-ont');
    assert.equal(moved.status, 'updated');
    assert.equal(moved.head, git(r.ont, 'rev-parse', 'refs/heads/main'));
  });

  test('a pin whose branch origin lacks falls back to the default branch, with a message', () => {
    const {run} = setup();
    const res = run('change-1', {pins: {'acme-ont': 'u9/gone'}, pinsOnly: true});
    assert.equal(res.code, 0, res.messages.join('\n'));
    assert.deepEqual(where(byName(res, 'acme-ont')), {branch: 'main', detached: true, fellBack: true, pin: 'u9/gone', status: 'created'});
    assert.ok(res.messages.some((m) => /u9\/gone is not on origin/.test(m)), res.messages.join('\n'));
  });

  test('without --pin and --pins-only the same-name rule holds', () => {
    const {run} = setup();
    const res = run('change-1');
    assert.deepEqual(where(byName(res, 'acme-assets')), {branch: 'change-1', detached: false, fellBack: false, pin: undefined, status: 'created'});
  });

  test('parsePins reads <npm>=<branch> and refuses the rest', () => {
    assert.deepEqual(parsePins(['@acme/ont=u1/edits', 'acme-assets=x']), {'@acme/ont': 'u1/edits', 'acme-assets': 'x'});
    assert.throws(() => parsePins(['acme-ont']), /<npm name>=<branch>/);
    assert.throws(() => parsePins(['acme-ont=a', 'acme-ont=b']), /twice/);
  });
});

describe("the app list's branch keys", () => {
  test('a key places the package as a pin (read-only on another branch); --pins-only keeps the others on the default', () => {
    const {r, run} = setup();
    const pinned = commitOn(r.base, r.ont, 'rene/topic', 'topic.ttl', '# topic\n');
    keyAppBranch(r, 'change-1', {'acme-ont': 'rene/topic'});
    const res = run('change-1', {pinsOnly: true});
    assert.equal(res.code, 0, res.messages.join('\n'));
    const ont = byName(res, 'acme-ont');
    assert.deepEqual(where(ont), {branch: 'rene/topic', detached: true, fellBack: false, pin: 'rene/topic', status: 'created'});
    assert.equal(ont.pinFrom, 'key');
    assert.equal(ont.head, pinned);
    assert.deepEqual(where(byName(res, 'acme-assets')), {branch: 'main', detached: true, fellBack: true, pin: undefined, status: 'created'});
    assert.equal(byName(res, 'acme-assets').pinFrom, undefined);
  });

  test('without --pins-only a key is a pin as a --pin is: the unkeyed packages keep the same-name rule', () => {
    const {r, run} = setup();
    commitOn(r.base, r.ont, 'rene/topic', 'topic.ttl', '# topic\n');
    keyAppBranch(r, 'change-1', {'acme-ont': 'rene/topic'});
    const res = run('change-1');
    assert.equal(res.code, 0, res.messages.join('\n'));
    assert.deepEqual(where(byName(res, 'acme-ont')), {branch: 'rene/topic', detached: true, fellBack: false, pin: 'rene/topic', status: 'created'});
    assert.deepEqual(where(byName(res, 'acme-assets')), {branch: 'change-1', detached: false, fellBack: false, pin: undefined, status: 'created'});
  });

  test('an explicit --pin overrides a key, and says so', () => {
    const {r, run} = setup();
    commitOn(r.base, r.ont, 'rene/topic', 'topic.ttl', '# topic\n');
    keyAppBranch(r, 'change-1', {'acme-ont': 'rene/topic'});
    const res = run('change-1', {pins: {'acme-ont': 'main'}, pinsOnly: true});
    assert.equal(res.code, 0, res.messages.join('\n'));
    const ont = byName(res, 'acme-ont');
    assert.deepEqual(where(ont), {branch: 'main', detached: true, fellBack: false, pin: 'main', status: 'created'});
    assert.equal(ont.pinFrom, 'flag');
    assert.ok(
      res.messages.includes("pin acme-ont=main from --pin overrides the app's branch key rene/topic."),
      res.messages.join('\n'),
    );
  });

  test('a clean pinned worktree moves when the pin changes, even backwards (its head is on origin)', () => {
    const {r, run} = setup();
    commitOn(r.base, r.ont, 'rene/topic', 'topic.ttl', '# topic\n');
    keyAppBranch(r, 'change-1', {'acme-ont': 'rene/topic'});
    assert.equal(byName(run('change-1', {pinsOnly: true}), 'acme-ont').branch, 'rene/topic');
    const flag = byName(run('change-1', {pins: {'acme-ont': 'main'}, pinsOnly: true}), 'acme-ont');
    assert.deepEqual(where(flag), {branch: 'main', detached: true, fellBack: false, pin: 'main', status: 'updated'});
    assert.equal(flag.head, git(r.ont, 'rev-parse', 'refs/heads/main'));
    const back = byName(run('change-1', {pinsOnly: true}), 'acme-ont');
    assert.deepEqual(where(back), {branch: 'rene/topic', detached: true, fellBack: false, pin: 'rene/topic', status: 'updated'});
  });

  test('a key to a branch origin lacks: a message, detached on the default', () => {
    const {r, run} = setup();
    keyAppBranch(r, 'change-1', {'acme-ont': 'u9/gone'});
    const res = run('change-1', {pinsOnly: true});
    assert.equal(res.code, 0, res.messages.join('\n'));
    assert.deepEqual(where(byName(res, 'acme-ont')), {branch: 'main', detached: true, fellBack: true, pin: 'u9/gone', status: 'created'});
    assert.ok(res.messages.some((m) => /u9\/gone is not on origin/.test(m)), res.messages.join('\n'));
  });

  test('a same-name key is a pin on the run branch: writable', () => {
    const {r, run} = setup();
    keyAppBranch(r, 'change-1', {'acme-assets': 'change-1'});
    const res = run('change-1', {pinsOnly: true});
    assert.equal(res.code, 0, res.messages.join('\n'));
    const assets = byName(res, 'acme-assets');
    assert.deepEqual(where(assets), {branch: 'change-1', detached: false, fellBack: false, pin: 'change-1', status: 'created'});
    assert.equal(assets.pinFrom, 'key');
  });
});

describe('linked branch fork --worktree / push --worktree', () => {
  test('a working branch in a worktree of its own, from origin/HEAD, outside the app checkout', async () => {
    const {r, root, run} = setup();
    const co = run('change-1', {pinsOnly: true});
    assert.equal(co.code, 0, co.messages.join('\n'));
    const appDir = co.app!.dir;
    const appOnt = byName(co, 'acme-ont');
    const dir = path.join(root, '.ontology-work', 'acme', 'acme-ont', 'u2', 'packages-local', 'acme-ont');

    const fork = await branchFork(appDir, 'u2/edits', 'acme-ont', {env, worktree: dir, from: 'origin/HEAD'});
    console.log(JSON.stringify(fork, null, 2));
    assert.equal(fork.code, 0, fork.messages.join('\n'));
    assert.deepEqual({dir: fork.dir, pushed: fork.pushed}, {dir, pushed: true});
    assert.equal(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'u2/edits');
    assert.equal(git(r.ont, 'rev-parse', 'refs/heads/u2/edits'), git(r.ont, 'rev-parse', 'refs/heads/main'));
    assert.equal(git(dir, 'rev-parse', '--abbrev-ref', '@{upstream}'), 'origin/u2/edits');
    // The app checkout's package worktree did not move.
    assert.equal(git(appOnt.dir, 'rev-parse', 'HEAD'), appOnt.head);
    assert.throws(() => git(appOnt.dir, 'symbolic-ref', '-q', 'HEAD'));

    const again = await branchFork(appDir, 'u2/edits', 'acme-ont', {env, worktree: dir});
    assert.deepEqual({code: again.code, pushed: again.pushed}, {code: 0, pushed: false});

    fs.writeFileSync(path.join(dir, 'class.ttl'), '# a class\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'a class');
    const push = await branchPush(dir, 'u2/edits', {env, worktree: dir});
    console.log(JSON.stringify(push, null, 2));
    assert.equal(push.code, 0, push.messages.join('\n'));
    assert.deepEqual(push.repos.map((x) => [x.name, x.result]), [['acme-ont', 'pushed']]);
    assert.equal(git(r.ont, 'rev-parse', 'refs/heads/u2/edits'), git(dir, 'rev-parse', 'HEAD'));
    const idle = await branchPush(dir, 'u2/edits', {env, worktree: dir});
    assert.deepEqual(idle.repos.map((x) => x.result), ['up-to-date']);

    // The branch is held by that worktree: another one is refused.
    const twice = await branchFork(appDir, 'u2/edits', 'acme-ont', {env, worktree: path.join(root, 'elsewhere')});
    assert.equal(twice.code, 6);
    assert.match(twice.messages.join('\n'), /checked out in/);
    // A worktree on another branch is refused for this one.
    const wrong = await branchPush(dir, 'u3/other', {env, worktree: dir});
    assert.equal(wrong.code, 6);
    assertNoToken(root);
  });

  test('a pinned checkout never holds the branch; a deleted working worktree is pruned and made again', async () => {
    const {r, root, run} = setup();
    commitOn(r.base, r.ont, 'u1/edits', 'work.ttl', '# working\n');
    const co = run('change-1', {pins: {'acme-ont': 'u1/edits'}, pinsOnly: true});
    const appOnt = byName(co, 'acme-ont');
    assert.equal(appOnt.detached, true);
    const dir = path.join(root, 'work', 'u1', 'packages-local', 'acme-ont');
    const fork = await branchFork(co.app!.dir, 'u1/edits', 'acme-ont', {env, worktree: dir});
    assert.equal(fork.code, 0, fork.messages.join('\n'));
    assert.equal(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'u1/edits');
    // The checkout's re-run stays detached.
    assert.equal(byName(run('change-1', {pins: {'acme-ont': 'u1/edits'}, pinsOnly: true}), 'acme-ont').detached, true);

    // Its directory deleted behind git's back, and origin moved on: made again, fast-forwarded.
    fs.rmSync(path.join(root, 'work'), {recursive: true, force: true});
    const tip = commitOn(r.base, r.ont, 'u1/edits', 'more.ttl', '# more\n');
    const again = await branchFork(co.app!.dir, 'u1/edits', 'acme-ont', {env, worktree: dir});
    assert.equal(again.code, 0, again.messages.join('\n'));
    assert.equal(git(dir, 'rev-parse', 'HEAD'), tip);
    // An option-like --from is refused.
    const bad = await branchFork(co.app!.dir, 'u7/edits', 'acme-ont', {env, worktree: path.join(root, 'w7'), from: '--upload-pack=x'});
    assert.equal(bad.code, 2);
  });

  test('a branch origin has already is checked out tracking it', async () => {
    const {r, root, run} = setup();
    const tip = commitOn(r.base, r.ont, 'u1/edits', 'work.ttl', '# working\n');
    const co = run('change-1', {pinsOnly: true});
    const dir = path.join(root, 'work', 'u1');
    const fork = await branchFork(co.app!.dir, 'u1/edits', 'acme-ont', {env, worktree: dir});
    assert.equal(fork.code, 0, fork.messages.join('\n'));
    assert.deepEqual({pushed: fork.pushed, from: fork.from}, {pushed: false, from: tip});
    assert.equal(git(dir, 'rev-parse', '--abbrev-ref', '@{upstream}'), 'origin/u1/edits');
  });
});
