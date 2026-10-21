import fs from 'node:fs';
import path from 'node:path';

import {branchStart, type CommandDeps} from '../../../src/commands/branch';
import {
  extractPrSection,
  nextAction,
  releasePlan,
  runReleasePlanWith,
  stackOrder,
  type ReleasePr,
} from '../../../src/commands/release';
import {makeRun, type Run} from '../../../src/localize/run';
import {commit, g, makeApp, rm, tmpdir, writeJson} from './helpers';

const pr = (number: number, head: string, base: string, state = 'OPEN'): ReleasePr => ({
  number,
  headRefName: head,
  baseRefName: base,
  state,
  url: `https://example.test/pr/${number}`,
  mergedAt: state === 'MERGED' ? '2026-10-01T00:00:00Z' : null,
});

/** Real git, a fake `gh`. */
function withGh(cwd: string, gh: (dir: string) => {status: number; stdout: string; stderr: string}): Run {
  const real = makeRun(cwd);
  return (cmd, args, opts) => (cmd === 'gh' ? gh(opts?.cwd ?? cwd) : real(cmd, args, opts));
}

describe('linked release plan', () => {
  it('extracts the PR section', () => {
    const md = '# 091 — X\n\n## PR\n### Summary\nX\n## Details\nY\n';
    expect(extractPrSection(md)).toBe('### Summary\nX');
    expect(extractPrSection(md)).not.toContain('Y');
  });

  it('report without PR section', () => {
    expect(extractPrSection('# 1\n\n## Details\nY')).toBeNull();
  });

  it('stack order', () => {
    const order = stackOrder([pr(2, 'overhaul--b', 'overhaul--a'), pr(1, 'overhaul--a', 'main')]);
    expect(order.map((p) => p.headRefName)).toEqual(['overhaul--a', 'overhaul--b']);
  });

  it('next action, one case per state', () => {
    expect(nextAction({commits: ['x'], behind: 0, prs: []})).toBe('open PRs');
    expect(nextAction({commits: ['x'], behind: 0, prs: [pr(1, 'o--a', 'main')]})).toBe('waiting');
    expect(nextAction({commits: [], behind: 2, prs: [pr(1, 'o--a', 'main', 'MERGED')]})).toBe('merge target back');
    expect(nextAction({commits: [], behind: 0, prs: [pr(1, 'o--a', 'main', 'MERGED')]})).toBe('done');
  });

  describe('on an integration set', () => {
    let tmp: string;
    let app: ReturnType<typeof makeApp>;
    let set: string;
    beforeEach(() => {
      tmp = tmpdir();
      app = makeApp(path.join(tmp, 'app'));
      // The app depends on both packages, the server on core.
      writeJson(path.join(app.root, 'package.json'), {
        name: 'app',
        private: true,
        workspaces: ['packages/*', 'packages-local/*'],
        dependencies: {'@_linked/server': '^1.0.0', '@_linked/core': '^1.0.0'},
      });
      g(app.root, 'commit', '-qam', 'deps');
      set = path.join(tmp, 'wt', 'overhaul');
      const d: CommandDeps = {cwd: app.root, run: makeRun(app.root), log: () => {}, error: () => {}};
      expect(branchStart('overhaul', ['server', 'core'], {target: 'main'}, d)).toBe(0);
    });
    afterEach(() => rm(tmp));

    it('orders by dependency, reads reports and changesets, and picks the release PRs', () => {
      const core = path.join(set, 'packages-local', '_linked-core');
      fs.mkdirSync(path.join(core, 'docs', 'reports'), {recursive: true});
      fs.writeFileSync(path.join(core, 'docs', 'reports', '001-x.md'), '# 001\n\n## PR\n### Summary\nCore change\n\n## Details\nnotes\n');
      fs.mkdirSync(path.join(core, '.changeset'), {recursive: true});
      fs.writeFileSync(path.join(core, '.changeset', 'brave-cats.md'), '---\n"@_linked/core": minor\n---\nx\n');
      g(core, 'add', '-A');
      g(core, 'commit', '-qm', 'feat: core change');
      commit(set, 'app.txt', 'app change');
      const run = withGh(set, (dir) =>
        dir === core
          ? {
              status: 0,
              stdout: JSON.stringify([
                pr(7, 'overhaul--core-b', 'overhaul--core-a'),
                pr(6, 'overhaul--core-a', 'main'),
                pr(3, 'other', 'main'),
              ]),
              stderr: '',
            }
          : {status: 0, stdout: '[]', stderr: ''},
      );
      const plan = releasePlan(set, run);
      expect(plan.integration).toBe('overhaul');
      expect(plan.repos.map((r) => r.rel)).toEqual([
        'packages-local/_linked-core',
        'packages-local/_linked-server',
        '.',
      ]);
      const [c, s, a] = plan.repos;
      expect(c.commits).toEqual(['feat: core change']);
      expect(c.reports).toEqual([{path: 'docs/reports/001-x.md', prSection: '### Summary\nCore change'}]);
      expect(c.changesets).toEqual(['.changeset/brave-cats.md']);
      expect(c.prs!.map((p) => p.headRefName)).toEqual(['overhaul--core-a', 'overhaul--core-b']);
      expect(c.next).toBe('waiting');
      expect(s.next).toBe('done');
      expect(a.commits).toEqual(['app change']);
      expect(a.next).toBe('open PRs');
    });

    it('merge target back once everything merged and the target moved', () => {
      // The target gains a commit (a merged release PR's merge commit, say).
      commit(app.core, 'main.txt', 'on main');
      const run = withGh(set, () => ({status: 0, stdout: JSON.stringify([pr(1, 'overhaul--x', 'main', 'MERGED')]), stderr: ''}));
      const core = releasePlan(set, run).repos.find((r) => r.rel === 'packages-local/_linked-core')!;
      expect(core).toMatchObject({commits: [], behind: 1, next: 'merge target back'});
    });

    it('gh missing', () => {
      commit(set, 'app.txt', 'app change');
      const run = withGh(set, () => ({status: 1, stdout: '', stderr: 'spawnSync gh ENOENT'}));
      const plan = releasePlan(set, run);
      expect(plan.repos.every((r) => r.prs === null && r.prError === 'gh not found')).toBe(true);
      const out: string[] = [];
      expect(runReleasePlanWith({}, {cwd: set, run, log: (m) => out.push(m), error: () => {}})).toBe(0);
      expect(out.join('\n')).toContain('PR state unknown (gh not found)');
    });
  });
});
