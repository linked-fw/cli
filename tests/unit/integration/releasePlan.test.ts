/**
 * `linked release plan` against real git: an app root with
 * `packages-local/_linked-core` and `packages-local/_linked-server`, all on
 * integration branch `overhaul` (target `main`), and a fake `gh`.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {branchStart} from '../../../src/commands/branch.js';
import {
  NO_PR_SECTION,
  extractPrSection,
  formatReleasePlan,
  releasePlan,
  type ReleasePr,
} from '../../../src/commands/release.js';
import {makeRun, type Run} from '../../../src/localize/run.js';

const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

function git(dir: string, ...args: string[]): string {
  const r = makeRun(dir)('git', args, {cwd: dir});
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function initRepo(dir: string, pkg: object, extra: Record<string, string> = {}): void {
  fs.mkdirSync(dir, {recursive: true});
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg));
  for (const [file, content] of Object.entries(extra)) {
    fs.writeFileSync(path.join(dir, file), content);
  }
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  git(dir, 'config', 'core.hooksPath', '/dev/null');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'initial');
}

function commit(dir: string, file: string, content: string, message: string): void {
  fs.mkdirSync(path.dirname(path.join(dir, file)), {recursive: true});
  fs.writeFileSync(path.join(dir, file), content);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', message);
}

/** The app depends on core and server, server on core; all on `overhaul`. */
async function makeApp(): Promise<{root: string; core: string; server: string}> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'release-app-')));
  tmpDirs.push(root);
  initRepo(
    root,
    {name: 'my-app', dependencies: {'@_linked/core': '^1', '@_linked/server': '^1'}},
    {'.gitignore': 'packages-local/\n'},
  );
  const core = path.join(root, 'packages-local', '_linked-core');
  const server = path.join(root, 'packages-local', '_linked-server');
  initRepo(core, {name: '@_linked/core'});
  initRepo(server, {name: '@_linked/server', peerDependencies: {'@_linked/core': '^1'}});
  const r = await branchStart(root, 'overhaul', 'main', ['core', 'server']);
  assert.equal(r.code, 0, r.messages.join('\n'));
  return {root, core, server};
}

const pr = (number: number, head: string, base: string, state = 'OPEN'): ReleasePr => ({
  number,
  headRefName: head,
  baseRefName: base,
  state,
  url: `https://github.com/x/y/pull/${number}`,
  mergedAt: state === 'MERGED' ? '2026-10-01T00:00:00Z' : null,
});

/** A gh that prints `byDir[cwd]` (default none) as `gh pr list --json` would. */
function fakeGh(byDir: Record<string, ReleasePr[]> = {}): Run {
  return (_cmd, _args, opts) => ({
    status: 0,
    stdout: JSON.stringify(byDir[opts?.cwd ?? ''] ?? []),
    stderr: '',
  });
}

