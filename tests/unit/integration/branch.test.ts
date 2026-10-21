import fs from 'node:fs';
import path from 'node:path';

import {branchStart, branchStatus, type CommandDeps} from '../../../src/commands/branch';
import {makeRun} from '../../../src/localize/run';
import {getTarget} from '../../../src/integration/repos';
import {commit, g, gOk, makeApp, makeRepo, rm, tmpdir} from './helpers';

function deps(cwd: string): CommandDeps & {out: string[]; err: string[]} {
  const out: string[] = [];
  const err: string[] = [];
  return {cwd, run: makeRun(cwd), log: (m) => out.push(m), error: (m) => err.push(m), out, err};
}

describe('linked branch', () => {
  let tmp: string;
  let app: ReturnType<typeof makeApp>;
  let schema: string;
  beforeEach(() => {
    tmp = tmpdir();
    app = makeApp(path.join(tmp, 'app'));
    // A third checkout the start does not name.
    schema = makeRepo(path.join(app.root, 'packages-local', '_linked-schema'), {name: '@_linked/schema'});
  });
  afterEach(() => rm(tmp));

  it('start creates the integration worktree set and records the target; main checkouts stay on main', () => {
    const d = deps(app.root);
    expect(branchStart('overhaul', ['core'], {target: 'main'}, d)).toBe(0);
    const dir = path.join(tmp, 'wt', 'overhaul');
    const nested = path.join(dir, 'packages-local', '_linked-core');
    expect(g(dir, 'symbolic-ref', '--short', 'HEAD')).toBe('overhaul');
    expect(g(nested, 'symbolic-ref', '--short', 'HEAD')).toBe('overhaul');
    expect(fs.statSync(path.join(nested, '.git')).isFile()).toBe(true);
    for (const repo of [app.root, app.core, app.server, schema])
      expect(g(repo, 'symbolic-ref', '--short', 'HEAD')).toBe('main');
    expect(getTarget(app.root, 'overhaul')).toBe('main');
    expect(getTarget(app.core, 'overhaul')).toBe('main');
    // Read from the worktrees too: one config per repository.
    expect(getTarget(nested, 'overhaul')).toBe('main');
    expect(gOk(app.server, 'show-ref', '--verify', '--quiet', 'refs/heads/overhaul')).toBe(false);
    expect(fs.lstatSync(path.join(dir, 'node_modules')).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(path.join(dir, '.env'))).toBe(path.join(app.root, '.env'));
    expect(fs.existsSync(path.join(dir, 'secret.pem'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'packages-local', '_linked-server'))).toBe(false);
    expect(g(dir, 'status', '--porcelain')).toBe('');
  });

  it('start reuses an existing branch', () => {
    g(app.core, 'branch', 'overhaul');
    expect(branchStart('overhaul', ['@_linked/core'], {target: 'main', dir: path.join(tmp, 'set')}, deps(app.root))).toBe(0);
    expect(g(path.join(tmp, 'set', 'packages-local', '_linked-core'), 'symbolic-ref', '--short', 'HEAD')).toBe('overhaul');
  });

  it('start refuses on a dirty tree before creating anything', () => {
    fs.writeFileSync(path.join(app.core, 'untracked.txt'), 'x');
    const d = deps(app.root);
    expect(branchStart('overhaul', ['core'], {target: 'main'}, d)).not.toBe(0);
    expect(d.err.join('\n')).toMatch(/packages-local\/_linked-core has uncommitted/);
    expect(fs.existsSync(path.join(tmp, 'wt', 'overhaul'))).toBe(false);
    for (const repo of [app.root, app.core]) {
      expect(g(repo, 'symbolic-ref', '--short', 'HEAD')).toBe('main');
      expect(gOk(repo, 'show-ref', '--verify', '--quiet', 'refs/heads/overhaul')).toBe(false);
    }
  });

  it('start refuses a name with --, an unknown package and a dir under a workspace glob', () => {
    expect(branchStart('a--b', [], {target: 'main'}, deps(app.root))).not.toBe(0);
    expect(branchStart('overhaul', ['nope'], {target: 'main'}, deps(app.root))).not.toBe(0);
    const inside = path.join(app.root, 'packages-local', 'x');
    expect(branchStart('overhaul', [], {target: 'main', dir: inside}, deps(app.root))).not.toBe(0);
    expect(fs.existsSync(inside)).toBe(false);
    expect(gOk(app.root, 'show-ref', '--verify', '--quiet', 'refs/heads/overhaul')).toBe(false);
  });

  it('status flags a repo off-branch', () => {
    expect(branchStart('overhaul', ['core', 'server'], {target: 'main'}, deps(app.root))).toBe(0);
    const dir = path.join(tmp, 'wt', 'overhaul');
    g(path.join(dir, 'packages-local', '_linked-core'), 'switch', '-q', '-c', 'feature-x');
    const rows = branchStatus(dir, makeRun(dir));
    expect(rows.map((r) => [r.rel, r.branch, r.flag])).toEqual([
      ['.', 'overhaul', null],
      ['packages-local/_linked-core', 'feature-x', 'off-branch'],
      ['packages-local/_linked-server', 'overhaul', null],
    ]);
  });

  it('status counts ahead', () => {
    expect(branchStart('overhaul', ['core'], {target: 'main'}, deps(app.root))).toBe(0);
    const dir = path.join(tmp, 'wt', 'overhaul');
    commit(dir);
    const [root, core] = branchStatus(dir, makeRun(dir));
    expect(root).toMatchObject({target: 'main', aheadTarget: 1, behindTarget: 0, aheadIntegration: 0});
    expect(core).toMatchObject({target: 'main', aheadTarget: 0, flag: null});
  });
});
