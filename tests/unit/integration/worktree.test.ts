/**
 * `linked worktree add | list | remove` against real git. Each test gets a
 * container dir holding the app root `app/` (on integration branch
 * `overhaul`, target `main`) with `packages-local/_linked-server` (on
 * `overhaul` too) and `packages-local/_linked-core` (on `main`, untouched by
 * the work so far). The default worktree dir is then `<container>/wt/<agent>`.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {worktreeAdd, worktreeList, worktreeRelink, worktreeRemove} from '../../../src/commands/worktree.js';
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

const gitOk = (dir: string, ...args: string[]): boolean =>
  makeRun(dir)('git', args, {cwd: dir}).status === 0;

function initRepo(dir: string, pkg: Record<string, unknown>, extra: Record<string, string> = {}): void {
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

interface App {
  container: string;
  root: string;
  server: string;
  core: string;
  dir: string;
}

function makeApp(): App {
  const container = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'worktree-app-')));
  tmpDirs.push(container);
  const root = path.join(container, 'app');
  initRepo(
    root,
    {name: 'my-app', workspaces: ['packages/*', 'packages-local/*'], scripts: {'start:local': 'linked start'}},
    {'.gitignore': 'node_modules/\npackages-local/\n.env\n.env.local\n.vite-cache/\n*.pem\n'},
  );
  fs.mkdirSync(path.join(root, 'node_modules'));
  fs.writeFileSync(path.join(root, '.env'), 'PORT=4040\n');
  fs.writeFileSync(path.join(root, '.github-app.pem'), 'not a real key\n');
  git(root, 'switch', '-q', '-c', 'overhaul');
  git(root, 'config', 'branch.overhaul.linked-target', 'main');

  const server = path.join(root, 'packages-local', '_linked-server');
  initRepo(server, {name: '@_linked/server'}, {'.gitignore': 'node_modules/\n'});
  fs.mkdirSync(path.join(server, 'node_modules', 'chalk'), {recursive: true});
  git(server, 'switch', '-q', '-c', 'overhaul');
  git(server, 'config', 'branch.overhaul.linked-target', 'main');

  const core = path.join(root, 'packages-local', '_linked-core');
  initRepo(core, {name: '@_linked/core'});

  // The install, as npm lays it out: a registry package, a bin, the checkouts linked by name.
  const nm = path.join(root, 'node_modules');
  fs.mkdirSync(path.join(nm, 'react'));
  fs.writeFileSync(path.join(nm, 'react', 'package.json'), '{"name":"react"}');
  fs.mkdirSync(path.join(nm, '.bin'));
  fs.symlinkSync('../react/cli.js', path.join(nm, '.bin', 'react-cli'));
  fs.mkdirSync(path.join(nm, '.vite'));
  fs.writeFileSync(path.join(nm, '.package-lock.json'), '{}');
  fs.mkdirSync(path.join(nm, '@_linked'));
  fs.symlinkSync('../../packages-local/_linked-server', path.join(nm, '@_linked', 'server'));
  fs.symlinkSync('../../packages-local/_linked-core', path.join(nm, '@_linked', 'core'));
  return {container, root, server, core, dir: path.join(container, 'wt', 'a1')};
}

const branchOf = (dir: string): string => git(dir, 'rev-parse', '--abbrev-ref', 'HEAD');
const hasBranch = (dir: string, name: string): boolean => git(dir, 'branch', '--list', name) !== '';
const isLink = (p: string): boolean => {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
};
const real = (p: string): string => fs.realpathSync(p);

/**
 * `<app.dir>/node_modules` is a link farm into the root's install: a real
 * directory, the registry package and the checkouts not in `overlays` from the
 * root, each overlay from the worktree, `.bin` relinked, no lockfile or cache.
 */
