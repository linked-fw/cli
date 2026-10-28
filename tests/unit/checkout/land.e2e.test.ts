/**
 * `linked branch fork`, `linked branch merge` and `linked worktree remove --branch` on a
 * `linked checkout` checkout, against real git with `file://` remotes and a fake token in
 * LINKED_GIT_TOKEN: fork the fallen-back package, merge the packages then the app, remove the
 * checkout once landed.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {branchFork, branchMerge, branchPush} from '../../../src/commands/branch-fork-merge.js';
import {checkoutRemove, type CheckoutResult} from '../../../src/commands/checkout.js';
import {assertNoToken, cleanup, commitOn, git, gitEnv, setup, TOKEN} from './helpers.js';

afterEach(cleanup);

const env = {...gitEnv, LINKED_GIT_TOKEN: TOKEN};

function commitIn(dir: string, file: string, content: string): string {
  fs.writeFileSync(path.join(dir, file), content);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', `${file}`);
  git(dir, 'push', '-q');
  return git(dir, 'rev-parse', 'HEAD');
}

const dirOf = (res: CheckoutResult, name: string): string => {
  const p = res.packages.find((x) => x.name === name);
  assert.ok(p);
  return p.dir;
};

describe('linked branch fork / merge / worktree remove --branch', () => {
  test('fork the fallback, merge package by package then the app, remove once landed', async () => {
    const {r, root, run} = setup();
    const co = run('change-1');
    assert.equal(co.code, 0, co.messages.join('\n'));
    const appDir = co.app!.dir;
    const ontDir = dirOf(co, 'acme-ont');
    const assetsDir = dirOf(co, 'acme-assets');

    const fork = await branchFork(appDir, 'change-1', 'acme-ont', {env});
    console.log(JSON.stringify(fork, null, 2));
    assert.equal(fork.code, 0, fork.messages.join('\n'));
    assert.equal(fork.pushed, true);
    assert.equal(fork.from, git(r.ont, 'rev-parse', 'refs/heads/main'));
    assert.equal(git(ontDir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'change-1');
    assert.equal(git(r.ont, 'rev-parse', 'refs/heads/change-1'), fork.from);
    // Idempotent.
    const again = await branchFork(appDir, 'change-1', 'acme-ont', {env});
    assert.deepEqual({code: again.code, pushed: again.pushed}, {code: 0, pushed: false});

    commitIn(ontDir, 'class.ttl', '# a class\n');
    commitIn(assetsDir, 'asset.txt', 'an asset\n');
    commitIn(appDir, 'app.txt', 'app change\n');

    const early = checkoutRemove('change-1', {dir: appDir, env, cwd: root});
    assert.equal(early.code, 6);
    assert.deepEqual(early.removed, []);
    assert.equal(early.kept.length, 3);
    assert.ok(fs.existsSync(ontDir));

    const merge = await branchMerge(appDir, 'change-1', 'main', {env});
    console.log(JSON.stringify(merge, null, 2));
    assert.equal(merge.code, 0, merge.messages.join('\n'));
    assert.deepEqual(
      merge.repos.map((x) => [x.name, x.result, x.landed]),
      [
        ['acme-ont', 'merged', true],
        ['acme-assets', 'merged', true],
        ['acme-app', 'merged', true],
      ],
    );
    for (const [remote, entry] of [
      [r.ont, merge.repos[0]],
      [r.assets, merge.repos[1]],
      [r.app, merge.repos[2]],
    ] as const) {
      assert.equal(git(remote, 'rev-parse', 'refs/heads/main'), entry.sha);
      assert.equal(git(remote, 'log', '-1', '--format=%s', 'main'), "Merge branch 'change-1' into main");
      assert.equal(git(remote, 'rev-list', '--parents', '-n', '1', 'main').split(' ').length, 3);
      assert.equal(entry.repo, `file://${remote}`);
    }
    // The checkout stays on the branch; the temporary worktrees are gone.
    assert.equal(git(appDir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'change-1');
    assert.equal(git(appDir, 'worktree', 'list').split('\n').length, 2);

    const removed = checkoutRemove('change-1', {env, cwd: appDir});
    console.log(JSON.stringify(removed, null, 2));
    assert.equal(removed.code, 0, removed.messages.join('\n'));
    assert.deepEqual(removed.removed, [assetsDir, ontDir, appDir]);
    assert.ok(!fs.existsSync(appDir));
    assert.ok(removed.branches.every((b) => b.deleted && b.branch === 'change-1'));
    assert.ok(fs.existsSync(path.join(root, '.repos', 'acme', 'acme-app.git')));
    assert.equal(git(path.join(root, '.repos', 'acme', 'acme-app.git'), 'branch', '--list'), '');
    assertNoToken(root);
  });

  test('a conflict stops at the first repo; later repos are skipped, the remotes untouched', async () => {
    const {r, run} = setup();
    const co = run('change-1');
    const appDir = co.app!.dir;
    commitIn(dirOf(co, 'acme-assets'), 'same.txt', 'branch side\n');
    commitIn(appDir, 'app.txt', 'app change\n');
    commitOn(r.base, r.assets, 'main', 'same.txt', 'main side\n');
    const appMain = git(r.app, 'rev-parse', 'refs/heads/main');

    const merge = await branchMerge(appDir, 'change-1', 'main', {env});
    assert.equal(merge.code, 6);
    // The fallen-back ontology package is not on the branch: not part of the merge.
    assert.deepEqual(merge.repos.map((x) => [x.name, x.result]), [
      ['acme-assets', 'conflict'],
      ['acme-app', 'skipped'],
    ]);
    assert.deepEqual(merge.repos[0].files, ['same.txt']);
    assert.equal(git(r.app, 'rev-parse', 'refs/heads/main'), appMain);
    assert.equal(git(appDir, 'worktree', 'list').split('\n').length, 2);
  });

  test('branch push pushes the app and the packages on the branch; a diverged repo is refused, never forced', async () => {
    const {r, root, run} = setup();
    const co = run('change-1');
    const appDir = co.app!.dir;
    const ontDir = dirOf(co, 'acme-ont');
    const assetsDir = dirOf(co, 'acme-assets');
    // The ontology package stays detached (a fallback): push leaves it alone.
    const local = (dir: string, file: string): string => {
      fs.writeFileSync(path.join(dir, file), `${file}\n`);
      git(dir, 'add', '-A');
      git(dir, 'commit', '-q', '-m', file);
      return git(dir, 'rev-parse', 'HEAD');
    };
    const appSha = local(appDir, 'app.txt');
    const assetsSha = local(assetsDir, 'asset.txt');
    fs.writeFileSync(path.join(appDir, 'uncommitted.txt'), 'stays\n');

    const pushed = await branchPush(appDir, 'change-1', {env});
    console.log(JSON.stringify(pushed, null, 2));
    assert.equal(pushed.code, 0, pushed.messages.join('\n'));
    assert.deepEqual(
      pushed.repos.map((x) => [x.name, x.result, x.sha]),
      [
        ['acme-app', 'pushed', appSha],
        ['acme-assets', 'pushed', assetsSha],
      ],
    );
    assert.equal(git(r.app, 'rev-parse', 'refs/heads/change-1'), appSha);
    assert.equal(git(r.assets, 'rev-parse', 'refs/heads/change-1'), assetsSha);
    assert.ok(fs.existsSync(path.join(appDir, 'uncommitted.txt')));
    assert.equal(git(ontDir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'HEAD');

    const again = await branchPush(appDir, 'change-1', {env});
    assert.equal(again.code, 0);
    assert.deepEqual(again.repos.map((x) => x.result), ['up-to-date', 'up-to-date']);

    // Someone else moved the app's branch: the app is refused, the asset package still pushes.
    const theirs = commitOn(r.base, r.app, 'change-1', 'theirs.txt', 'elsewhere\n');
    local(appDir, 'mine.txt');
    const assetsNext = local(assetsDir, 'asset2.txt');
    const diverged = await branchPush(appDir, 'change-1', {env});
    assert.equal(diverged.code, 6);
    assert.deepEqual(diverged.repos.map((x) => x.result), ['refused', 'pushed']);
    assert.match(diverged.messages.join('\n'), /acme-app: change-1 has diverged/);
    assert.equal(git(r.app, 'rev-parse', 'refs/heads/change-1'), theirs);
    assert.equal(git(r.assets, 'rev-parse', 'refs/heads/change-1'), assetsNext);

    const wrong = await branchPush(appDir, 'change-2', {env});
    assert.equal(wrong.code, 6);
    assertNoToken(root);
  });

  test('a protected default branch refuses the push; --mode update pushes the branch instead', async () => {
    const {r, run} = setup();
    const co = run('change-1');
    const appDir = co.app!.dir;
    const assetsDir = dirOf(co, 'acme-assets');
    commitIn(assetsDir, 'asset.txt', 'an asset\n');
    commitIn(appDir, 'app.txt', 'app change\n');
    commitOn(r.base, r.assets, 'main', 'elsewhere.txt', 'main moved on\n');
    // main is protected on both remotes.
    for (const remote of [r.assets, r.app]) {
      const hook = path.join(remote, 'hooks', 'pre-receive');
      fs.writeFileSync(hook, '#!/bin/sh\nwhile read old new ref; do [ "$ref" = refs/heads/main ] && { echo "main is protected" >&2; exit 1; }; done\nexit 0\n');
      fs.chmodSync(hook, 0o755);
    }

    const pushed = await branchMerge(appDir, 'change-1', 'main', {env});
    assert.equal(pushed.code, 6);
    assert.equal(pushed.repos[0].result, 'push-refused');
    assert.match(pushed.messages.join('\n'), /--mode update/);

    const update = await branchMerge(appDir, 'change-1', 'main', {mode: 'update', env});
    console.log(JSON.stringify(update, null, 2));
    assert.equal(update.code, 0, update.messages.join('\n'));
    assert.deepEqual(update.repos.map((x) => [x.name, x.result, x.landed]), [
      ['acme-assets', 'merged', false],
      ['acme-app', 'up-to-date', false],
    ]);
    // The asset branch now contains main, so its PR merges cleanly; main itself is untouched.
    assert.equal(git(r.assets, 'rev-parse', 'refs/heads/change-1'), update.repos[0].sha);
    assert.equal(git(r.assets, 'merge-base', '--is-ancestor', 'main', 'change-1'), '');
    assert.equal(git(assetsDir, 'log', '-1', '--format=%s'), "Merge branch 'main' into change-1");
  });

  test('fork refuses a dirty checkout, and a branch origin has while the checkout is elsewhere', async () => {
    const {r, run} = setup();
    const co = run('change-1');
    const appDir = co.app!.dir;
    const ontDir = dirOf(co, 'acme-ont');
    fs.writeFileSync(path.join(ontDir, 'wip.ttl'), '# wip\n');
    assert.equal((await branchFork(appDir, 'change-1', 'acme-ont', {env})).code, 6);
    fs.rmSync(path.join(ontDir, 'wip.ttl'));
    commitOn(r.base, r.ont, 'change-1', 'x.ttl', '# made elsewhere\n');
    const res = await branchFork(appDir, 'change-1', 'acme-ont', {env});
    assert.equal(res.code, 6);
    assert.match(res.messages.join('\n'), /linked checkout change-1. switches/);
    assert.equal((await branchFork(appDir, 'change-1', 'nope', {env})).code, 2);
  });

  test('worktree remove --branch --force removes an unlanded checkout and keeps its branch', () => {
    const {root, run} = setup();
    const co = run('change-1');
    const appDir = co.app!.dir;
    commitIn(appDir, 'app.txt', 'never merged\n');
    const res = checkoutRemove('change-1', {dir: appDir, force: true, env, cwd: root});
    assert.equal(res.code, 0, res.messages.join('\n'));
    assert.ok(!fs.existsSync(appDir));
    const app = res.branches.find((b) => b.repo.endsWith('acme-app.git'));
    assert.equal(app?.deleted, false);
    assert.match(res.messages.join('\n'), /kept change-1 at/);
  });

  test('no git hook sees the token on a push, even one the app registered in core.hooksPath', async () => {
    const {root, run} = setup();
    const co = run('change-1');
    const appDir = co.app!.dir;
    // What husky's `prepare` does: a hooks directory of the app's own, in the base clone's config.
    const hooks = path.join(root, 'app-hooks');
    const seen = path.join(root, 'hook-saw-token');
    fs.mkdirSync(hooks);
    fs.writeFileSync(path.join(hooks, 'pre-push'), `#!/bin/sh\necho "$LINKED_GIT_TOKEN" >> '${seen}'\nexit 0\n`);
    fs.chmodSync(path.join(hooks, 'pre-push'), 0o755);
    git(appDir, 'config', 'core.hooksPath', hooks);
    // The hook does run for a push without the cli's token.
    git(appDir, 'push', '-q', 'origin', 'change-1:probe');
    assert.equal(fs.readFileSync(seen, 'utf8').trim(), '');
    fs.rmSync(seen);
    fs.writeFileSync(path.join(appDir, 'app.txt'), 'x\n');
    git(appDir, 'add', '-A');
    git(appDir, 'commit', '-q', '-m', 'x');
    git(appDir, 'push', '-q', '--no-verify');
    const merge = await branchMerge(appDir, 'change-1', 'main', {env, mode: 'update'});
    assert.equal(merge.code, 0, merge.messages.join('\n'));
    const fork = await branchFork(appDir, 'change-2', 'acme-ont', {env});
    assert.equal(fork.code, 0, fork.messages.join('\n'));
    assert.ok(!fs.existsSync(seen), 'a hook ran during a push with the token');
  });

  test('worktree remove --branch refuses, even with --force, while packages-local/ holds something else', () => {
    const {r, run} = setup();
    const co = run('change-1');
    const appDir = co.app!.dir;
    const clone = path.join(appDir, 'packages-local', 'hand-made');
    git(appDir, 'clone', '-q', r.url(r.ont), clone);
    fs.writeFileSync(path.join(clone, 'unsaved.ttl'), '# work\n');
    const res = checkoutRemove('change-1', {dir: appDir, force: true, env});
    assert.equal(res.code, 6);
    assert.deepEqual(res.removed, []);
    assert.ok(fs.existsSync(path.join(clone, 'unsaved.ttl')));
    assert.match(res.messages.join('\n'), /not a package worktree of this checkout/);
  });
});
