/**
 * Masters against real git: `linked branch start <m> --worktree`, steps made
 * with `linked worktree add --from <m>`, `worktree list/remove/relink` of
 * them, and `linked branch land <m>`.
 *
 * Each test gets a container dir holding the owner's app root `app/` on `dev`
 * (an integration branch with target `main`, as Create Now's is) with
 * `packages-local/_linked-server` and `packages-local/_linked-core` on `dev`,
 * and two app workspace members: `packages/access` (its entry is a build
 * output, built in the owner's checkout only) and `packages/chrome` (no
 * entry). The app has a bare `origin`.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {branchLand, branchStartWorktree} from '../../../src/commands/master.js';
import {worktreeAdd, worktreeList, worktreeRelink, worktreeRemove} from '../../../src/commands/worktree.js';
import {makeRun, type Run} from '../../../src/localize/run.js';

const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, {recursive: true, force: true});
});

function git(dir: string, ...args: string[]): string {
  const r = makeRun(dir)('git', args, {cwd: dir});
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} in ${dir}: ${r.stderr}`);
  return r.stdout.trim();
}
const gitOk = (dir: string, ...args: string[]): boolean => makeRun(dir)('git', args, {cwd: dir}).status === 0;

function initRepo(dir: string, files: Record<string, string>): void {
  fs.mkdirSync(dir, {recursive: true});
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), {recursive: true});
    fs.writeFileSync(path.join(dir, file), content);
  }
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  git(dir, 'config', 'core.hooksPath', '/dev/null');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'initial');
  git(dir, 'switch', '-q', '-c', 'dev');
  git(dir, 'config', 'branch.dev.linked-target', 'main');
}

interface App {
  container: string;
  root: string;
  server: string;
  core: string;
  origin: string;
}

function makeApp(): App {
  const container = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'master-app-')));
  tmpDirs.push(container);
  const root = path.join(container, 'app');
  initRepo(root, {
    'package.json': JSON.stringify({name: 'my-app', workspaces: ['packages/*', 'packages-local/*'], scripts: {'start:local': 'linked start'}}),
    '.gitignore': 'node_modules\npackages-local/\n.env\n.vite-cache/\n/apps\nlib/\n',
    'src.txt': 'app\n',
    'packages/access/package.json': JSON.stringify({name: '@_linked/access', main: 'lib/esm/index.js'}),
    'packages/chrome/package.json': JSON.stringify({name: '@create-now/chrome', exports: {'./chrome.css': './src/chrome.css'}}),
  });
  fs.writeFileSync(path.join(root, '.env'), `PORT=4040\nSITE_ROOT=http://localhost:4040\nCN_PROJECTS_ROOT=${root}/apps\n`);
  fs.mkdirSync(path.join(root, 'packages', 'access', 'lib', 'esm'), {recursive: true});
  fs.writeFileSync(path.join(root, 'packages', 'access', 'lib', 'esm', 'index.js'), '');
  fs.mkdirSync(path.join(root, 'packages', 'access', 'node_modules', '@types'), {recursive: true});

  const origin = path.join(container, 'origin.git');
  git(container, 'init', '-q', '--bare', origin);
  git(root, 'remote', 'add', 'origin', origin);
  git(root, 'push', '-q', 'origin', 'dev');

  const server = path.join(root, 'packages-local', '_linked-server');
  initRepo(server, {'package.json': JSON.stringify({name: '@_linked/server', dependencies: {'@_linked/core': '*'}}), 'server.txt': 'server\n', '.gitignore': 'node_modules\n'});
  fs.mkdirSync(path.join(server, 'node_modules', 'chalk'), {recursive: true});
  const core = path.join(root, 'packages-local', '_linked-core');
  initRepo(core, {'package.json': JSON.stringify({name: '@_linked/core'}), 'core.txt': 'core\n'});

  const nm = path.join(root, 'node_modules');
  fs.mkdirSync(path.join(nm, 'react'), {recursive: true});
  fs.mkdirSync(path.join(nm, '.bin'));
  fs.mkdirSync(path.join(nm, '@_linked'));
  fs.mkdirSync(path.join(nm, '@create-now'));
  fs.symlinkSync('../../packages-local/_linked-server', path.join(nm, '@_linked', 'server'));
  fs.symlinkSync('../../packages-local/_linked-core', path.join(nm, '@_linked', 'core'));
  fs.symlinkSync('../../packages/access', path.join(nm, '@_linked', 'access'));
  fs.symlinkSync('../../packages/chrome', path.join(nm, '@create-now', 'chrome'));
  return {container, root, server, core, origin};
}

const real = (p: string): string => fs.realpathSync(p);
const branchOf = (dir: string): string => git(dir, 'rev-parse', '--abbrev-ref', 'HEAD');
const marker = (dir: string) => JSON.parse(fs.readFileSync(path.join(dir, 'node_modules', '.linked-worktree.json'), 'utf8'));

function commit(dir: string, file: string, content: string, message = `change ${file}`): void {
  fs.writeFileSync(path.join(dir, file), content);
  git(dir, 'add', file);
  git(dir, 'commit', '-q', '-m', message);
}

/** A run that answers `npx …` (the builds) with success and records where it ran. */
function fakeBuilds(): {run: Run; builds: string[]} {
  const builds: string[] = [];
  const realRun = makeRun(process.cwd());
  const run: Run = (cmd, args, opts) => {
    if (cmd === 'npx') {
      builds.push(opts?.cwd ?? '');
      return {status: 0, stdout: '', stderr: ''};
    }
    return realRun(cmd, args, opts);
  };
  return {run, builds};
}

