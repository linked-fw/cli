/**
 * `linked branch status` and `linked branch start` against real git: an app
 * root with two `packages-local/` checkouts, each a repo on `main` with one
 * commit.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {branchStart, branchStatus} from '../../../src/commands/branch.js';
import {getTarget} from '../../../src/integration/repos.js';
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

function initRepo(dir: string, name: string, extra: Record<string, string> = {}): void {
  fs.mkdirSync(dir, {recursive: true});
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({name}));
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

/** The app root, `packages-local/_linked-core` and `packages-local/_linked-server`. */
function makeApp(): {root: string; core: string; server: string} {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'branch-app-')));
  tmpDirs.push(root);
  initRepo(root, 'my-app', {'.gitignore': 'packages-local/\n'});
  const core = path.join(root, 'packages-local', '_linked-core');
  const server = path.join(root, 'packages-local', '_linked-server');
  initRepo(core, '@_linked/core');
  initRepo(server, '@_linked/server');
  return {root, core, server};
}

const branchOf = (dir: string): string => git(dir, 'rev-parse', '--abbrev-ref', 'HEAD');
const hasBranch = (dir: string, name: string): boolean =>
  git(dir, 'branch', '--list', name) !== '';

describe('linked branch start', () => {
  test('start switches root and named package and records target', async () => {
    const {root, core, server} = makeApp();
    const result = await branchStart(root, 'overhaul', 'main', ['@_linked/core']);
    assert.equal(result.code, 0, result.messages.join('\n'));
    assert.equal(branchOf(root), 'overhaul');
    assert.equal(branchOf(core), 'overhaul');
    assert.equal(branchOf(server), 'main');
    assert.equal(await getTarget(root, 'overhaul'), 'main');
    assert.equal(await getTarget(core, 'overhaul'), 'main');
    assert.equal(hasBranch(server, 'overhaul'), false);
  });

  test('start matches a package by short name or dir name', async () => {
    const {root, core, server} = makeApp();
    const result = await branchStart(root, 'overhaul', 'main', ['core', '_linked-server']);
    assert.equal(result.code, 0, result.messages.join('\n'));
    assert.equal(branchOf(core), 'overhaul');
    assert.equal(branchOf(server), 'overhaul');
  });

  test('start switches to an existing branch instead of creating it', async () => {
    const {root, core} = makeApp();
    git(core, 'branch', 'overhaul');
    git(core, 'commit', '-q', '--allow-empty', '-m', 'on main after the branch');
    const result = await branchStart(root, 'overhaul', 'main', ['core']);
    assert.equal(result.code, 0, result.messages.join('\n'));
    assert.equal(branchOf(core), 'overhaul');
    // Kept the existing branch rather than re-creating it from main's tip.
    assert.notEqual(git(core, 'rev-parse', 'overhaul'), git(core, 'rev-parse', 'main'));
  });

  test('start refuses on dirty tree', async () => {
    const {root, core} = makeApp();
    fs.writeFileSync(path.join(core, 'untracked.txt'), 'x');
    const result = await branchStart(root, 'overhaul', 'main', ['@_linked/core']);
    assert.notEqual(result.code, 0);
    assert.match(result.messages.join('\n'), /packages-local\/_linked-core/);
    assert.equal(branchOf(root), 'main');
    assert.equal(branchOf(core), 'main');
    assert.equal(hasBranch(root, 'overhaul'), false);
    assert.equal(hasBranch(core, 'overhaul'), false);
    assert.equal(await getTarget(root, 'overhaul'), null);
  });

  test('start rejects name with --', async () => {
    const {root} = makeApp();
    const result = await branchStart(root, 'overhaul--x', 'main', []);
    assert.notEqual(result.code, 0);
    assert.match(result.messages.join('\n'), /--/);
    assert.equal(branchOf(root), 'main');
    assert.equal(hasBranch(root, 'overhaul--x'), false);
  });

  test('unknown package name errors', async () => {
    const {root} = makeApp();
    const result = await branchStart(root, 'overhaul', 'main', ['@_linked/nope']);
    assert.notEqual(result.code, 0);
    const text = result.messages.join('\n');
    assert.match(text, /@_linked\/nope/);
    assert.match(text, /@_linked\/core/);
    assert.match(text, /@_linked\/server/);
    assert.equal(branchOf(root), 'main');
    assert.equal(hasBranch(root, 'overhaul'), false);
  });
});

