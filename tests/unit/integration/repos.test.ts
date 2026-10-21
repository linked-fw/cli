import fs from 'node:fs';
import path from 'node:path';

import type {Run, RunResult} from '../../../src/localize/run';
import {
  agentBranch,
  aheadBehind,
  getTarget,
  integrationOf,
  listRepos,
  setTarget,
} from '../../../src/integration/repos';
import {commit, g, makeApp, makeRepo, rm, tmpdir, writeJson} from './helpers';

const ok = (stdout = ''): RunResult => ({status: 0, stdout, stderr: ''});
const fail = (): RunResult => ({status: 1, stdout: '', stderr: 'fatal'});

/** A fake `run` answering the few git calls `listRepos` makes. */
function fakeGit(branches: Record<string, string | null>): Run {
  return (cmd, args, opts) => {
    const dir = opts?.cwd ?? '';
    if (cmd !== 'git') return fail();
    if (args[0] === 'symbolic-ref') {
      const b = branches[dir];
      return b ? ok(`${b}\n`) : fail();
    }
    if (args[0] === 'rev-parse') return ok('abc123\n');
    if (args[0] === 'status') return ok('');
    return fail();
  };
}

describe('repo model', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = tmpdir();
  });
  afterEach(() => rm(tmp));

  it('listRepos — root and two packages-local checkouts', () => {
    const root = path.join(tmp, 'app');
    writeJson(path.join(root, 'package.json'), {name: 'app'});
    fs.mkdirSync(path.join(root, '.git'), {recursive: true});
    for (const [dir, name] of [
      ['_linked-core', '@_linked/core'],
      ['_linked-server', '@_linked/server'],
    ]) {
      writeJson(path.join(root, 'packages-local', dir, 'package.json'), {name});
      fs.mkdirSync(path.join(root, 'packages-local', dir, '.git'));
    }
    // Not a checkout: skipped.
    writeJson(path.join(root, 'packages-local', 'x', 'package.json'), {name: 'x'});
    const repos = listRepos(
      root,
      fakeGit({
        [root]: 'main',
        [path.join(root, 'packages-local', '_linked-core')]: 'main',
        [path.join(root, 'packages-local', '_linked-server')]: 'main',
      }),
    );
    expect(repos.map((r) => r.rel)).toEqual([
      '.',
      'packages-local/_linked-core',
      'packages-local/_linked-server',
    ]);
    expect(repos.map((r) => r.packageName)).toEqual([
      'app',
      '@_linked/core',
      '@_linked/server',
    ]);
  });

  it('listRepos — a packages-local checkout whose .git is a file (a worktree) is listed', () => {
    const root = path.join(tmp, 'app');
    writeJson(path.join(root, 'package.json'), {name: 'app'});
    fs.mkdirSync(path.join(root, '.git'), {recursive: true});
    const wt = path.join(root, 'packages-local', '_linked-core');
    writeJson(path.join(wt, 'package.json'), {name: '@_linked/core'});
    fs.writeFileSync(path.join(wt, '.git'), 'gitdir: /elsewhere/.git/worktrees/x\n');
    const repos = listRepos(root, fakeGit({[root]: 'main', [wt]: 'x'}));
    expect(repos.map((r) => [r.rel, r.branch])).toEqual([
      ['.', 'main'],
      ['packages-local/_linked-core', 'x'],
    ]);
  });

  it('listRepos — detached HEAD', () => {
    const root = path.join(tmp, 'app');
    writeJson(path.join(root, 'package.json'), {name: 'app'});
    fs.mkdirSync(path.join(root, '.git'), {recursive: true});
    const [repo] = listRepos(root, fakeGit({}));
    expect(repo.branch).toBeNull();
  });

  it('listRepos — real git: dirty and worktree checkouts', () => {
    const {root, core} = makeApp(path.join(tmp, 'app'));
    fs.writeFileSync(path.join(core, 'untracked.txt'), 'x');
    const repos = listRepos(root);
    expect(repos.map((r) => [r.rel, r.branch, r.dirty])).toEqual([
      ['.', 'main', false],
      ['packages-local/_linked-core', 'main', true],
      ['packages-local/_linked-server', 'main', false],
    ]);
  });

  it('getTarget — unset is null; setTarget then getTarget, also read from a worktree', () => {
    const repo = makeRepo(path.join(tmp, 'r'), {name: 'r'});
    expect(getTarget(repo, 'overhaul')).toBeNull();
    g(repo, 'branch', 'overhaul');
    setTarget(repo, 'overhaul', 'dev');
    expect(getTarget(repo, 'overhaul')).toBe('dev');
    const wt = path.join(tmp, 'wt');
    g(repo, 'worktree', 'add', '-q', wt, 'overhaul');
    expect(getTarget(wt, 'overhaul')).toBe('dev');
  });

  it('integrationOf', () => {
    const repo = makeRepo(path.join(tmp, 'r'), {name: 'r'});
    expect(integrationOf(repo)).toBeNull();
    g(repo, 'switch', '-q', '-c', 'overhaul');
    expect(integrationOf(repo)).toBeNull();
    setTarget(repo, 'overhaul', 'main');
    expect(integrationOf(repo)).toEqual({branch: 'overhaul', target: 'main'});
    g(repo, 'switch', '-q', 'main');
    expect(integrationOf(repo)).toBeNull();
    // An agent worktree reports the integration branch it works on.
    const wt = path.join(tmp, 'wt');
    g(repo, 'worktree', 'add', '-q', '-b', 'overhaul--a1', wt, 'overhaul');
    expect(integrationOf(wt)).toEqual({branch: 'overhaul', target: 'main', agent: 'a1'});
  });

  it('agentBranch', () => {
    expect(agentBranch('overhaul', 'a1')).toBe('overhaul--a1');
    expect(() => agentBranch('overhaul', 'a/b')).toThrow();
    expect(() => agentBranch('overhaul', 'a--b')).toThrow();
    expect(() => agentBranch('overhaul', '')).toThrow();
  });

  it('aheadBehind', () => {
    const repo = makeRepo(path.join(tmp, 'r'), {name: 'r'});
    g(repo, 'switch', '-q', '-c', 'x');
    commit(repo);
    expect(aheadBehind(repo, 'x', 'main')).toEqual({ahead: 1, behind: 0});
    expect(aheadBehind(repo, 'main', 'x')).toEqual({ahead: 0, behind: 1});
  });
});