function assertFarm(app: App, overlays: Record<string, string>): void {
  const nm = path.join(app.dir, 'node_modules');
  assert.ok(fs.lstatSync(nm).isDirectory() && !isLink(nm), `${nm} is a real directory`);
  const marker = JSON.parse(fs.readFileSync(path.join(nm, '.linked-worktree.json'), 'utf8'));
  assert.equal(marker.installRoot, app.root);
  assert.deepEqual(marker.overlays, overlays);
  assert.equal(real(path.join(nm, 'react')), real(path.join(app.root, 'node_modules', 'react')));
  assert.equal(fs.readlinkSync(path.join(nm, '.bin', 'react-cli')), '../react/cli.js');
  assert.equal(fs.existsSync(path.join(nm, '.vite')), false);
  assert.equal(fs.existsSync(path.join(nm, '.package-lock.json')), false);
  const expect: Record<string, string> = {'@_linked/server': app.server, '@_linked/core': app.core, ...overlays};
  for (const [name, dir] of Object.entries(expect)) {
    assert.equal(real(path.join(nm, name)), real(dir), name);
  }
}

const worktreeCount = (repo: string): number =>
  git(repo, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).length;

describe('linked worktree add', () => {
  test('add with --with server creates nested worktree on agent branch', async () => {
    const app = makeApp();
    const result = await worktreeAdd(app.root, 'a1', {with: ['server'], port: 4062});
    assert.equal(result.code, 0, result.messages.join('\n'));
    assert.equal(result.dir, app.dir);
    const pkgDir = path.join(app.dir, 'packages-local', '_linked-server');

    assert.ok(isLink(path.join(pkgDir, 'node_modules')));
    assert.equal(fs.readlinkSync(path.join(pkgDir, 'node_modules')), path.join(app.server, 'node_modules'));
    assert.ok(fs.lstatSync(path.join(pkgDir, '.git')).isFile());
    assert.equal(branchOf(pkgDir), 'overhaul--a1');
    assert.equal(branchOf(app.dir), 'overhaul--a1');

    assertFarm(app, {'@_linked/server': pkgDir});
    assert.equal(fs.readlinkSync(path.join(app.dir, '.env')), path.join(app.root, '.env'));
    const pemLinks = fs.readdirSync(app.dir).filter((n) => n.endsWith('.pem') && isLink(path.join(app.dir, n)));
    assert.equal(pemLinks.join(','), '');

    const text = result.messages.join('\n');
    assert.match(text, /\.github-app\.pem/);
    assert.ok(text.includes(`cd ${app.dir} && PORT=4062 npm run start:local`), text);
    assert.match(text, /npm install/);
  });

  test('--app-detached checks the app out at the base tip without a branch', async () => {
    const app = makeApp();
    const result = await worktreeAdd(app.root, 'a1', {with: ['server'], appDetached: true});
    assert.equal(result.code, 0, result.messages.join('\n'));
    assert.equal(gitOk(app.dir, 'symbolic-ref', '-q', 'HEAD'), false);
    assert.equal(git(app.dir, 'rev-parse', 'HEAD'), git(app.root, 'rev-parse', 'overhaul'));
    assert.equal(hasBranch(app.root, 'overhaul--a1'), false);
    assert.equal(branchOf(path.join(app.dir, 'packages-local', '_linked-server')), 'overhaul--a1');
  });

  test('add refuses --app-detached without --with', async () => {
    const app = makeApp();
    const result = await worktreeAdd(app.root, 'a1', {appDetached: true});
    assert.notEqual(result.code, 0);
    assert.match(result.messages.join('\n'), /nothing to land/);
    assert.match(result.messages.join('\n'), /another port, or pass --with/);
    assert.equal(fs.existsSync(app.dir), false);
    assert.equal(worktreeCount(app.root), 1);
    assert.equal(hasBranch(app.root, 'overhaul--a1'), false);
  });

  test('--dataset adds FUSEKI_DATASET and, when the app has the scripts, the clone commands', async () => {
    const app = makeApp();
    fs.mkdirSync(path.join(app.root, 'scripts'));
    fs.writeFileSync(path.join(app.root, 'scripts', 'backup-cn-state.sh'), '');
    fs.writeFileSync(path.join(app.root, 'scripts', 'restore-fuseki-dataset.sh'), '');
    const result = await worktreeAdd(app.root, 'a1', {port: 4063, dataset: 'cn-wt-a1'});
    assert.equal(result.code, 0, result.messages.join('\n'));
    const text = result.messages.join('\n');
    assert.ok(text.includes('PORT=4063 FUSEKI_DATASET=cn-wt-a1 npm run start:local'), text);
    assert.match(text, /restore-fuseki-dataset\.sh .* cn-wt-a1 --yes/);
  });

  test('add refuses dir inside packages-local', async () => {
    const app = makeApp();
    const dir = path.join(app.root, 'packages-local', 'x');
    const result = await worktreeAdd(app.root, 'a1', {with: ['server'], dir});
    assert.notEqual(result.code, 0);
    assert.equal(fs.existsSync(dir), false);
    assert.equal(hasBranch(app.root, 'overhaul--a1'), false);
    assert.equal(hasBranch(app.server, 'overhaul--a1'), false);
    assert.equal(worktreeCount(app.root), 1);
  });

  test('add refuses an existing dir', async () => {
    const app = makeApp();
    fs.mkdirSync(app.dir, {recursive: true});
    const result = await worktreeAdd(app.root, 'a1');
    assert.notEqual(result.code, 0);
    assert.match(result.messages.join('\n'), /already exists/);
    assert.equal(hasBranch(app.root, 'overhaul--a1'), false);
  });

  test('joins a package midway', async () => {
    const app = makeApp();
    const result = await worktreeAdd(app.root, 'a1', {with: ['core']});
    assert.equal(result.code, 0, result.messages.join('\n'));
    assert.equal(branchOf(app.core), 'overhaul');
    assert.equal(await getTarget(app.core, 'overhaul'), 'main');
    assert.equal(branchOf(path.join(app.dir, 'packages-local', '_linked-core')), 'overhaul--a1');
  });

  test('joining a dirty package changes nothing anywhere', async () => {
    const app = makeApp();
    fs.writeFileSync(path.join(app.core, 'untracked.txt'), 'x');
    const result = await worktreeAdd(app.root, 'a1', {with: ['server', 'core']});
    assert.notEqual(result.code, 0);
    assert.match(result.messages.join('\n'), /packages-local\/_linked-core/);
    assert.equal(fs.existsSync(app.dir), false);
    assert.equal(branchOf(app.core), 'main');
    assert.equal(hasBranch(app.core, 'overhaul'), false);
    for (const repo of [app.root, app.server, app.core]) {
      assert.equal(hasBranch(repo, 'overhaul--a1'), false);
      assert.equal(worktreeCount(repo), 1);
    }
  });

  test('a failing step undoes what the run created', async () => {
    const app = makeApp();
    const real = makeRun(app.root);
    // Fail the core worktree, after the join, the app worktree and the server worktree.
    const run: Run = (cmd, args, opts) =>
      args[0] === 'worktree' && args[1] === 'add' && opts?.cwd === app.core
        ? {status: 1, stdout: '', stderr: 'simulated failure'}
        : real(cmd, args, opts);
    const result = await worktreeAdd(app.root, 'a1', {with: ['server', 'core']}, run);
    assert.notEqual(result.code, 0);
    assert.match(result.messages.join('\n'), /simulated failure/);
    assert.equal(fs.existsSync(app.dir), false);
    assert.equal(branchOf(app.core), 'main');
    assert.equal(hasBranch(app.core, 'overhaul'), false);
    assert.equal(await getTarget(app.core, 'overhaul'), null);
    for (const repo of [app.root, app.server, app.core]) {
      assert.equal(hasBranch(repo, 'overhaul--a1'), false);
      assert.equal(worktreeCount(repo), 1);
    }
  });

  test('add rejects an invalid agent name before changing anything', async () => {
    const app = makeApp();
    const result = await worktreeAdd(app.root, 'a..b', {with: ['core']});
    assert.notEqual(result.code, 0);
    assert.match(result.messages.join('\n'), /invalid agent name/);
    assert.equal(fs.existsSync(path.join(app.container, 'wt')), false);
    assert.equal(branchOf(app.core), 'main');
    assert.equal(hasBranch(app.core, 'overhaul'), false);
    for (const repo of [app.root, app.server, app.core]) assert.equal(worktreeCount(repo), 1);
  });

  test('rollback when setTarget throws', async () => {
    const app = makeApp();
    const real = makeRun(app.root);
    const run: Run = (cmd, args, opts) =>
      args[0] === 'config' && args[1] === 'branch.overhaul.linked-target' && opts?.cwd === app.core
        ? {status: 1, stdout: '', stderr: 'simulated config failure'}
        : real(cmd, args, opts);
    const result = await worktreeAdd(app.root, 'a1', {with: ['server', 'core']}, run);
    assert.notEqual(result.code, 0);
    assert.match(result.messages.join('\n'), /simulated config failure/);
    assert.match(result.messages.join('\n'), /Undid/);
    assert.equal(fs.existsSync(app.dir), false);
    assert.equal(branchOf(app.core), 'main');
    assert.equal(hasBranch(app.core, 'overhaul'), false);
    for (const repo of [app.root, app.server, app.core]) {
      assert.equal(hasBranch(repo, 'overhaul--a1'), false);
      assert.equal(worktreeCount(repo), 1);
    }
  });

  test('rollback never removes a dir it did not create', async () => {
    const app = makeApp();
    const real = makeRun(app.root);
    // Another run makes the dir between the checks and this run's worktree add.
    const run: Run = (cmd, args, opts) => {
      if (args[0] === 'worktree' && args[1] === 'add' && opts?.cwd === app.root) {
        fs.mkdirSync(app.dir, {recursive: true});
        fs.writeFileSync(path.join(app.dir, 'theirs.txt'), 'x');
      }
      return real(cmd, args, opts);
    };
    const result = await worktreeAdd(app.root, 'a1', {with: ['core']}, run);
    assert.notEqual(result.code, 0);
    assert.ok(fs.existsSync(path.join(app.dir, 'theirs.txt')));
    assert.equal(branchOf(app.core), 'main');
    assert.equal(hasBranch(app.core, 'overhaul'), false);
  });

  test('rollback keeps a base branch that moved', async () => {
    const app = makeApp();
    const real = makeRun(app.root);
    // Someone commits on the core's new overhaul, then the core worktree fails.
    const run: Run = (cmd, args, opts) => {
      if (args[0] === 'worktree' && args[1] === 'add' && opts?.cwd === app.core) {
        git(app.core, 'commit', '-q', '--allow-empty', '-m', 'another agent');
        return {status: 1, stdout: '', stderr: 'simulated failure'};
      }
      return real(cmd, args, opts);
    };
    const moved = await worktreeAdd(app.root, 'a1', {with: ['core']}, run);
    assert.notEqual(moved.code, 0);
    assert.match(moved.messages.join('\n'), /kept overhaul at [0-9a-f]+: it moved/);
    assert.equal(branchOf(app.core), 'main');
    assert.equal(hasBranch(app.core, 'overhaul'), true);
    assert.equal(await getTarget(app.core, 'overhaul'), 'main');
    assert.equal(fs.existsSync(app.dir), false);
  });

  test('rollback keeps a created base another branch forked from', async () => {
    const app = makeApp();
    const real = makeRun(app.root);
    // The join created core's overhaul; another agent forks from it before the core worktree fails.
    const run: Run = (cmd, args, opts) => {
      if (args[0] === 'worktree' && args[1] === 'add' && opts?.cwd === app.core) {
        git(app.core, 'branch', 'overhaul--other', 'overhaul');
        return {status: 1, stdout: '', stderr: 'simulated failure'};
      }
      return real(cmd, args, opts);
    };
    const result = await worktreeAdd(app.root, 'a1', {with: ['core']}, run);
    assert.notEqual(result.code, 0);
    assert.match(result.messages.join('\n'), /kept overhaul at [0-9a-f]+: overhaul--other forked from it/);
    assert.equal(branchOf(app.core), 'main');
    assert.equal(hasBranch(app.core, 'overhaul'), true);
    assert.equal(hasBranch(app.core, 'overhaul--other'), true);
    assert.equal(await getTarget(app.core, 'overhaul'), 'main');
    assert.equal(fs.existsSync(app.dir), false);
  });

  test('.env links to the realpath', async () => {
    const app = makeApp();
    const shared = path.join(app.container, 'shared.env');
    fs.renameSync(path.join(app.root, '.env'), shared);
    fs.symlinkSync(shared, path.join(app.root, '.env'));
    const result = await worktreeAdd(app.root, 'a1');
    assert.equal(result.code, 0, result.messages.join('\n'));
    assert.equal(fs.readlinkSync(path.join(app.dir, '.env')), fs.realpathSync(shared));
    assert.match(result.messages.join('\n'), /node_modules: links into /);
    assertFarm(app, {});
  });

  test('the start command quotes a dir with spaces', async () => {
    const app = makeApp();
    const dir = path.join(app.container, 'my wt', 'a1');
    const result = await worktreeAdd(app.root, 'a1', {dir, port: 4062});
    assert.equal(result.code, 0, result.messages.join('\n'));
    assert.equal(result.startCommand, `cd '${dir}' && PORT=4062 npm run start:local`);
  });

  test('without an integration branch the base is the root branch', async () => {
    const app = makeApp();
    git(app.root, 'switch', '-q', 'main');
    git(app.server, 'switch', '-q', 'main');
    const result = await worktreeAdd(app.root, 'a1', {with: ['server'], appDetached: true});
    assert.equal(result.code, 0, result.messages.join('\n'));
    assert.equal(result.agentBranch, 'main--a1');
    assert.equal(branchOf(path.join(app.dir, 'packages-local', '_linked-server')), 'main--a1');
    assert.equal(await getTarget(app.server, 'main'), null);
  });
});

