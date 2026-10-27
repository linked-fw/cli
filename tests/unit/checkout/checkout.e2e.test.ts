/**
 * `linked checkout` end to end against real git, no network: bare "remote" repos under a temp
 * dir (`file://`), an app listing an ontology and an asset package, the asset package listing the
 * ontology package, only the asset repo with `change-1`. A fake token sits in LINKED_GIT_TOKEN
 * throughout; the last assertion of each case is that no config under the root holds it.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {checkout, type CheckoutOptions, type CheckoutResult} from '../../../src/commands/checkout.js';
import {scrubbedNpmEnv} from '../localize/helpers.js';
import {commitOn, git, gitEnv, makeRemotes, tmp, type Remotes} from './helpers.js';

const TOKEN = 'ghs_checkoutE2eFakeToken';
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, {recursive: true, force: true});
});

/** Every git config file under `root`: base clones, worktree configs. */
export function configFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, {withFileTypes: true})) {
      const p = path.join(dir, e.name);
      if (e.isDirectory() && e.name !== 'node_modules') walk(p);
      else if (e.isFile() && /^config(\.worktree)?$/.test(e.name)) out.push(p);
    }
  };
  walk(root);
  return out;
}

/** No token and no userinfo in any config under `root`, nor in any remote URL of a base clone. */
export function assertNoToken(root: string): void {
  const files = configFiles(root);
  assert.ok(files.length > 0);
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    assert.ok(!text.includes(TOKEN), `${f} holds the token`);
    assert.ok(!/:\/\/[^/\s]*@/.test(text), `${f} holds a URL with userinfo`);
  }
  const repos = path.join(root, '.repos', 'acme');
  for (const b of fs.readdirSync(repos)) {
    const urls = git(path.join(repos, b), 'config', '--get-regexp', 'remote\\..*\\.url');
    assert.ok(!urls.includes(TOKEN) && !urls.includes('@'), urls);
  }
}

export function setup(): {r: Remotes; root: string; run: (branch: string, o?: CheckoutOptions) => CheckoutResult} {
  const r = makeRemotes();
  const root = tmp('checkout-root-');
  dirs.push(r.base, root);
  const env = {...gitEnv, LINKED_GIT_TOKEN: TOKEN};
  const run = (branch: string, o: CheckoutOptions = {}) =>
    checkout(branch, {repo: r.url(r.app), root, install: false, env, cwd: root, ...o});
  return {r, root, run};
}

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