describe('linked branch start: atomicity', () => {
  test('start refuses name === target', async () => {
    const {root} = makeApp();
    const result = await branchStart(root, 'main', 'main', []);
    assert.notEqual(result.code, 0);
    assert.match(result.messages.join('\n'), /is the target itself/);
    assert.equal(await getTarget(root, 'main'), null);
  });

  test('start refuses a branch checked out elsewhere', async () => {
    const {root, core} = makeApp();
    git(core, 'branch', 'overhaul');
    const elsewhere = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'branch-wt-')));
    tmpDirs.push(elsewhere);
    const wtDir = path.join(elsewhere, 'core');
    git(core, 'worktree', 'add', '-q', wtDir, 'overhaul');
    const result = await branchStart(root, 'overhaul', 'main', ['core']);
    assert.notEqual(result.code, 0);
    const text = result.messages.join('\n');
    assert.match(text, /checked out in another worktree of packages-local\/_linked-core/);
    assert.match(text, /nothing was switched/);
    assert.equal(branchOf(root), 'main');
    assert.equal(hasBranch(root, 'overhaul'), false);
    assert.equal(await getTarget(root, 'overhaul'), null);
  });

  test('start undoes earlier switches when one fails', async () => {
    const {root, core, server} = makeApp();
    // core already has the branch (switched to, not created); root gets it created.
    git(core, 'branch', 'overhaul');
    git(root, 'config', 'branch.overhaul.linked-target', 'old-target');
    const real = makeRun(root);
    const run: Run = (cmd, args, opts) =>
      cmd === 'git' && args[0] === 'switch' && opts?.cwd === server && args.includes('overhaul')
        ? {status: 1, stdout: '', stderr: 'simulated failure'}
        : real(cmd, args, opts);
    const result = await branchStart(root, 'overhaul', 'main', ['core', 'server'], run);
    assert.notEqual(result.code, 0);
    const text = result.messages.join('\n');
    assert.match(text, /packages-local\/_linked-server: git switch -c overhaul main failed: simulated failure/);
    assert.match(text, /back where they were/);
    assert.equal(branchOf(root), 'main');
    assert.equal(branchOf(core), 'main');
    assert.equal(branchOf(server), 'main');
    // Created by this run: gone. There before: kept.
    assert.equal(hasBranch(root, 'overhaul'), false);
    assert.equal(hasBranch(core, 'overhaul'), true);
    // Target entries back to what they were.
    assert.equal(await getTarget(root, 'overhaul'), 'old-target');
    assert.equal(await getTarget(core, 'overhaul'), null);
  });

  test('rollback keeps a created base another branch forked from', async () => {
    const {root, core, server} = makeApp();
    const real = makeRun(root);
    // root and core get overhaul created; another agent forks from root's before server fails.
    const run: Run = (cmd, args, opts) => {
      if (cmd === 'git' && args[0] === 'switch' && opts?.cwd === server && args.includes('overhaul')) {
        git(root, 'branch', 'overhaul--other', 'overhaul');
        return {status: 1, stdout: '', stderr: 'simulated failure'};
      }
      return real(cmd, args, opts);
    };
    const result = await branchStart(root, 'overhaul', 'main', ['core', 'server'], run);
    assert.notEqual(result.code, 0);
    assert.match(result.messages.join('\n'), /\.: kept overhaul at [0-9a-f]+: overhaul--other forked from it/);
    assert.equal(branchOf(root), 'main');
    assert.equal(branchOf(core), 'main');
    assert.equal(hasBranch(root, 'overhaul'), true);
    assert.equal(hasBranch(root, 'overhaul--other'), true);
    assert.equal(await getTarget(root, 'overhaul'), 'main');
    // Nothing forked from core's: removed as before.
    assert.equal(hasBranch(core, 'overhaul'), false);
    assert.equal(await getTarget(core, 'overhaul'), null);
  });
});

describe('linked branch status', () => {
  test('status flags a repo off-branch', async () => {
    const {root, core} = makeApp();
    assert.equal((await branchStart(root, 'overhaul', 'main', [])).code, 0);
    git(core, 'switch', '-q', '-c', 'feature-x');
    const status = await branchStatus(root);
    assert.deepEqual(status.integration, {branch: 'overhaul', target: 'main'});
    const byRepo = Object.fromEntries(status.rows.map((r) => [r.repo, r]));
    assert.equal(byRepo['packages-local/_linked-core'].flag, 'off-branch');
    assert.equal(byRepo['packages-local/_linked-core'].branch, 'feature-x');
    // Still on main, the integration's target: not flagged.
    assert.equal(byRepo['packages-local/_linked-server'].flag, '');
    assert.equal(byRepo['.'].flag, '');
  });

  test('status counts ahead', async () => {
    const {root} = makeApp();
    assert.equal((await branchStart(root, 'overhaul', 'main', ['core'])).code, 0);
    git(root, 'commit', '-q', '--allow-empty', '-m', 'work');
    const status = await branchStatus(root);
    const rootRow = status.rows.find((r) => r.repo === '.');
    assert.ok(rootRow);
    assert.equal(rootRow.branch, 'overhaul');
    assert.equal(rootRow.target, 'main');
    assert.equal(rootRow.aheadTarget, 1);
    assert.equal(rootRow.behindTarget, 0);
    assert.equal(rootRow.aheadIntegration, 0);
    const coreRow = status.rows.find((r) => r.repo === 'packages-local/_linked-core');
    assert.ok(coreRow);
    assert.equal(coreRow.aheadTarget, 0);
    const serverRow = status.rows.find((r) => r.repo === 'packages-local/_linked-server');
    assert.ok(serverRow);
    // No overhaul branch in server: nothing to compare against.
    assert.equal(serverRow.aheadIntegration, null);
    assert.equal(serverRow.target, '');
  });

  test('status without an integration branch flags nothing', async () => {
    const {root, core} = makeApp();
    git(core, 'switch', '-q', '-c', 'feature-x');
    const status = await branchStatus(root);
    assert.equal(status.integration, null);
    assert.ok(status.rows.every((r) => r.flag === ''));
    assert.equal(status.rows.length, 3);
  });
});
