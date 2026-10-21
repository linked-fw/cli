import fs from 'node:fs';
import path from 'node:path';

import {branchStart, type CommandDeps} from '../../../src/commands/branch';
import {listAgentWorktrees, worktreeAdd, worktreeRemove} from '../../../src/commands/worktree';
import {getTarget} from '../../../src/integration/repos';
import {makeRun} from '../../../src/localize/run';
import {commit, g, gOk, makeApp, rm, tmpdir} from './helpers';

function deps(cwd: string): CommandDeps & {out: string[]; err: string[]} {
  const out: string[] = [];
  const err: string[] = [];
  return {cwd, run: makeRun(cwd), log: (m) => out.push(m), error: (m) => err.push(m), out, err};
}

const head = (dir: string) => g(dir, 'symbolic-ref', '--short', 'HEAD');
const hasBranch = (dir: string, b: string) => gOk(dir, 'show-ref', '--verify', '--quiet', `refs/heads/${b}`);

describe('linked worktree', () => {
  let tmp: string;
  let app: ReturnType<typeof makeApp>;
  /** The integration set: the app and server on `overhaul`, target `main`. */
  let set: string;
  beforeEach(() => {
    tmp = tmpdir();
    app = makeApp(path.join(tmp, 'app'));
    set = path.join(tmp, 'wt', 'overhaul');
    expect(branchStart('overhaul', ['server'], {target: 'main'}, deps(app.root))).toBe(0);
  });
  afterEach(() => rm(tmp));

  it('add --with server creates a nested worktree on the agent branch', () => {
    const d = deps(set);
    expect(worktreeAdd('a1', {with: 'server', port: 4062}, d)).toBe(0);
    const dir = path.join(tmp, 'wt', 'overhaul-a1');
    const nested = path.join(dir, 'packages-local', '_linked-server');
    expect(fs.statSync(path.join(nested, '.git')).isFile()).toBe(true);
    expect(head(nested)).toBe('overhaul--a1');
    expect(head(dir)).toBe('overhaul--a1');
    expect(fs.realpathSync(path.join(dir, 'node_modules'))).toBe(path.join(app.root, 'node_modules'));
    expect(fs.lstatSync(path.join(dir, 'node_modules')).isSymbolicLink()).toBe(true);
    expect(fs.lstatSync(path.join(dir, '.env')).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(path.join(dir, '.env'))).toBe(path.join(app.root, '.env'));
    for (const name of fs.readdirSync(dir))
      if (name.endsWith('.pem')) expect(fs.lstatSync(path.join(dir, name)).isSymbolicLink()).toBe(false);
    expect(d.out.join('\n')).toContain(`cd ${dir} && PORT=4062 npx linked start`);
    expect(d.out.join('\n')).toMatch(/not linked: secret\.pem/);
    // Main checkouts untouched.
    expect(head(app.root)).toBe('main');
    expect(head(app.server)).toBe('main');
  });

  it('--app-detached', () => {
    expect(worktreeAdd('a1', {appDetached: true, with: 'server'}, deps(set))).toBe(0);
    const dir = path.join(tmp, 'wt', 'overhaul-a1');
    expect(gOk(dir, 'symbolic-ref', 'HEAD')).toBe(false);
    expect(g(dir, 'rev-parse', 'HEAD')).toBe(g(set, 'rev-parse', 'overhaul'));
    expect(hasBranch(app.root, 'overhaul--a1')).toBe(false);
  });

  it('add refuses a dir inside packages-local', () => {
    const inside = path.join(app.root, 'packages-local', 'x');
    expect(worktreeAdd('a1', {dir: inside}, deps(set))).not.toBe(0);
    expect(fs.existsSync(inside)).toBe(false);
    const insideSet = path.join(set, 'packages-local', 'x');
    expect(worktreeAdd('a1', {dir: insideSet}, deps(set))).not.toBe(0);
    expect(fs.existsSync(insideSet)).toBe(false);
    expect(hasBranch(app.root, 'overhaul--a1')).toBe(false);
  });

  it('joins a package midway', () => {
    expect(worktreeAdd('a1', {with: 'core'}, deps(set))).toBe(0);
    const integrationCore = path.join(set, 'packages-local', '_linked-core');
    expect(head(integrationCore)).toBe('overhaul');
    expect(getTarget(app.core, 'overhaul')).toBe('main');
    expect(head(app.core)).toBe('main');
    expect(head(path.join(tmp, 'wt', 'overhaul-a1', 'packages-local', '_linked-core'))).toBe('overhaul--a1');
  });

  it('a dirty package refuses to join, and nothing is created', () => {
    fs.writeFileSync(path.join(app.core, 'untracked.txt'), 'x');
    const d = deps(set);
    expect(worktreeAdd('a1', {with: 'server,core'}, d)).not.toBe(0);
    expect(d.err.join('\n')).toMatch(/uncommitted/);
    expect(fs.existsSync(path.join(tmp, 'wt', 'overhaul-a1'))).toBe(false);
    expect(fs.existsSync(path.join(set, 'packages-local', '_linked-core'))).toBe(false);
    for (const repo of [app.root, app.core, app.server]) {
      expect(hasBranch(repo, 'overhaul--a1')).toBe(false);
    }
    expect(hasBranch(app.core, 'overhaul')).toBe(false);
  });

  it('list shows landed state; remove refuses unlanded, then removes after landing', () => {
    expect(worktreeAdd('a1', {with: 'server'}, deps(set))).toBe(0);
    const dir = path.join(tmp, 'wt', 'overhaul-a1');
    const nested = path.join(dir, 'packages-local', '_linked-server');
    commit(dir);
    commit(nested);
    let [entry] = listAgentWorktrees(set, makeRun(set)).sets;
    expect(entry).toMatchObject({agent: 'a1', dir, branch: 'overhaul--a1', landed: false});
    expect(entry.packages.map((p) => [p.rel, p.landed])).toEqual([['packages-local/_linked-server', false]]);

    const d = deps(set);
    expect(worktreeRemove('a1', {}, d)).not.toBe(0);
    expect(fs.existsSync(dir)).toBe(true);
    expect(fs.existsSync(nested)).toBe(true);

    g(set, 'merge', '--ff-only', '-q', 'overhaul--a1');
    g(path.join(set, 'packages-local', '_linked-server'), 'merge', '--ff-only', '-q', 'overhaul--a1');
    [entry] = listAgentWorktrees(set, makeRun(set)).sets;
    expect(entry.landed).toBe(true);
    expect(entry.packages[0].landed).toBe(true);

    const rd = deps(set);
    expect(worktreeRemove('a1', {}, rd)).toBe(0);
    expect(rd.err).toEqual([]);
    expect(fs.existsSync(dir)).toBe(false);
    expect(hasBranch(app.root, 'overhaul--a1')).toBe(false);
    expect(hasBranch(app.server, 'overhaul--a1')).toBe(false);
    expect(listAgentWorktrees(set, makeRun(set)).sets).toEqual([]);
    // The integration set and the main checkouts stay.
    expect(head(set)).toBe('overhaul');
    expect(head(app.root)).toBe('main');
  });

  it('remove --force keeps unlanded branches', () => {
    expect(worktreeAdd('a1', {with: 'server'}, deps(set))).toBe(0);
    const dir = path.join(tmp, 'wt', 'overhaul-a1');
    commit(dir);
    expect(worktreeRemove('a1', {force: true}, deps(set))).toBe(0);
    expect(fs.existsSync(dir)).toBe(false);
    expect(hasBranch(app.root, 'overhaul--a1')).toBe(true);
    // The server's agent branch had nothing new: landed, deleted.
    expect(hasBranch(app.server, 'overhaul--a1')).toBe(false);
  });
});
