/**
 * `installGitHooks` against a real `git init`: where the hooks land, that a
 * hook it did not write is left alone, and that an installed hook finds the
 * cli's `git-hook.cjs` from the work tree when it runs.
 */
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  GIT_HOOKS,
  HOOK_MARKER,
  installGitHooks,
} from '../../../src/localize/git-hooks.js';
import {rm, test, tmpdir} from './helpers.js';

// The developer's own git config (a global core.hooksPath, templates) stays out.
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';

function git(cwd, ...args) {
  const r = spawnSync('git', args, {cwd, encoding: 'utf8'});
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}

function repo(t) {
  const root = tmpdir('localize-git-hooks-');
  t.after(() => rm(root));
  git(root, 'init', '-q');
  return root;
}

const hooksDir = (root) => path.join(root, '.git', 'hooks');

test('writes post-merge, post-checkout and pre-commit, executable and marked', (t) => {
  const root = repo(t);
  const {written, skipped} = installGitHooks(root);
  assert.deepEqual(written, GIT_HOOKS.map((h) => path.join(hooksDir(root), h)));
  assert.deepEqual(skipped, []);
  for (const file of written) {
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(text.startsWith(`#!/bin/sh\n${HOOK_MARKER}\n`), text);
    assert.match(text, new RegExp(`"\\$script" ${path.basename(file)} "\\$@"`));
    assert.ok(!text.includes(root), 'the path is resolved when the hook runs, not baked in');
    assert.equal(fs.statSync(file).mode & 0o111, 0o111);
    assert.equal(spawnSync('sh', ['-n', file]).status, 0);
  }
});

test('a hook it did not write is skipped and reported; its own are rewritten', (t) => {
  const root = repo(t);
  const foreign = path.join(hooksDir(root), 'pre-commit');
  fs.mkdirSync(hooksDir(root), {recursive: true});
  fs.writeFileSync(foreign, '#!/bin/sh\nnpx lint-staged\n');
  const ours = path.join(hooksDir(root), 'post-merge');
  fs.writeFileSync(ours, `#!/bin/sh\n${HOOK_MARKER}\necho an older version\n`);

  const first = installGitHooks(root);
  assert.deepEqual(first.skipped, [foreign]);
  assert.deepEqual(first.written.map((f) => path.basename(f)), ['post-merge', 'post-checkout']);
  assert.equal(fs.readFileSync(foreign, 'utf8'), '#!/bin/sh\nnpx lint-staged\n');
  assert.ok(!fs.readFileSync(ours, 'utf8').includes('older version'));

  const second = installGitHooks(root);
  assert.deepEqual(second, first);
});

test('the hook runs git-hook.cjs from the top level, wherever git runs it from', (t) => {
  const root = repo(t);
  const [, , preCommit] = installGitHooks(root).written;
  const sub = path.join(root, 'deep', 'er');
  fs.mkdirSync(sub, {recursive: true});

  // No cli installed in this work tree: the hook does nothing and lets git go on.
  let r = spawnSync('sh', [preCommit], {cwd: sub, encoding: 'utf8'});
  assert.equal(r.status, 0, r.stderr);

  const script = path.join(root, 'node_modules', '@_linked', 'cli', 'hooks', 'git-hook.cjs');
  fs.mkdirSync(path.dirname(script), {recursive: true});
  fs.writeFileSync(
    script,
    `require('fs').writeFileSync(${JSON.stringify(path.join(root, 'args.json'))}, JSON.stringify(process.argv.slice(2)));\nprocess.exit(3);\n`,
  );
  r = spawnSync('sh', [preCommit, 'x', 'y z'], {cwd: sub, encoding: 'utf8'});
  assert.equal(r.status, 3, 'the hook exits with git-hook.cjs');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'args.json'), 'utf8')), [
    'pre-commit',
    'x',
    'y z',
  ]);
});

test('a linked work tree gets them where git looks for them', (t) => {
  const root = repo(t);
  git(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
  const wt = path.join(tmpdir('localize-git-wt-'), 'wt');
  t.after(() => rm(path.dirname(wt)));
  git(root, 'worktree', 'add', '-q', wt);

  const {written} = installGitHooks(wt);
  const expected = path.resolve(wt, git(wt, 'rev-parse', '--git-path', 'hooks'));
  assert.deepEqual(written.map((f) => path.dirname(f)), [expected, expected, expected]);
});

test('outside a git work tree nothing is written', (t) => {
  const dir = tmpdir('localize-no-git-');
  t.after(() => rm(dir));
  const prev = process.env.GIT_CEILING_DIRECTORIES;
  process.env.GIT_CEILING_DIRECTORIES = path.dirname(dir);
  t.after(() => {
    if (prev === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
    else process.env.GIT_CEILING_DIRECTORIES = prev;
  });
  assert.deepEqual(installGitHooks(dir), {written: [], skipped: []});
  assert.ok(!fs.existsSync(path.join(dir, '.git')));
});