async function startMaster(app: App, name = 'm1', withPkgs = ['server']) {
  const result = await branchStartWorktree(app.root, name, {with: withPkgs});
  assert.equal(result.code, 0, result.messages.join('\n'));
  return result;
}

describe('linked branch start --worktree', () => {
  test('makes the master in a worktree, switching nothing, with records and a preview command', async () => {
    const app = makeApp();
    const result = await startMaster(app);
    const dir = path.join(app.container, 'wt', 'm1');
    assert.equal(result.dir, dir);
    // The owner's checkouts stay on dev.
    for (const repo of [app.root, app.server, app.core]) assert.equal(branchOf(repo), 'dev');
    assert.equal(branchOf(dir), 'm1');
    const pkgDir = path.join(dir, 'packages-local', '_linked-server');
    assert.equal(branchOf(pkgDir), 'm1');
    assert.equal(fs.existsSync(path.join(dir, 'packages-local', '_linked-core')), false);

    assert.equal(git(app.root, 'config', 'branch.m1.linked-target'), 'dev');
    assert.equal(git(app.root, 'config', 'branch.m1.linked-worktree'), dir);
    assert.equal(git(app.root, 'config', 'branch.m1.linked-port'), '4510');
    assert.equal(git(app.server, 'config', 'branch.m1.linked-target'), 'dev');
    assert.equal(git(app.server, 'config', 'branch.m1.linked-worktree'), pkgDir);
    assert.equal(gitOk(app.core, 'config', 'branch.m1.linked-target'), false);

    const m = marker(dir);
    assert.equal(m.installRoot, app.root);
    assert.equal(m.parent, undefined);
    assert.equal(real(path.join(dir, 'node_modules', '@_linked', 'server')), real(pkgDir));
    assert.equal(real(path.join(dir, 'node_modules', '@_linked', 'core')), real(app.core));
    // packages/chrome needs no build: the worktree's; packages/access is unbuilt there: the install's.
    assert.equal(real(path.join(dir, 'node_modules', '@create-now', 'chrome')), real(path.join(dir, 'packages', 'chrome')));
    assert.equal(real(path.join(dir, 'node_modules', '@_linked', 'access')), real(path.join(app.root, 'packages', 'access')));
    assert.equal(fs.readlinkSync(path.join(dir, 'packages', 'access', 'node_modules')), path.join(app.root, 'packages', 'access', 'node_modules'));
    assert.equal(fs.readlinkSync(path.join(pkgDir, 'node_modules')), path.join(app.server, 'node_modules'));

    assert.equal(
      result.startCommand,
      `cd ${dir} && PORT=4510 SITE_ROOT=http://localhost:4510 CN_PROJECTS_ROOT=${dir}/apps npm run start:local`,
    );
    assert.match(result.messages.join('\n'), /Not built here yet.*@_linked\/access/);
    // The master's worktree counts as clean.
    assert.equal(git(dir, 'status', '--porcelain'), '');
  });

  test('a second master gets the next port slot; refusals change nothing', async () => {
    const app = makeApp();
    await startMaster(app);
    const second = await branchStartWorktree(app.root, 'm2', {port: 4510});
    assert.equal(second.code, 1);
    assert.match(second.messages.join('\n'), /Port 4510 is master m1's/);
    const ok = await branchStartWorktree(app.root, 'm2', {});
    assert.equal(ok.code, 0, ok.messages.join('\n'));
    assert.equal(ok.port, 4520);

    const again = await branchStartWorktree(app.root, 'm1', {dir: path.join(app.container, 'elsewhere')});
    assert.equal(again.code, 1);
    assert.match(again.messages.join('\n'), /branch m1 already exists/);
    assert.equal(fs.existsSync(path.join(app.container, 'elsewhere')), false);

    const inWorktree = await branchStartWorktree(path.join(app.container, 'wt', 'm1'), 'm3', {});
    assert.equal(inWorktree.code, 1);
    assert.match(inWorktree.messages.join('\n'), /main checkout/);
    const dashes = await branchStartWorktree(app.root, 'a--b', {});
    assert.equal(dashes.code, 1);
  });
});

describe('linked worktree add --from', () => {
  test('a step branches from the master and its farm links straight into the install', async () => {
    const app = makeApp();
    await startMaster(app);
    const masterDir = path.join(app.container, 'wt', 'm1');
    const result = await worktreeAdd(app.root, 'a1', {from: 'm1', with: ['server'], port: 4512});
    assert.equal(result.code, 0, result.messages.join('\n'));
    const dir = path.join(app.container, 'wt', 'm1--a1');
    assert.equal(result.dir, dir);
    assert.equal(branchOf(dir), 'm1--a1');
    const pkgDir = path.join(dir, 'packages-local', '_linked-server');
    assert.equal(branchOf(pkgDir), 'm1--a1');
    // Nothing joined: the owner's and the master's checkouts are where they were.
    assert.equal(branchOf(app.server), 'dev');
    assert.equal(branchOf(path.join(masterDir, 'packages-local', '_linked-server')), 'm1');

    const m = marker(dir);
    assert.equal(m.installRoot, app.root);
    assert.equal(m.parent, masterDir);
    assert.equal(real(path.join(dir, 'node_modules', '@_linked', 'server')), real(pkgDir));
    assert.equal(real(path.join(dir, 'node_modules', 'react')), real(path.join(app.root, 'node_modules', 'react')));
    // The nested node_modules link is the install's own directory, not the master's link.
    assert.equal(fs.readlinkSync(path.join(pkgDir, 'node_modules')), path.join(app.server, 'node_modules'));
    assert.match(result.startCommand ?? '', /PORT=4512 SITE_ROOT=http:\/\/localhost:4512 npm run start:local$/);
    assert.match(result.messages.join('\n'), /merge --ff-only from the master's worktree/);
  });

  test("a step without the master's package gets the master's copy; one the master lacks is refused", async () => {
    const app = makeApp();
    await startMaster(app);
    const masterDir = path.join(app.container, 'wt', 'm1');
    // Run in the master's worktree: --from is implied.
    const detached = await worktreeAdd(masterDir, 'a2', {with: ['core']});
    assert.equal(detached.code, 1);
    assert.match(detached.messages.join('\n'), /master m1 has no package worktree matching "core"/);

    const appOnly = await worktreeAdd(masterDir, 'a2', {});
    assert.equal(appOnly.code, 0, appOnly.messages.join('\n'));
    const dir = path.join(app.container, 'wt', 'm1--a2');
    assert.equal(branchOf(dir), 'm1--a2');
    assert.equal(
      real(path.join(dir, 'node_modules', '@_linked', 'server')),
      real(path.join(masterDir, 'packages-local', '_linked-server')),
    );

    // relink keeps the master's overlays and the install root.
    fs.rmSync(path.join(dir, 'node_modules'), {recursive: true, force: true});
    fs.mkdirSync(path.join(dir, 'node_modules'));
    fs.writeFileSync(path.join(dir, 'node_modules', '.linked-worktree.json'), JSON.stringify({installRoot: app.root, overlays: {}, parent: masterDir}));
    const relinked = await worktreeRelink(app.root, 'm1--a2');
    assert.equal(relinked.code, 0, relinked.messages.join('\n'));
    assert.equal(
      real(path.join(dir, 'node_modules', '@_linked', 'server')),
      real(path.join(masterDir, 'packages-local', '_linked-server')),
    );
    assert.equal(marker(dir).parent, masterDir);
  });

  test('a packages/ member built in the worktree becomes its overlay on relink', async () => {
    const app = makeApp();
    await startMaster(app);
    const masterDir = path.join(app.container, 'wt', 'm1');
    fs.mkdirSync(path.join(masterDir, 'packages', 'access', 'lib', 'esm'), {recursive: true});
    fs.writeFileSync(path.join(masterDir, 'packages', 'access', 'lib', 'esm', 'index.js'), '');
    const r = await worktreeRelink(masterDir, undefined);
    assert.equal(r.code, 0, r.messages.join('\n'));
    assert.equal(real(path.join(masterDir, 'node_modules', '@_linked', 'access')), real(path.join(masterDir, 'packages', 'access')));
  });
});

describe('worktree list and remove with masters', () => {
  test('list groups the steps under their master; remove takes <m>--<agent>, then the master', async () => {
    const app = makeApp();
    await startMaster(app);
    const masterDir = path.join(app.container, 'wt', 'm1');
    assert.equal((await worktreeAdd(app.root, 'a1', {from: 'm1', with: ['server']})).code, 0);
    assert.equal((await worktreeAdd(app.root, 'own', {with: ['core']})).code, 0);

    const list = await worktreeList(app.root);
    assert.deepEqual(list.worktrees.map((w) => w.agent), ['own']);
    assert.equal(list.masters.length, 1);
    const [m] = list.masters;
    assert.equal(m.name, 'm1');
    assert.equal(m.port, 4510);
    assert.equal(m.worktree?.dir, masterDir);
    assert.equal(m.worktree?.landed, true);
    assert.deepEqual(m.steps.map((s) => [s.agent, s.landed]), [['a1', true]]);

    const stepDir = path.join(app.container, 'wt', 'm1--a1');
    commit(path.join(stepDir, 'packages-local', '_linked-server'), 'server.txt', 'step\n');
    const refused = await worktreeRemove(app.root, 'm1--a1');
    assert.equal(refused.code, 1);
    assert.match(refused.messages.join('\n'), /has not landed in m1/);

    // The step lands in the master; the master itself is not in dev yet.
    git(path.join(masterDir, 'packages-local', '_linked-server'), 'merge', '-q', '--ff-only', 'm1--a1');
    const masterRefused = await worktreeRemove(app.root, 'm1');
    assert.equal(masterRefused.code, 1);
    assert.match(masterRefused.messages.join('\n'), /still has step worktrees: a1/);

    const removed = await worktreeRemove(app.root, 'a1', {from: 'm1'});
    assert.equal(removed.code, 0, removed.messages.join('\n'));
    assert.equal(fs.existsSync(stepDir), false);
    assert.equal(gitOk(app.server, 'rev-parse', '--verify', '-q', 'refs/heads/m1--a1'), false);

    const unlanded = await worktreeRemove(app.root, 'm1');
    assert.equal(unlanded.code, 1);
    assert.match(unlanded.messages.join('\n'), /m1 has not landed in dev/);

    const landed = await branchLand(app.root, 'm1', {build: false, push: false});
    assert.equal(landed.code, 0, landed.messages.join('\n'));
    const gone = await worktreeRemove(app.root, 'm1');
    assert.equal(gone.code, 0, gone.messages.join('\n'));
    assert.equal(fs.existsSync(masterDir), false);
    assert.equal(gitOk(app.root, 'config', 'branch.m1.linked-worktree'), false);
    assert.equal(gitOk(app.server, 'rev-parse', '--verify', '-q', 'refs/heads/m1'), false);
    assert.equal((await worktreeList(app.root)).masters.length, 0);
  });
});

describe('linked branch land', () => {
  test('merges a moved target in and asks for a re-test, then fast-forwards, builds and pushes', async () => {
    const app = makeApp();
    await startMaster(app);
    const masterDir = path.join(app.container, 'wt', 'm1');
    const masterServer = path.join(masterDir, 'packages-local', '_linked-server');
    commit(masterServer, 'server.txt', 'master\n');
    commit(masterDir, 'src.txt', 'master\n');
    // The owner keeps working on dev meanwhile.
    commit(app.root, 'other.txt', 'owner\n');

    const devBefore = git(app.root, 'rev-parse', 'dev');
    const dry = await branchLand(app.root, 'm1', {dryRun: true});
    assert.equal(dry.code, 0, dry.messages.join('\n'));
    assert.match(dry.messages.join('\n'), /\.: would merge dev into m1/);
    assert.match(dry.messages.join('\n'), /packages-local\/_linked-server: would fast-forward dev by 1 commits/);
    assert.equal(git(app.root, 'rev-parse', 'dev'), devBefore);
    assert.equal(git(masterDir, 'log', '-1', '--format=%s'), 'change src.txt');

    const {run, builds} = fakeBuilds();
    const first = await branchLand(app.root, 'm1', {}, run);
    assert.equal(first.code, 3, first.messages.join('\n'));
    assert.match(first.messages.join('\n'), /Re-test needed/);
    assert.equal(git(masterDir, 'log', '-1', '--format=%s'), 'Merge dev into m1');
    assert.notEqual(git(app.root, 'rev-parse', 'dev'), git(app.root, 'rev-parse', 'm1'));

    const second = await branchLand(app.root, 'm1', {}, run);
    assert.equal(second.code, 0, second.messages.join('\n'));
    assert.deepEqual(second.repos.map((r) => [r.rel, r.result]), [
      ['packages-local/_linked-server', 'landed'],
      ['.', 'landed'],
    ]);
    assert.equal(git(app.root, 'rev-parse', 'dev'), git(app.root, 'rev-parse', 'm1'));
    assert.equal(git(app.server, 'rev-parse', 'dev'), git(app.server, 'rev-parse', 'm1'));
    assert.equal(branchOf(app.root), 'dev');
    assert.deepEqual(builds, [app.server]);
    assert.equal(git(app.origin, 'rev-parse', 'dev'), git(app.root, 'rev-parse', 'dev'));
    assert.equal(fs.readFileSync(path.join(app.root, 'src.txt'), 'utf8'), 'master\n');
  });

  test('a conflict stays in progress in the master and blocks the next run until it is committed', async () => {
    const app = makeApp();
    await startMaster(app);
    const masterDir = path.join(app.container, 'wt', 'm1');
    commit(masterDir, 'src.txt', 'master\n');
    commit(app.root, 'src.txt', 'owner\n');

    const r = await branchLand(app.root, 'm1', {build: false, push: false});
    assert.equal(r.code, 4, r.messages.join('\n'));
    assert.deepEqual(r.repos.find((x) => x.rel === '.')?.files, ['src.txt']);
    assert.ok(gitOk(masterDir, 'rev-parse', '-q', '--verify', 'MERGE_HEAD'));
    assert.equal(git(app.root, 'rev-parse', 'HEAD'), git(app.root, 'rev-parse', 'dev'));

    const blocked = await branchLand(app.root, 'm1', {build: false, push: false});
    assert.equal(blocked.code, 1);
    assert.match(blocked.messages.join('\n'), /a merge is in progress/);

    fs.writeFileSync(path.join(masterDir, 'src.txt'), 'both\n');
    git(masterDir, 'add', 'src.txt');
    git(masterDir, 'commit', '-q', '--no-edit');
    const done = await branchLand(app.root, 'm1', {build: false, push: false});
    assert.equal(done.code, 0, done.messages.join('\n'));
    assert.equal(fs.readFileSync(path.join(app.root, 'src.txt'), 'utf8'), 'both\n');
  });

  test('refuses, changing nothing, while the owner is dirty or a step has not landed', async () => {
    const app = makeApp();
    await startMaster(app);
    const masterDir = path.join(app.container, 'wt', 'm1');
    commit(masterDir, 'src.txt', 'master\n');
    assert.equal((await worktreeAdd(app.root, 'a1', {from: 'm1'})).code, 0);
    commit(path.join(app.container, 'wt', 'm1--a1'), 'step.txt', 'step\n');
    fs.writeFileSync(path.join(app.root, 'scratch.txt'), 'wip\n');
    const before = git(app.root, 'rev-parse', 'dev');

    const r = await branchLand(app.root, 'm1', {build: false, push: false});
    assert.equal(r.code, 1);
    const text = r.messages.join('\n');
    assert.match(text, /owner's checkout .* has uncommitted/);
    assert.match(text, /step a1 .* has not landed in m1: app/);
    assert.equal(git(app.root, 'rev-parse', 'dev'), before);

    const notMaster = await branchLand(app.root, 'nope', {});
    assert.equal(notMaster.code, 1);
    assert.match(notMaster.messages.join('\n'), /not a master/);
  });
});