describe('linked worktree list', () => {
  test('list shows landed state', async () => {
    const app = makeApp();
    assert.equal((await worktreeAdd(app.root, 'a1', {with: ['server']})).code, 0);
    git(app.dir, 'commit', '-q', '--allow-empty', '-m', 'agent work');

    let list = await worktreeList(app.root);
    assert.equal(list.base, 'overhaul');
    assert.equal(list.worktrees.length, 1);
    let wt = list.worktrees[0];
    assert.equal(wt.agent, 'a1');
    assert.equal(wt.dir, app.dir);
    assert.equal(wt.branch, 'overhaul--a1');
    assert.equal(wt.landed, false);
    assert.equal(wt.packages.length, 1);
    assert.equal(wt.packages[0].packageName, '@_linked/server');
    assert.equal(wt.packages[0].branch, 'overhaul--a1');
    // No commits of its own yet: nothing to land.
    assert.equal(wt.packages[0].landed, true);

    git(app.root, 'merge', '-q', '--ff-only', 'overhaul--a1');
    list = await worktreeList(app.root);
    wt = list.worktrees[0];
    assert.equal(wt.landed, true);
  });

  test('a detached app worktree has no landed state', async () => {
    const app = makeApp();
    assert.equal((await worktreeAdd(app.root, 'a1', {with: ['server'], appDetached: true})).code, 0);
    const [wt] = (await worktreeList(app.root)).worktrees;
    assert.equal(wt.branch, null);
    assert.equal(wt.landed, null);
    assert.equal(wt.agent, 'a1');
    assert.equal(wt.agentWorktree, true);
  });

  test('list hides non-agent worktrees; --all shows them', async () => {
    const app = makeApp();
    assert.equal((await worktreeAdd(app.root, 'a1', {with: ['server']})).code, 0);
    const other = path.join(app.container, 'other');
    git(app.root, 'worktree', 'add', '-q', '-b', 'feature-x', other, 'overhaul');
    const bare = path.join(app.container, 'bare-detached');
    git(app.root, 'worktree', 'add', '-q', '--detach', bare, 'overhaul');

    const list = await worktreeList(app.root);
    assert.deepEqual(list.worktrees.map((w) => w.agent), ['a1']);
    const all = await worktreeList(app.root, {all: true});
    assert.deepEqual(all.worktrees.map((w) => w.dir).sort(), [app.dir, bare, other].sort());
    assert.ok(all.worktrees.every((w) => w.dir !== app.root));
    assert.equal(all.worktrees.find((w) => w.dir === other)?.agentWorktree, false);
  });
});

