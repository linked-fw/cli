/**
 * `installGitHooks` against a real `git init`: where the hooks land, that a
 * hook it did not write is left alone, that an installed hook finds the
 * cli's `git-hook.cjs` from the app directory when it runs (also below the
 * top level, with git's relative `GIT_DIR`), that nothing is written under
 * `core.hooksPath`, and what localize prints for that and for a worktree.
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
import {installAndBuild} from '../../../src/localize/localize.js';
import {rm, stubbed, test, tmpdir} from './helpers.js';

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
  assert.deepEqual(
    written,
    GIT_HOOKS.map((h) => path.join(hooksDir(root), h)),
  );
  assert.deepEqual(skipped, []);
  for (const file of written) {
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(text.startsWith(`#!/bin/sh\n${HOOK_MARKER}\n`), text);
    assert.match(text, new RegExp(`"\\$script" ${path.basename(file)} "\\$@"`));
    assert.ok(
      !text.includes(root),
      'the path is resolved when the hook runs, not baked in',
    );
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
  assert.deepEqual(
    first.written.map((f) => path.basename(f)),
    ['post-merge', 'post-checkout'],
  );
  assert.equal(
    fs.readFileSync(foreign, 'utf8'),
    '#!/bin/sh\nnpx lint-staged\n',
  );
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

  const script = path.join(
    root,
    'node_modules',
    '@_linked',
    'cli',
    'hooks',
    'git-hook.cjs',
  );
  fs.mkdirSync(path.dirname(script), {recursive: true});
  fs.writeFileSync(
    script,
    `require('fs').writeFileSync(${JSON.stringify(path.join(root, 'args.json'))}, JSON.stringify(process.argv.slice(2)));\nprocess.exit(3);\n`,
  );
  r = spawnSync('sh', [preCommit, 'x', 'y z'], {cwd: sub, encoding: 'utf8'});
  assert.equal(r.status, 3, 'the hook exits with git-hook.cjs');
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(root, 'args.json'), 'utf8')),
    ['pre-commit', 'x', 'y z'],
  );
});

test('a linked work tree gets them where git looks for them', (t) => {
  const root = repo(t);
  git(
    root,
    '-c',
    'user.name=t',
    '-c',
    'user.email=t@t',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'init',
  );
  const wt = path.join(tmpdir('localize-git-wt-'), 'wt');
  t.after(() => rm(path.dirname(wt)));
  git(root, 'worktree', 'add', '-q', wt);

  const {written} = installGitHooks(wt);
  const expected = path.resolve(
    wt,
    git(wt, 'rev-parse', '--git-path', 'hooks'),
  );
  assert.deepEqual(
    written.map((f) => path.dirname(f)),
    [expected, expected, expected],
  );
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
  assert.deepEqual(installGitHooks(dir), {
    written: [],
    skipped: [],
    manual: [],
    hooksPath: null,
    sharedWithWorktrees: false,
  });
  assert.ok(!fs.existsSync(path.join(dir, '.git')));
});

const commitEnv = ['-c', 'user.name=t', '-c', 'user.email=t@t'];

/**
 * A stand-in `git-hook.cjs` in the app at `appDir`: records where it ran, its
 * arguments, git's variables, and what git says the top level is from there.
 */
function fakeGitHook(appDir: string): string {
  const record = path.join(appDir, 'hook-ran.json');
  const script = path.join(
    appDir,
    'node_modules',
    '@_linked',
    'cli',
    'hooks',
    'git-hook.cjs',
  );
  fs.mkdirSync(path.dirname(script), {recursive: true});
  fs.writeFileSync(
    script,
    [
      `const {execFileSync} = require('child_process');`,
      `let top = null;`,
      `try { top = execFileSync('git', ['rev-parse', '--show-toplevel'], {encoding: 'utf8'}).trim(); } catch (e) { top = 'FAILED ' + e.message; }`,
      `require('fs').writeFileSync(${JSON.stringify(record)}, JSON.stringify({`,
      `  cwd: process.cwd(), args: process.argv.slice(2), top,`,
      `  GIT_DIR: process.env.GIT_DIR || null, GIT_INDEX_FILE: process.env.GIT_INDEX_FILE || null,`,
      `}));`,
    ].join('\n'),
  );
  return record;
}

/** A repository whose app sits two directories down, in a path with spaces and a quote. */
function repoWithSubdirApp(t) {
  const root = repo(t);
  const app = path.join(root, 'my apps', "it's web");
  fs.mkdirSync(app, {recursive: true});
  fs.writeFileSync(path.join(app, 'package.json'), '{"name": "web"}\n');
  git(root, 'add', '-A');
  git(root, ...commitEnv, 'commit', '-q', '-m', 'init');
  return {root, app};
}

