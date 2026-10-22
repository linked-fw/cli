/**
 * The repo model: listing an app's repos and reading branch state through a
 * faked `run`, and targets and ahead/behind counts against real git in a
 * throwaway repo.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  agentBranch,
  aheadBehind,
  getTarget,
  integrationOf,
  listRepos,
  setTarget,
} from '../../../src/integration/repos.js';
import {makeRun, type Run, type RunResult} from '../../../src/localize/run.js';

const ok = (stdout = ''): RunResult => ({status: 0, stdout, stderr: ''});
const fail = (stderr = 'boom'): RunResult => ({status: 1, stdout: '', stderr});

const tmpDirs: string[] = [];
function tmpdir(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

function writePackage(dir: string, name: string, git = true): void {
  fs.mkdirSync(dir, {recursive: true});
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({name}));
  if (git) fs.mkdirSync(path.join(dir, '.git'));
}

/** A fake git: `answer(args, cwd)` returns the result, undefined means success with no output. */
function fakeRun(
  answer: (args: string[], cwd: string) => RunResult | undefined,
): Run {
  return (cmd, args, opts = {}) => {
    assert.equal(cmd, 'git');
    return answer(args, opts.cwd ?? '') ?? ok();
  };
}

/** A real git repo with one commit on `main`. */
function realRepo(): {dir: string; git: (...args: string[]) => string} {
  const dir = tmpdir('repos-git-');
  const run = makeRun(dir);
  const git = (...args: string[]): string => {
    const r = run('git', [
      '-c',
      'user.email=test@example.com',
      '-c',
      'user.name=Test',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ]);
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  git('init', '-q', '-b', 'main');
  git('commit', '-q', '--allow-empty', '-m', 'first');
  return {dir, git};
}

test('listRepos — root and two packages-local checkouts', async () => {
  const appRoot = tmpdir('repos-app-');
  writePackage(appRoot, 'app');
  writePackage(path.join(appRoot, 'packages-local', '_linked-server'), '@_linked/server');
  writePackage(path.join(appRoot, 'packages-local', '_linked-core'), '@_linked/core');
  writePackage(path.join(appRoot, 'packages-local', 'x'), 'x', false);
  const run = fakeRun((args, cwd) => {
    if (args[0] === 'symbolic-ref') return ok('main\n');
    if (args[0] === 'rev-parse') return ok(`${path.basename(cwd)}-sha\n`);
    if (args[0] === 'status') {
      return ok(cwd.endsWith('_linked-core') ? ' M src/index.ts\n' : '');
    }
    return undefined;
  });

  const repos = await listRepos(appRoot, run);

  assert.deepEqual(
    repos.map((r) => [r.rel, r.packageName, r.branch, r.dirty]),
    [
      ['.', 'app', 'main', false],
      ['packages-local/_linked-core', '@_linked/core', 'main', true],
      ['packages-local/_linked-server', '@_linked/server', 'main', false],
    ],
  );
  assert.equal(repos[1].dir, path.join(appRoot, 'packages-local', '_linked-core'));
  assert.equal(repos[1].head, '_linked-core-sha');
});

test('listRepos — detached HEAD', async () => {
  const appRoot = tmpdir('repos-app-');
  writePackage(appRoot, 'app');
  const run = fakeRun((args) => {
    if (args[0] === 'symbolic-ref') return fail('');
    if (args[0] === 'rev-parse') return ok('abc123\n');
    return undefined;
  });

  const [root] = await listRepos(appRoot, run);

  assert.equal(root.branch, null);
  assert.equal(root.head, 'abc123');
});

test('getTarget — unset', async () => {
  const {dir} = realRepo();
  assert.equal(await getTarget(dir, 'overhaul'), null);
});

test('setTarget then getTarget', async () => {
  const {dir} = realRepo();
  await setTarget(dir, 'overhaul', 'dev');
  assert.equal(await getTarget(dir, 'overhaul'), 'dev');
});

test('integrationOf — root on an integration branch', async () => {
  const run = fakeRun((args) => {
    if (args[0] === 'symbolic-ref') return ok('overhaul\n');
    if (args.join(' ') === 'config --get branch.overhaul.linked-target') {
      return ok('main\n');
    }
    return fail('');
  });
  assert.deepEqual(await integrationOf('/app', run), {
    branch: 'overhaul',
    target: 'main',
  });
});

test('integrationOf — root on its target', async () => {
  const run = fakeRun((args) => {
    if (args[0] === 'symbolic-ref') return ok('main\n');
    return fail('');
  });
  assert.equal(await integrationOf('/app', run), null);
});

test('integrationOf — real git', async () => {
  const {dir, git} = realRepo();
  assert.equal(await integrationOf(dir), null);
  git('switch', '-q', '-c', 'overhaul');
  await setTarget(dir, 'overhaul', 'main');
  assert.deepEqual(await integrationOf(dir), {branch: 'overhaul', target: 'main'});
});

test('agentBranch', () => {
  assert.equal(agentBranch('overhaul', 'a1'), 'overhaul--a1');
  assert.throws(() => agentBranch('overhaul', 'a/b'), /invalid agent name/);
  assert.throws(() => agentBranch('overhaul', 'a--b'), /invalid agent name/);
  assert.throws(() => agentBranch('overhaul', ''), /invalid agent name/);
});

test('aheadBehind', async () => {
  const {dir, git} = realRepo();
  git('switch', '-q', '-c', 'x');
  git('commit', '-q', '--allow-empty', '-m', 'second');
  assert.deepEqual(await aheadBehind(dir, 'x', 'main'), {ahead: 1, behind: 0});
  assert.deepEqual(await aheadBehind(dir, 'main', 'x'), {ahead: 0, behind: 1});
});
