/**
 * `linked checkout` end to end against real git, no network: bare "remote" repos under a temp
 * dir (`file://`), an app listing an ontology and an asset package, the asset package listing the
 * ontology package, only the asset repo with `change-1`. A fake token sits in LINKED_GIT_TOKEN
 * throughout; the last assertion of each case is that no config under the root holds it.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {type CheckoutResult} from '../../../src/commands/checkout.js';
import {scrubbedNpmEnv} from '../localize/helpers.js';
import {assertNoToken, cleanup, commitOn, git, gitEnv, makeRemote, setup, TOKEN} from './helpers.js';

afterEach(cleanup);

const byName = (res: CheckoutResult, name: string) => {
  const p = res.packages.find((x) => x.name === name);
  assert.ok(p, `${name} in ${JSON.stringify(res.packages.map((x) => x.name))}`);
  return p;
};

describe('linked checkout', () => {
  test('makes the app worktree, the package worktrees (one fell back) and reports it', () => {
    const {r, root, run} = setup();
    const res = run('change-1');
    // The JSON the report quotes.
    console.log(JSON.stringify(res, null, 2));
    assert.equal(res.code, 0, res.messages.join('\n'));
    const appDir = path.join(root, 'acme-app', 'change-1');
    assert.equal(res.app?.dir, appDir);
    assert.equal(res.app?.name, 'acme-app');
    assert.equal(res.app?.created, true);
    assert.equal(res.app?.status, 'created');
    // The new app branch is on the remote.
    assert.equal(git(r.app, 'rev-parse', 'refs/heads/change-1'), res.app?.head);

    const ont = byName(res, 'acme-ont');
    assert.deepEqual(
      {branch: ont.branch, detached: ont.detached, fellBack: ont.fellBack, status: ont.status, requiredBy: ont.requiredBy},
      {branch: 'main', detached: true, fellBack: true, status: 'created', requiredBy: ['acme-app', 'acme-assets']},
    );
    assert.equal(ont.dir, path.join(appDir, 'packages-local', 'acme-ont'));
    const assets = byName(res, 'acme-assets');
    assert.deepEqual(
      {branch: assets.branch, detached: assets.detached, fellBack: assets.fellBack, status: assets.status},
      {branch: 'change-1', detached: false, fellBack: false, status: 'created'},
    );
    assert.equal(git(assets.dir, 'rev-parse', '--abbrev-ref', '@{upstream}'), 'origin/change-1');
    assert.ok(fs.existsSync(path.join(root, '.repos', 'acme', 'acme-ont.git')));
    assert.deepEqual(res.install, {ran: false, ok: true});
    // The localize hooks sit in the app's base clone, so every worktree of it runs them.
    const hooksPath = (() => {
      try {
        return git(root, 'config', '--global', 'core.hooksPath');
      } catch {
        return '';
      }
    })();
    if (!hooksPath) {
      const hook = path.join(root, '.repos', 'acme', 'acme-app.git', 'hooks', 'post-merge');
      assert.match(fs.readFileSync(hook, 'utf8'), /# managed by linked localize/);
      assert.equal(git(appDir, 'rev-parse', '--git-path', 'hooks'), path.join(root, '.repos', 'acme', 'acme-app.git', 'hooks'));
    }
    assertNoToken(root);
  });

  test('a re-run is idempotent, then follows the remotes: updated, switched, kept', () => {
    const {r, root, run} = setup();
    assert.equal(run('change-1').code, 0);

    const again = run('change-1');
    assert.equal(again.code, 0, again.messages.join('\n'));
    assert.equal(again.app?.status, 'unchanged');
    assert.equal(again.app?.created, false);
    assert.deepEqual(again.packages.map((p) => p.status), ['unchanged', 'unchanged']);

    const sha = commitOn(r.base, r.assets, 'change-1', 'more.txt', 'more\n');
    const ontMain = commitOn(r.base, r.ont, 'main', 'ont2.ttl', '# more\n');
    const updated = run('change-1');
    assert.equal(byName(updated, 'acme-assets').status, 'updated');
    assert.equal(byName(updated, 'acme-assets').head, sha);
    assert.equal(byName(updated, 'acme-ont').status, 'updated');
    assert.equal(byName(updated, 'acme-ont').head, ontMain);

    commitOn(r.base, r.ont, 'change-1', 'ont3.ttl', '# on the branch\n');
    const switched = byName(run('change-1'), 'acme-ont');
    assert.deepEqual(
      {status: switched.status, branch: switched.branch, detached: switched.detached, fellBack: switched.fellBack},
      {status: 'switched', branch: 'change-1', detached: false, fellBack: false},
    );

    // A dirty worktree behind its remote is left alone.
    commitOn(r.base, r.assets, 'change-1', 'even-more.txt', 'x\n');
    fs.writeFileSync(path.join(byName(updated, 'acme-assets').dir, 'wip.txt'), 'wip\n');
    const kept = byName(run('change-1'), 'acme-assets');
    assert.equal(kept.status, 'kept');
    assert.match(kept.reason ?? '', /uncommitted changes/);
    assertNoToken(root);
  });

  test('a package no longer listed is reported, not deleted', () => {
    const {r, root, run} = setup();
    assert.equal(run('change-1').code, 0);
    commitOn(
      r.base,
      r.app,
      'change-1',
      'package.json',
      JSON.stringify({
        name: 'acme-app',
        workspaces: ['packages-local/*'],
        linked: {kind: 'app', unpublishedPackages: {'acme-ont': {repo: r.url(r.ont)}}},
      }),
    );
    const res = run('change-1');
    assert.equal(res.app?.status, 'updated');
    const assets = byName(res, 'acme-assets');
    assert.equal(assets.unlisted, true);
    assert.ok(fs.existsSync(assets.dir));
    assertNoToken(root);
  });

  test('--add checks out a package no list names, without an install or a build; a later run reports it unlisted', () => {
    const {r, root, run} = setup();
    const extra = makeRemote(r.base, 'acme-extra', {
      'package.json': JSON.stringify({name: 'acme-extra', version: '1.0.0', linked: {kind: 'ontology'}}) + '\n',
    });
    assert.equal(run('change-1').code, 0);
    const appDir = path.join(root, 'acme-app', 'change-1');
    const manifests = () => git(appDir, 'status', '--porcelain', '--', 'package.json', 'package-lock.json');
    // The app has its install: only the added worktree moves, which installs and builds nothing.
    fs.mkdirSync(path.join(appDir, 'node_modules'), {recursive: true});

    const res = run('change-1', {add: [r.url(extra)], install: true});
    console.log(JSON.stringify(byName(res, 'acme-extra'), null, 2));
    assert.equal(res.code, 0, res.messages.join('\n'));
    const added = byName(res, 'acme-extra');
    assert.deepEqual(
      {added: added.added, unlisted: added.unlisted, detached: added.detached, fellBack: added.fellBack, status: added.status, requiredBy: added.requiredBy},
      {added: true, unlisted: undefined, detached: true, fellBack: true, status: 'created', requiredBy: []},
    );
    assert.equal(added.dir, path.join(appDir, 'packages-local', 'acme-extra'));
    assert.deepEqual(res.install, {ran: false, ok: true});
    assert.deepEqual(res.builds, []);
    assert.equal(manifests(), '');
    assert.deepEqual(res.packages.map((p) => p.name).sort(), ['acme-assets', 'acme-extra', 'acme-ont']);

    // Its repo gets the branch: the next --add switches it, as a listed fallback is.
    commitOn(r.base, extra, 'change-1', 'extra.ttl', '# on the branch\n');
    const switched = byName(run('change-1', {add: [r.url(extra)]}), 'acme-extra');
    assert.deepEqual({status: switched.status, branch: switched.branch, added: switched.added}, {status: 'switched', branch: 'change-1', added: true});

    // Without --add it is a checkout no list names: reported, kept.
    const later = byName(run('change-1'), 'acme-extra');
    assert.equal(later.unlisted, true);
    assert.equal(later.added, undefined);
    assert.ok(fs.existsSync(later.dir));
    assertNoToken(root);
  });

  test('--add of a listed package is the listed one; with another repo, or one name twice, it is refused', () => {
    const {r, run} = setup();
    const same = run('change-1', {add: [r.url(r.ont)]});
    assert.equal(same.code, 0, same.messages.join('\n'));
    assert.equal(same.packages.filter((p) => p.name === 'acme-ont').length, 1);
    assert.equal(byName(same, 'acme-ont').added, undefined);
    assert.ok(same.messages.some((m) => /acme-ont is listed/.test(m)), same.messages.join('\n'));

    const impostor = makeRemote(r.base, 'acme-ont-copy', {
      'package.json': JSON.stringify({name: 'acme-ont', version: '1.0.0'}) + '\n',
    });
    const other = run('change-1', {add: [r.url(impostor)]});
    assert.equal(other.code, 6);
    assert.match(other.messages.join('\n'), /--add .* is acme-ont, which the lists name with/);

    const twin = makeRemote(r.base, 'acme-twin', {'package.json': JSON.stringify({name: 'acme-twin'}) + '\n'});
    const twin2 = makeRemote(r.base, 'acme-twin-2', {'package.json': JSON.stringify({name: 'acme-twin'}) + '\n'});
    const twice = run('change-1', {add: [r.url(twin), r.url(twin2)]});
    assert.equal(twice.code, 6);
    assert.match(twice.messages.join('\n'), /--add names acme-twin twice/);

    const nameless = makeRemote(r.base, 'acme-nameless', {'README.md': 'no package\n'});
    const none = run('change-1', {add: [r.url(nameless)]});
    assert.equal(none.code, 6);
    assert.match(none.messages.join('\n'), /has no package\.json naming a package/);

    const escape = makeRemote(r.base, 'acme-escape', {'package.json': JSON.stringify({name: '../../outside'}) + '\n'});
    const out = run('change-1', {add: [r.url(escape)]});
    assert.equal(out.code, 6);
    assert.match(out.messages.join('\n'), /by an npm name/);
  });

  test('an existing app branch is checked out, not created; --from makes a new one from a branch', () => {
    const {r, root, run} = setup();
    commitOn(r.base, r.app, 'release', 'r.txt', 'r\n');
    const res = run('feat/x', {from: 'release'});
    assert.equal(res.code, 0, res.messages.join('\n'));
    assert.equal(res.app?.dir, path.join(root, 'acme-app', 'feat__x'));
    assert.ok(fs.existsSync(path.join(res.app!.dir, 'r.txt')));
    // The second checkout of the same branch elsewhere is refused: one branch, one worktree.
    const twice = run('feat/x', {dir: path.join(root, 'elsewhere')});
    assert.equal(twice.code, 6);
    assert.match(twice.messages.join('\n'), /checked out in .* already/);
  });

  test('the same package with two repos is refused before anything is installed', () => {
    const {r, run} = setup();
    commitOn(
      r.base,
      r.assets,
      'change-1',
      'package.json',
      JSON.stringify({name: 'acme-assets', linked: {kind: 'assets', unpublishedPackages: {'acme-ont': {repo: 'https://github.com/fork/acme-ont.git'}}}}),
    );
    const res = run('change-1', {install: true});
    assert.equal(res.code, 6);
    assert.match(res.messages.join('\n'), /acme-ont is listed with two repos/);
    assert.equal(res.install.ran, false);
  });

  test('an app not set up for checkouts is refused', () => {
    const {r, run} = setup();
    commitOn(
      r.base,
      r.app,
      'main',
      'package.json',
      JSON.stringify({name: 'acme-app', linked: {kind: 'app', unpublishedPackages: {'acme-ont': {repo: r.url(r.ont)}}}}),
    );
    const res = run('change-2');
    assert.equal(res.code, 6);
    assert.match(res.messages.join('\n'), /lacks "packages-local\/\*"/);
  });

  test('usage errors: a bad branch name, a repo that is not https/file', () => {
    const {run} = setup();
    assert.equal(run('bad..name').code, 2);
    const ssh = run('x', {repo: 'git@github.com:o/r.git'});
    assert.equal(ssh.code, 2);
    assert.match(ssh.messages.join('\n'), /not an https:\/\//);
  });

  test('a remote that renames its default branch: the fallback follows it', () => {
    const {r, run} = setup();
    assert.equal(run('change-1').code, 0);
    git(r.ont, 'branch', '-m', 'main', 'trunk');
    git(r.ont, 'symbolic-ref', 'HEAD', 'refs/heads/trunk');
    commitOn(r.base, r.ont, 'trunk', 'more.ttl', '# on trunk\n');
    const res = run('change-1');
    assert.equal(res.code, 0, res.messages.join('\n'));
    const ont = byName(res, 'acme-ont');
    assert.deepEqual({branch: ont.branch, status: ont.status}, {branch: 'trunk', status: 'updated'});
  });

  test('a first push that failed is made by the re-run', () => {
    const {r, run} = setup();
    const hook = path.join(r.app, 'hooks', 'pre-receive');
    fs.writeFileSync(hook, '#!/bin/sh\necho "no new branches" >&2\nexit 1\n');
    fs.chmodSync(hook, 0o755);
    const first = run('change-1');
    assert.equal(first.code, 6);
    assert.match(first.messages.join('\n'), /no new branches/);
    fs.rmSync(hook);
    const again = run('change-1');
    assert.equal(again.code, 0, again.messages.join('\n'));
    assert.equal(again.app?.status, 'updated');
    assert.equal(git(r.app, 'rev-parse', 'refs/heads/change-1'), again.app?.head);
  });

  test(
    'one real npm install in the app worktree links the package worktrees, without the token',
    () => {
      const {root, run} = setup();
      const marker = path.join(root, 'token-seen');
      const script = path.join(root, 'record-token.cjs');
      fs.writeFileSync(
        script,
        `require('fs').appendFileSync(${JSON.stringify(marker)}, (process.env.LINKED_GIT_TOKEN || 'none') + '\\n');\n`,
      );
      const res = run('change-1', {
        install: true,
        // The build of each new package worktree records whether it saw the token.
        build: `node "${script}"`,
        env: {...scrubbedNpmEnv(gitEnv), LINKED_GIT_TOKEN: TOKEN},
      });
      assert.equal(res.code, 0, res.messages.join('\n'));
      assert.deepEqual(res.install, {ran: true, ok: true});
      const nm = path.join(res.app!.dir, 'node_modules');
      assert.equal(fs.realpathSync(path.join(nm, 'acme-ont')), fs.realpathSync(byName(res, 'acme-ont').dir));
      assert.equal(fs.realpathSync(path.join(nm, 'acme-assets')), fs.realpathSync(byName(res, 'acme-assets').dir));
      // Built in dependency order: the ontology package before the asset package.
      assert.deepEqual(res.builds, [
        {name: 'acme-ont', result: 'ok'},
        {name: 'acme-assets', result: 'ok'},
      ]);
      assert.equal(fs.readFileSync(marker, 'utf8'), 'none\nnone\n');
      // Nothing moved: a re-run installs nothing.
      const again = run('change-1', {install: true, env: {...scrubbedNpmEnv(gitEnv), LINKED_GIT_TOKEN: TOKEN}});
      assert.equal(again.install.ran, false);
      assertNoToken(root);
    },
    120_000,
  );
});
