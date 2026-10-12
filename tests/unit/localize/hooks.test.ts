/**
 * The dependency-free hooks in `hooks/`, run the way npm and git run them: as
 * `node hooks/<file>.cjs` in a real git repository, with nothing from `lib/`
 * or `node_modules`. `npm` is a stub on the PATH where a test needs one, so
 * what the hook asked npm for is recorded and nothing is installed.
 */
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {rm, test, tmpdir} from './helpers.js';

const HOOKS = path.resolve(__dirname, '../../../hooks');
const LOCK_AT_REST = path.join(HOOKS, 'lock-at-rest.cjs');
const GIT_HOOK = path.join(HOOKS, 'git-hook.cjs');

/** No npm lifecycle variables (no /dev/tty), and none of the developer's git config. */
function baseEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^npm_/i.test(k) || /^GIT_/.test(k)) continue;
    env[k] = v;
  }
  return {...env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', ...extra};
}

function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    cwd,
    encoding: 'utf8',
    env: baseEnv(),
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}

const LOCK = {name: 'app', lockfileVersion: 3, packages: {'': {name: 'app'}}};
const LEAKED = {
  ...LOCK,
  packages: {
    '': {name: 'app', workspaces: ['packages-local/*']},
    'packages-local/a': {name: '@x/a', version: '1.0.0'},
    'node_modules/@x/a': {resolved: 'packages-local/a', link: true},
  },
};
const json = (v) => JSON.stringify(v, null, 2) + '\n';

/** A committed app: package.json, package-lock.json, .gitignore for the checkouts. */
function app(t) {
  const root = tmpdir('localize-hooks-');
  t.after(() => rm(root));
  git(root, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(root, 'package.json'), json({name: 'app', workspaces: ['packages-local/*']}));
  fs.writeFileSync(path.join(root, 'package-lock.json'), json(LOCK));
  fs.writeFileSync(path.join(root, '.gitignore'), 'packages-local/\nnpm-calls\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'init');
  return root;
}

function member(root, dir = 'a', name = '@x/a') {
  const d = path.join(root, 'packages-local', dir);
  fs.mkdirSync(d, {recursive: true});
  fs.writeFileSync(path.join(d, 'package.json'), json({name, version: '1.0.0'}));
}

/** A `npm` on the PATH that records its arguments in `<root>/npm-calls` and exits `status`. */
function fakeNpm(root, status = 0) {
  const bin = path.join(root, '.fake-bin');
  fs.mkdirSync(bin, {recursive: true});
  const npm = path.join(bin, 'npm');
  fs.writeFileSync(npm, `#!/bin/sh\necho "$*" >> "${path.join(root, 'npm-calls')}"\nexit ${status}\n`);
  fs.chmodSync(npm, 0o755);
  return `${bin}${path.delimiter}${process.env.PATH}`;
}
const npmCalls = (root) => {
  try {
    return fs.readFileSync(path.join(root, 'npm-calls'), 'utf8').trim().split('\n');
  } catch {
    return [];
  }
};

function node(script, args, cwd, env = baseEnv()) {
  return spawnSync(process.execPath, [script, ...args], {cwd, encoding: 'utf8', env});
}

// ---------------------------------------------------------------------------
// lock-at-rest
// ---------------------------------------------------------------------------

test('lock-at-rest: nothing localized leaves npm its lockfile', (t) => {
  const root = app(t);
  fs.writeFileSync(path.join(root, 'package-lock.json'), json(LEAKED));
  const r = node(LOCK_AT_REST, [], root);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');
  assert.equal(git(root, 'status', '--porcelain'), 'M package-lock.json');
});

test('lock-at-rest: with checkouts linked, the committed lockfile is restored', (t) => {
  const root = app(t);
  member(root);
  fs.writeFileSync(path.join(root, 'package-lock.json'), json(LEAKED));
  git(root, 'add', 'package-lock.json'); // staged is restored too
  const r = node(LOCK_AT_REST, [], root);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /restored the committed package-lock\.json/);
  assert.equal(git(root, 'status', '--porcelain'), '');
});

test('lock-at-rest: a changed package.json leaves the lockfile and says how to change dependencies', (t) => {
  const root = app(t);
  member(root);
  fs.writeFileSync(
    path.join(root, 'package.json'),
    json({name: 'app', workspaces: ['packages-local/*'], dependencies: {left: '^1.0.0'}}),
  );
  fs.writeFileSync(path.join(root, 'package-lock.json'), json(LEAKED));
  const r = node(LOCK_AT_REST, [], root);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /must NOT be committed/);
  assert.match(r.stderr, /delocalize/);
  assert.match(git(root, 'status', '--porcelain'), /M package-lock\.json/);
});

test('lock-at-rest: not a git repository, or no git at all, is exit 0 with nothing changed', (t) => {
  const dir = tmpdir('localize-hooks-nogit-');
  t.after(() => rm(dir));
  member(dir);
  fs.writeFileSync(path.join(dir, 'package-lock.json'), json(LEAKED));
  let r = node(LOCK_AT_REST, [], dir, baseEnv({GIT_CEILING_DIRECTORIES: path.dirname(dir)}));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');

  const root = app(t);
  member(root);
  fs.writeFileSync(path.join(root, 'package-lock.json'), json(LEAKED));
  r = node(LOCK_AT_REST, [], root, baseEnv({PATH: '/nonexistent'}));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');
  assert.equal(git(root, 'status', '--porcelain'), 'M package-lock.json');
});