describe('linked release plan', () => {
  test('extracts the PR section', async () => {
    assert.equal(extractPrSection('# T\n\n## PR\n### Summary\nX\n## Details\nY\n'), '### Summary\nX');

    const {root, core} = await makeApp();
    commit(core, 'docs/reports/001-x.md', '# 001\n\n## PR\n### Summary\nX\n## Details\nY\n', 'report');
    const plan = await releasePlan(root, {gh: fakeGh()});
    const repo = plan.repos.find((r) => r.repo === 'packages-local/_linked-core')!;
    assert.deepEqual(repo.reports.map((r) => r.path), ['docs/reports/001-x.md']);
    assert.equal(repo.reports[0].pr, '### Summary\nX');
    assert.ok(!repo.reports[0].pr.includes('Y'));
  });

  test('report without PR section', async () => {
    const {root, core} = await makeApp();
    commit(core, 'docs/reports/002-y.md', '# 002\n\n## Details\nY\n', 'report');
    const plan = await releasePlan(root, {gh: fakeGh()});
    const repo = plan.repos.find((r) => r.repo === 'packages-local/_linked-core')!;
    assert.equal(repo.reports[0].pr, NO_PR_SECTION);
    assert.match(formatReleasePlan(plan), /no PR section/);
  });

  test('lists commits and changesets the target lacks', async () => {
    const {root, core} = await makeApp();
    commit(core, '.changeset/config.json', '{}', 'config');
    commit(core, '.changeset/README.md', '# readme', 'readme');
    commit(core, '.changeset/feat.md', '---\n"@_linked/core": minor\n---\nfeat', 'feat: one');
    const repo = (await releasePlan(root, {gh: fakeGh()})).repos.find(
      (r) => r.repo === 'packages-local/_linked-core',
    )!;
    assert.equal(repo.commits.count, 3);
    assert.equal(repo.commits.subjects[0], 'feat: one');
    assert.deepEqual(repo.changesets, ['.changeset/feat.md']);
  });

  test('orders by dependency', async () => {
    const {root} = await makeApp();
    const plan = await releasePlan(root, {gh: fakeGh()});
    assert.deepEqual(
      plan.repos.map((r) => r.repo),
      ['packages-local/_linked-core', 'packages-local/_linked-server', '.'],
    );
  });

  test('stack order', async () => {
    const {root, core} = await makeApp();
    commit(core, 'a.txt', 'a', 'a');
    const gh = fakeGh({
      [core]: [
        pr(12, 'overhaul--b', 'overhaul--a'),
        pr(11, 'overhaul--a', 'main'),
        pr(9, 'other--x', 'main'),
      ],
    });
    const repo = (await releasePlan(root, {gh})).repos.find(
      (r) => r.repo === 'packages-local/_linked-core',
    )!;
    assert.deepEqual(repo.prs.map((p) => p.headRefName), ['overhaul--a', 'overhaul--b']);
  });

  describe('next action', () => {
    test('open PRs: commits and no PR', async () => {
      const {root, core} = await makeApp();
      commit(core, 'a.txt', 'a', 'a');
      const plan = await releasePlan(root, {gh: fakeGh()});
      const byRepo = Object.fromEntries(plan.repos.map((r) => [r.repo, r.next]));
      assert.equal(byRepo['packages-local/_linked-core'], 'open PRs');
      assert.equal(byRepo['packages-local/_linked-server'], 'nothing to release');
    });

    test('waiting: a PR is open', async () => {
      const {root, core} = await makeApp();
      commit(core, 'a.txt', 'a', 'a');
      const gh = fakeGh({[core]: [pr(1, 'overhaul--a', 'main', 'MERGED'), pr(2, 'overhaul--b', 'overhaul--a')]});
      const repo = (await releasePlan(root, {gh})).repos[0];
      assert.equal(repo.next, 'waiting');
    });

    test('merge target back: all merged, target has commits the integration branch lacks', async () => {
      const {root, core} = await makeApp();
      commit(core, 'a.txt', 'a', 'a');
      git(core, 'branch', 'overhaul--a');
      git(core, 'switch', '-q', 'main');
      git(core, 'merge', '-q', '--no-ff', '-m', 'Merge pull request #1', 'overhaul--a');
      git(core, 'switch', '-q', 'overhaul');
      const gh = fakeGh({[core]: [pr(1, 'overhaul--a', 'main', 'MERGED')]});
      const repo = (await releasePlan(root, {gh})).repos[0];
      assert.equal(repo.commits.count, 0);
      assert.equal(repo.targetAhead, 1);
      assert.equal(repo.next, 'merge target back');
    });

    test('done: all merged, target merged back, nothing new', async () => {
      const {root, core} = await makeApp();
      commit(core, 'a.txt', 'a', 'a');
      git(core, 'branch', 'overhaul--a');
      git(core, 'switch', '-q', 'main');
      git(core, 'merge', '-q', '--no-ff', '-m', 'Merge pull request #1', 'overhaul--a');
      git(core, 'switch', '-q', 'overhaul');
      git(core, 'merge', '-q', '--no-ff', '-m', 'Merge main back', 'main');
      const gh = fakeGh({[core]: [pr(1, 'overhaul--a', 'main', 'MERGED')]});
      const repo = (await releasePlan(root, {gh})).repos[0];
      assert.equal(repo.commits.count, 0);
      assert.equal(repo.targetAhead, 0);
      assert.equal(repo.next, 'done');
    });
  });

  test('gh missing', async () => {
    const {root, core} = await makeApp();
    commit(core, 'a.txt', 'a', 'a');
    const gh: Run = () => {
      throw Object.assign(new Error('spawnSync gh ENOENT'), {code: 'ENOENT'});
    };
    const plan = await releasePlan(root, {gh});
    const repo = plan.repos[0];
    assert.equal(repo.prState, 'unknown');
    assert.equal(repo.prReason, 'gh not found');
    assert.equal(repo.next, 'PR state unknown');
    assert.match(formatReleasePlan(plan), /PR state unknown \(gh not found\)/);
  });

  test('no integration branch', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'release-app-')));
    tmpDirs.push(root);
    initRepo(root, {name: 'my-app'});
    const plan = await releasePlan(root, {gh: fakeGh()});
    assert.equal(plan.integration, null);
    assert.deepEqual(plan.repos, []);
    assert.match(formatReleasePlan(plan), /No integration branch/);
  });
});