test("an app below the top level: the hook cds there, with git's relative GIT_DIR made absolute", (t) => {
  const {root, app} = repoWithSubdirApp(t);
  const {written} = installGitHooks(app);
  assert.equal(written.length, 3);
  const postCheckout = written[1];
  assert.equal(spawnSync('sh', ['-n', postCheckout]).status, 0);
  const record = fakeGitHook(app);

  // As git starts it: at the top level, GIT_DIR and GIT_INDEX_FILE relative to it.
  const r = spawnSync('sh', [postCheckout, 'a', 'b c'], {
    cwd: root,
    encoding: 'utf8',
    env: {...process.env, GIT_DIR: '.git', GIT_INDEX_FILE: '.git/index'},
  });
  assert.equal(r.status, 0, r.stderr);
  const ran = JSON.parse(fs.readFileSync(record, 'utf8'));
  assert.equal(fs.realpathSync(ran.cwd), app);
  assert.deepEqual(ran.args, ['post-checkout', 'a', 'b c']);
  assert.equal(ran.GIT_DIR, path.join(root, '.git'));
  assert.equal(ran.GIT_INDEX_FILE, path.join(root, '.git/index'));
  assert.equal(
    fs.realpathSync(ran.top),
    root,
    'git works from the app directory',
  );

  // And as git really runs it, on a branch switch.
  fs.rmSync(record);
  git(root, 'checkout', '-q', '-b', 'other');
  const real = JSON.parse(fs.readFileSync(record, 'utf8'));
  assert.equal(fs.realpathSync(real.cwd), app);
  assert.equal(real.args[0], 'post-checkout');
  assert.equal(fs.realpathSync(real.top), root);
});

test('core.hooksPath set: nothing is written, and localize prints the line for each hook', (t) => {
  const {root, app} = repoWithSubdirApp(t);
  git(root, 'config', 'core.hooksPath', '.husky/_');
  const result = installGitHooks(app);

  assert.deepEqual(result.written, []);
  assert.equal(
    fs.existsSync(path.join(root, '.husky')),
    false,
    'nothing written there',
  );
  assert.equal(
    fs
      .readdirSync(hooksDir(root))
      .some((f) => (GIT_HOOKS as readonly string[]).includes(f)),
    false,
    'nor in .git/hooks',
  );
  assert.deepEqual(
    result.manual.map((m) => m.file),
    ['.husky/post-merge', '.husky/post-checkout', '.husky/pre-commit'],
  );

  // A husky hook file runs the line with sh from the top level; it reaches the app.
  const record = fakeGitHook(app);
  const pre = result.manual[2];
  const r = spawnSync(
    'sh',
    ['-e', '-c', `${pre.line}\necho after`, 'hook', 'x'],
    {
      cwd: root,
      encoding: 'utf8',
      env: {...process.env, GIT_INDEX_FILE: '.git/index'},
    },
  );
  assert.equal(r.status, 0, r.stderr);
  assert.equal(
    r.stdout,
    'after\n',
    'the line leaves the rest of the hook file alone',
  );
  const ran = JSON.parse(fs.readFileSync(record, 'utf8'));
  assert.equal(fs.realpathSync(ran.cwd), app);
  assert.deepEqual(ran.args, ['pre-commit', 'x']);
  assert.equal(ran.GIT_INDEX_FILE, path.join(root, '.git/index'));

  // localize prints the three lines and writes nothing.
  const deps = stubbed(app);
  installAndBuild(
    [{name: 'x', dir: 'packages-local/x', build: false}],
    {},
    deps,
  );
  const out = deps.output();
  assert.match(
    out,
    /core\.hooksPath is set \(\.husky\/_\), so no git hooks were written/,
  );
  for (const m of result.manual)
    assert.ok(out.includes(`  ${m.file}:\n    ${m.line}`), out);
});

test('in a linked worktree localize warns once that the hooks are shared', (t) => {
  const root = repo(t);
  git(root, ...commitEnv, 'commit', '-q', '--allow-empty', '-m', 'init');
  const wt = path.join(tmpdir('localize-git-wt-'), 'wt');
  t.after(() => rm(path.dirname(wt)));
  git(root, 'worktree', 'add', '-q', wt);

  assert.equal(installGitHooks(wt).sharedWithWorktrees, true);
  assert.equal(installGitHooks(root).sharedWithWorktrees, false);

  const deps = stubbed(wt);
  installAndBuild(
    [{name: 'x', dir: 'packages-local/x', build: false}],
    {},
    deps,
  );
  const warnings = deps.warns.filter((w) => /linked worktree/.test(w));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /shared by every worktree/);
});

test('an app below the top level: a real commit runs the real pre-commit there and is refused on a leak', (t) => {
  const {root, app} = repoWithSubdirApp(t);
  installGitHooks(app);
  const hooks = path.join(app, 'node_modules', '@_linked', 'cli', 'hooks');
  fs.mkdirSync(path.dirname(hooks), {recursive: true});
  fs.symlinkSync(path.resolve(__dirname, '../../../hooks'), hooks, 'dir');

  fs.writeFileSync(
    path.join(app, 'package.json'),
    '{"name": "web", "workspaces": ["packages-local/x"]}\n',
  );
  git(root, 'add', path.join(app, 'package.json'));
  const r = spawnSync('git', [...commitEnv, 'commit', '-q', '-m', 'leak'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.notEqual(r.status, 0, 'the commit is refused');
  assert.match(r.stderr, /pre-commit/);
  assert.match(r.stderr, /package\.json/);
});