test('lock-at-rest: runs the drift check when linked is installed, and ignores its exit code', (t) => {
  const root = app(t);
  member(root);
  const bin = path.join(root, 'node_modules', '.bin');
  fs.mkdirSync(bin, {recursive: true});
  fs.writeFileSync(path.join(bin, 'linked'), '#!/bin/sh\necho "drift: $*"\nexit 1\n');
  fs.chmodSync(path.join(bin, 'linked'), 0o755);
  fs.appendFileSync(path.join(root, '.gitignore'), 'node_modules/\n');
  const r = node(LOCK_AT_REST, [], root);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /drift: localize --list --check/);
});

// ---------------------------------------------------------------------------
// git-hook
// ---------------------------------------------------------------------------

test('pre-commit refuses a staged lockfile that lists a checkout', (t) => {
  const root = app(t);
  fs.writeFileSync(path.join(root, 'package-lock.json'), json(LEAKED));
  git(root, 'add', 'package-lock.json');
  const r = node(GIT_HOOK, ['pre-commit'], root);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /refusing package-lock\.json/);
});

test('pre-commit refuses a leaked lockfile over a megabyte', (t) => {
  const root = app(t);
  const filler = Object.fromEntries(
    Array.from({length: 20000}, (_, i) => [`node_modules/pad-${i}`, {version: '1.0.0', resolved: 'x'.repeat(40)}]),
  );
  const big = {...LEAKED, packages: {...LEAKED.packages, ...filler}};
  fs.writeFileSync(path.join(root, 'package-lock.json'), json(big));
  assert.ok(fs.statSync(path.join(root, 'package-lock.json')).size > 1024 * 1024);
  git(root, 'add', 'package-lock.json');
  const r = node(GIT_HOOK, ['pre-commit'], root);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /refusing package-lock\.json/);
});

test('pre-commit refuses a staged package.json that lists a checkout', (t) => {
  const root = app(t);
  fs.writeFileSync(
    path.join(root, 'package.json'),
    json({name: 'app', workspaces: ['packages-local/*', 'packages-local/a']}),
  );
  git(root, 'add', 'package.json');
  assert.equal(node(GIT_HOOK, ['pre-commit'], root).status, 1);
});

test('pre-commit lets the glob itself through', (t) => {
  const root = app(t);
  fs.writeFileSync(
    path.join(root, 'package-lock.json'),
    json({...LOCK, packages: {'': {name: 'app', workspaces: ['packages/*', 'packages-local/*']}}}),
  );
  git(root, 'add', 'package-lock.json');
  const r = node(GIT_HOOK, ['pre-commit'], root);
  assert.equal(r.status, 0, r.stderr);
  // An unstaged leak is not what is being committed.
  fs.writeFileSync(path.join(root, 'package-lock.json'), json(LEAKED));
  assert.equal(node(GIT_HOOK, ['pre-commit'], root).status, 0);
});

test('post-checkout of files ($3 = 0) does nothing: no git, no npm', (t) => {
  const root = app(t);
  const head = git(root, 'rev-parse', 'HEAD');
  const r = node(GIT_HOOK, ['post-checkout', head, head, '0'], root, baseEnv({PATH: '/nonexistent'}));
  assert.equal(r.status, 0);
  assert.equal(r.stderr, '');
  assert.equal(r.stdout, '');
});

/** The current commit as `old`, a new branch `branch` at `new` that changes `file`. */
function twoCommits(root, file, content, branch = 'side') {
  const old = git(root, 'rev-parse', 'HEAD');
  git(root, 'checkout', '-q', '-b', branch);
  fs.mkdirSync(path.dirname(path.join(root, file)), {recursive: true});
  fs.writeFileSync(path.join(root, file), content);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', `change ${file}`);
  return {old, new: git(root, 'rev-parse', 'HEAD')};
}

test('post-checkout of a branch installs when the manifests changed, and only then', (t) => {
  const root = app(t);
  const PATH = fakeNpm(root);
  const deps = twoCommits(root, 'packages/site/package.json', json({name: 'site'}));
  let r = node(GIT_HOOK, ['post-checkout', deps.old, deps.new, '1'], root, baseEnv({PATH}));
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(npmCalls(root), ['install --no-audit --no-fund']);

  const other = twoCommits(root, 'README.md', 'docs only\n', 'docs');
  r = node(GIT_HOOK, ['post-checkout', other.old, other.new, '1'], root, baseEnv({PATH}));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(npmCalls(root).length, 1, 'no install for a change outside the manifests');
});

test('post-merge compares ORIG_HEAD with HEAD, and a failed install never fails git', (t) => {
  const root = app(t);
  const PATH = fakeNpm(root, 1);
  twoCommits(root, 'package-lock.json', json({...LOCK, packages: {'': {name: 'app', version: '2.0.0'}}}));
  git(root, 'checkout', '-q', 'main');
  git(root, 'merge', '-q', '--ff-only', 'side');
  const r = node(GIT_HOOK, ['post-merge', '0'], root, baseEnv({PATH}));
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(npmCalls(root), ['install --no-audit --no-fund']);
  assert.match(r.stderr, /npm install FAILED/);
});