describe('linked worktree remove', () => {
  test('remove refuses unlanded', async () => {
    const app = makeApp();
    assert.equal((await worktreeAdd(app.root, 'a1', {with: ['server']})).code, 0);
    const pkgDir = path.join(app.dir, 'packages-local', '_linked-server');
    git(pkgDir, 'commit', '-q', '--allow-empty', '-m', 'package work');
    const result = await worktreeRemove(app.root, 'a1');
    assert.notEqual(result.code, 0);
    assert.match(result.messages.join('\n'), /not landed/);
    assert.ok(fs.existsSync(pkgDir));
    assert.ok(isLink(path.join(pkgDir, 'node_modules')));
    assertFarm(app, {'@_linked/server': pkgDir});
    assert.equal(worktreeCount(app.root), 2);
    assert.equal(worktreeCount(app.server), 2);
  });

  test('remove refuses a worktree with changes of its own', async () => {
    const app = makeApp();
    assert.equal((await worktreeAdd(app.root, 'a1', {with: ['server']})).code, 0);
    fs.writeFileSync(path.join(app.dir, 'notes.txt'), 'x');
    const result = await worktreeRemove(app.root, 'a1');
    assert.notEqual(result.code, 0);
    assert.match(result.messages.join('\n'), /notes\.txt/);
    assert.equal(worktreeCount(app.root), 2);
  });

  test('remove puts the links back when git worktree remove fails', async () => {
    const app = makeApp();
    assert.equal((await worktreeAdd(app.root, 'a1', {with: ['server']})).code, 0);
    const real = makeRun(app.root);
    const run: Run = (cmd, args, opts) =>
      args[0] === 'worktree' && args[1] === 'remove' && opts?.cwd === app.root
        ? {status: 1, stdout: '', stderr: 'simulated remove failure'}
        : real(cmd, args, opts);
    const result = await worktreeRemove(app.root, 'a1', {force: true}, run);
    assert.notEqual(result.code, 0);
    assert.match(result.messages.join('\n'), /simulated remove failure/);
    assert.ok(fs.existsSync(app.dir));
    // The package worktree is gone by then, so the rebuilt farm has no overlay.
    assertFarm(app, {});
    assert.ok(isLink(path.join(app.dir, '.env')));
    assert.equal(fs.readlinkSync(path.join(app.dir, '.env')), path.join(app.root, '.env'));
  });

  test('remove after landing removes worktrees and branches', async () => {
    const app = makeApp();
    assert.equal((await worktreeAdd(app.root, 'a1', {with: ['server']})).code, 0);
    const pkgDir = path.join(app.dir, 'packages-local', '_linked-server');
    git(pkgDir, 'commit', '-q', '--allow-empty', '-m', 'package work');
    git(app.dir, 'commit', '-q', '--allow-empty', '-m', 'app work');
    // The dev server's cache, which the app root does not ignore everywhere.
    fs.mkdirSync(path.join(app.dir, '.vite-cache', 'deps'), {recursive: true});
    git(app.server, 'merge', '-q', '--ff-only', 'overhaul--a1');
    git(app.root, 'merge', '-q', '--ff-only', 'overhaul--a1');

    const result = await worktreeRemove(app.root, 'a1');
    assert.equal(result.code, 0, result.messages.join('\n'));
    assert.equal(fs.existsSync(app.dir), false);
    assert.equal(worktreeCount(app.root), 1);
    assert.equal(worktreeCount(app.server), 1);
    assert.equal(hasBranch(app.root, 'overhaul--a1'), false);
    assert.equal(hasBranch(app.server, 'overhaul--a1'), false);
    // The shared install is untouched.
    assert.ok(fs.existsSync(path.join(app.server, 'node_modules', 'chalk')));
    assert.ok(fs.lstatSync(path.join(app.root, 'node_modules')).isDirectory());
  });

  test('remove --force keeps an unlanded branch and prints its sha', async () => {
    const app = makeApp();
    assert.equal((await worktreeAdd(app.root, 'a1', {with: ['server']})).code, 0);
    git(app.dir, 'commit', '-q', '--allow-empty', '-m', 'app work');
    const sha = git(app.root, 'rev-parse', '--short', 'overhaul--a1');
    fs.writeFileSync(path.join(app.dir, 'notes.txt'), 'x');
    const result = await worktreeRemove(app.root, 'a1', {force: true});
    assert.equal(result.code, 0, result.messages.join('\n'));
    assert.equal(fs.existsSync(app.dir), false);
    assert.equal(worktreeCount(app.root), 1);
    assert.equal(hasBranch(app.root, 'overhaul--a1'), true);
    assert.ok(result.messages.includes(`app: kept overhaul--a1 at ${sha} (not landed)`), result.messages.join('\n'));
    // The server branch had nothing of its own, so it counts as landed and goes.
    assert.equal(hasBranch(app.server, 'overhaul--a1'), false);
  });

  test('remove --delete-unlanded deletes it', async () => {
    const app = makeApp();
    assert.equal((await worktreeAdd(app.root, 'a1', {with: ['server']})).code, 0);
    git(app.dir, 'commit', '-q', '--allow-empty', '-m', 'app work');
    const sha = git(app.root, 'rev-parse', '--short', 'overhaul--a1');
    const result = await worktreeRemove(app.root, 'a1', {deleteUnlanded: true});
    assert.equal(result.code, 0, result.messages.join('\n'));
    assert.equal(fs.existsSync(app.dir), false);
    assert.equal(hasBranch(app.root, 'overhaul--a1'), false);
    assert.ok(result.messages.includes(`app: deleted overhaul--a1 (was ${sha}, not landed)`), result.messages.join('\n'));
  });

  test('remove finds a worktree outside the default dir', async () => {
    const app = makeApp();
    const dir = path.join(app.container, 'wt', 'wt', 'a1');
    assert.equal((await worktreeAdd(app.root, 'a1', {with: ['server'], dir})).code, 0);
    const result = await worktreeRemove(app.root, 'a1');
    assert.equal(result.code, 0, result.messages.join('\n'));
    assert.equal(fs.existsSync(dir), false);
    assert.equal(worktreeCount(app.root), 1);
    assert.equal(worktreeCount(app.server), 1);
  });

  test('remove finds a detached worktree by its package worktrees', async () => {
    const app = makeApp();
    const dir = path.join(app.container, 'elsewhere', 'a1');
    assert.equal((await worktreeAdd(app.root, 'a1', {with: ['server'], appDetached: true, dir})).code, 0);
    const result = await worktreeRemove(app.root, 'a1');
    assert.equal(result.code, 0, result.messages.join('\n'));
    assert.equal(fs.existsSync(dir), false);
    assert.equal(hasBranch(app.server, 'overhaul--a1'), false);
  });

  test('remove with nothing to find names --dir and worktree list', async () => {
    const app = makeApp();
    const result = await worktreeRemove(app.root, 'a1');
    assert.notEqual(result.code, 0);
    const text = result.messages.join('\n');
    assert.match(text, /--dir/);
    assert.match(text, /linked worktree list/);
  });
});

describe('linked worktree relink', () => {
  test('moves a worktree with a symlinked node_modules to the farm', async () => {
    const app = makeApp();
    assert.equal((await worktreeAdd(app.root, 'a1', {with: ['server']})).code, 0);
    const nm = path.join(app.dir, 'node_modules');
    fs.rmSync(nm, {recursive: true});
    fs.symlinkSync(path.join(app.root, 'node_modules'), nm);
    const result = await worktreeRelink(app.dir, undefined);
    assert.equal(result.code, 0, result.messages.join('\n'));
    assert.match(result.messages.join('\n'), /replaced the node_modules symlink/);
    assertFarm(app, {'@_linked/server': path.join(app.dir, 'packages-local', '_linked-server')});
    // The main checkout's install is as it was.
    assert.equal(fs.readlinkSync(path.join(app.root, 'node_modules', '@_linked', 'server')), '../../packages-local/_linked-server');
    assert.ok(fs.existsSync(path.join(app.root, 'node_modules', '.vite')));
  });

  test('links a package worktree added by hand, by agent name from the main checkout', async () => {
    const app = makeApp();
    assert.equal((await worktreeAdd(app.root, 'a1', {with: ['server']})).code, 0);
    fs.mkdirSync(path.join(app.core, 'node_modules'));
    git(app.core, 'switch', '-q', '-c', 'overhaul');
    const coreDir = path.join(app.dir, 'packages-local', '_linked-core');
    git(app.core, 'worktree', 'add', '-q', '-b', 'overhaul--a1', coreDir, 'overhaul');
    const result = await worktreeRelink(app.root, 'a1');
    assert.equal(result.code, 0, result.messages.join('\n'));
    assertFarm(app, {
      '@_linked/core': coreDir,
      '@_linked/server': path.join(app.dir, 'packages-local', '_linked-server'),
    });
    assert.equal(fs.readlinkSync(path.join(coreDir, 'node_modules')), path.join(app.core, 'node_modules'));
  });

  test('picks up a package the main checkout installed since', async () => {
    const app = makeApp();
    assert.equal((await worktreeAdd(app.root, 'a1')).code, 0);
    fs.mkdirSync(path.join(app.root, 'node_modules', 'lodash'));
    assert.equal(fs.existsSync(path.join(app.dir, 'node_modules', 'lodash')), false);
    assert.equal((await worktreeRelink(app.dir, undefined)).code, 0);
    assert.equal(real(path.join(app.dir, 'node_modules', 'lodash')), real(path.join(app.root, 'node_modules', 'lodash')));
  });

  test('leaves a real install of the worktree alone', async () => {
    const app = makeApp();
    assert.equal((await worktreeAdd(app.root, 'a1')).code, 0);
    const nm = path.join(app.dir, 'node_modules');
    fs.rmSync(nm, {recursive: true});
    fs.mkdirSync(path.join(nm, 'own'), {recursive: true});
    const result = await worktreeRelink(app.dir, undefined);
    assert.notEqual(result.code, 0);
    assert.match(result.messages.join('\n'), /install of the worktree's own/);
    assert.ok(fs.existsSync(path.join(nm, 'own')));
  });

  test('refuses in the main checkout without an agent', async () => {
    const app = makeApp();
    const result = await worktreeRelink(app.root, undefined);
    assert.notEqual(result.code, 0);
    assert.match(result.messages.join('\n'), /name the agent/);
  });
});
