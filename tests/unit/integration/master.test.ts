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

import {branchAddPackage, branchLand, branchList, branchStartWorktree, formatBranchList} from '../../../src/commands/master.js';
import {worktreeAdd, worktreeList, worktreeRelink, worktreeRemove} from '../../../src/commands/worktree.js';
import {makeRun, type Run} from '../../../src/localize/run.js';

const tmpDirs: string[] = [];
const linkedHomeBefore = process.env.LINKED_HOME;
let linkedHome = '';
beforeEach(() => {
  // The machine-wide port registry and lock of these tests: never the real ~/.linked.
  linkedHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'master-home-')));
  tmpDirs.push(linkedHome);
  process.env.LINKED_HOME = linkedHome;
});
afterEach(() => {
  process.env.LINKED_HOME = linkedHomeBefore;
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, {recursive: true, force: true});
});

const registry = (): Record<string, {app: string; master: string; dir: string}> =>
  JSON.parse(fs.readFileSync(path.join(linkedHome, 'master-ports.json'), 'utf8'));

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

describe('the machine-wide preview port registry', () => {
  test('two masters started together in two apps sharing LINKED_HOME get different ports, both recorded', async () => {
    const a = makeApp();
    const b = makeApp();
    const [ra, rb] = await Promise.all([
      branchStartWorktree(a.root, 'ma', {with: ['server']}),
      branchStartWorktree(b.root, 'mb', {with: ['core']}),
    ]);
    assert.equal(ra.code, 0, ra.messages.join('\n'));
    assert.equal(rb.code, 0, rb.messages.join('\n'));
    assert.notEqual(ra.port, rb.port);
    assert.deepEqual([ra.port, rb.port].sort(), [4510, 4520]);
    assert.deepEqual(registry(), {
      [String(ra.port)]: {app: a.root, master: 'ma', dir: ra.dir},
      [String(rb.port)]: {app: b.root, master: 'mb', dir: rb.dir},
    });
    // The lock is released.
    assert.equal(fs.existsSync(path.join(linkedHome, 'locks', 'master-ports', 'linked.lock')), false);
  });

  test("--port held by another app's master (registry only) is refused, making nothing", async () => {
    const a = makeApp();
    const b = makeApp();
    await startMaster(a, 'ma');
    const refused = await branchStartWorktree(b.root, 'mb', {port: 4510});
    assert.equal(refused.code, 1);
    assert.match(refused.messages.join('\n'), new RegExp(`Port 4510 is master ma's \\(${path.join(a.container, 'wt', 'ma')}\\)\\. Pick another, or leave --port out\\.`));
    assert.equal(fs.existsSync(path.join(b.container, 'wt', 'mb')), false);
    assert.equal(gitOk(b.root, 'rev-parse', '--verify', '-q', 'refs/heads/mb'), false);
    assert.equal(gitOk(b.root, 'config', 'branch.mb.linked-worktree'), false);
    // Without --port, b's first master takes the next free slot on the machine.
    const ok = await branchStartWorktree(b.root, 'mb', {});
    assert.equal(ok.port, 4520, ok.messages.join('\n'));
  });

  test('an entry whose worktree is gone is ignored, and dropped at the next write', async () => {
    const app = makeApp();
    fs.writeFileSync(
      path.join(linkedHome, 'master-ports.json'),
      JSON.stringify({'4510': {app: '/nowhere/app', master: 'old', dir: path.join(app.container, 'gone')}}),
    );
    const r = await startMaster(app, 'm1');
    assert.equal(r.port, 4510);
    assert.deepEqual(Object.keys(registry()), ['4510']);
    assert.equal(registry()['4510'].master, 'm1');
  });

  test('removing a master releases its port', async () => {
    const a = makeApp();
    const b = makeApp();
    await startMaster(a, 'ma');
    await startMaster(b, 'mb');
    const landed = await branchLand(a.root, 'ma', {build: false, push: false});
    assert.equal(landed.code, 0, landed.messages.join('\n'));
    const removed = await worktreeRemove(a.root, 'ma');
    assert.equal(removed.code, 0, removed.messages.join('\n'));
    assert.match(removed.messages.join('\n'), /Released preview port 4510 on this machine/);
    assert.deepEqual(Object.keys(registry()), ['4520']);
    const again = await branchStartWorktree(b.root, 'mc', {});
    assert.equal(again.port, 4510, again.messages.join('\n'));
  });
});

describe('linked branch list', () => {
  test('a master and a plain integration branch, text and JSON, with the other apps\' masters', async () => {
    const app = makeApp();
    const other = makeApp();
    await startMaster(app, 'm1', ['server', 'core']);
    assert.equal((await worktreeAdd(app.root, 'a1', {from: 'm1', with: ['server']})).code, 0);
    git(app.core, 'config', 'branch.feature.linked-target', 'dev');
    const otherMaster = await startMaster(other, 'om', []);
    const masterDir = path.join(app.container, 'wt', 'm1');

    // Run in a step's worktree: it lists from the main checkout.
    const list = await branchList(path.join(app.container, 'wt', 'm1--a1'));
    assert.deepEqual(list, {
      branches: [
        {
          name: 'm1',
          kind: 'master',
          target: 'dev',
          repos: [
            {rel: '.', target: 'dev', worktree: masterDir},
            {rel: 'packages-local/_linked-core', target: 'dev', worktree: path.join(masterDir, 'packages-local', '_linked-core')},
            {rel: 'packages-local/_linked-server', target: 'dev', worktree: path.join(masterDir, 'packages-local', '_linked-server')},
          ],
          dir: masterDir,
          port: 4510,
          dataset: null,
          steps: ['a1'],
        },
        {name: 'dev', kind: 'integration', target: 'main', repos: [
          {rel: '.', target: 'main', worktree: null},
          {rel: 'packages-local/_linked-core', target: 'main', worktree: null},
          {rel: 'packages-local/_linked-server', target: 'main', worktree: null},
        ], dir: null, port: null, dataset: null, steps: []},
        {name: 'feature', kind: 'integration', target: 'dev', repos: [{rel: 'packages-local/_linked-core', target: 'dev', worktree: null}], dir: null, port: null, dataset: null, steps: []},
      ],
      otherPorts: [{port: 4520, app: other.root, master: 'om', dir: otherMaster.dir}],
    });

    const text = formatBranchList(list).split('\n');
    assert.match(text[0], /^BRANCH +KIND +TARGET +REPOS +WORKTREE +PORT +DATASET +STEPS$/);
    assert.match(text[1], new RegExp(`^m1 +master +dev +app, _linked-core, _linked-server +${masterDir} +4510 +- +1$`));
    assert.match(text[2], /^dev +integration +main +app, _linked-core, _linked-server +\(checkouts\) +- +- +-$/);
    assert.match(text[3], /^feature +integration +dev +_linked-core +\(checkouts\) +- +- +-$/);
    assert.equal(text[4], `Other masters on this machine: 4520 om (${other.root})`);
    // The JSON is the same data.
    assert.deepEqual(JSON.parse(JSON.stringify(list)), list);
  });

  test('an app with no records lists nothing', async () => {
    const app = makeApp();
    for (const repo of [app.root, app.server, app.core]) git(repo, 'config', '--unset', 'branch.dev.linked-target');
    const list = await branchList(app.root);
    assert.deepEqual(list, {branches: [], otherPorts: []});
    assert.equal(formatBranchList(list), 'No integration branches or masters.');
  });
});

describe('linked branch add-package', () => {
  test('adds a package worktree on <m> with its records; the master\'s and the step\'s farms gain it', async () => {
    const app = makeApp();
    await startMaster(app, 'm1', ['server']);
    const masterDir = path.join(app.container, 'wt', 'm1');
    assert.equal((await worktreeAdd(app.root, 'a1', {from: 'm1', with: ['server']})).code, 0);
    const stepDir = path.join(app.container, 'wt', 'm1--a1');
    assert.equal(real(path.join(stepDir, 'node_modules', '@_linked', 'core')), real(app.core));

    // Run in the step's worktree: it works from the main checkout.
    const result = await branchAddPackage(stepDir, 'm1', ['@_linked/core']);
    assert.equal(result.code, 0, result.messages.join('\n'));
    const coreDir = path.join(masterDir, 'packages-local', '_linked-core');
    assert.deepEqual(result.added, [{rel: 'packages-local/_linked-core', dir: coreDir, target: 'dev'}]);
    assert.deepEqual(result.relinked, [masterDir, stepDir]);
    assert.equal(branchOf(coreDir), 'm1');
    assert.equal(branchOf(app.core), 'dev');
    assert.equal(git(app.core, 'config', 'branch.m1.linked-target'), 'dev');
    assert.equal(git(app.core, 'config', 'branch.m1.linked-worktree'), coreDir);
    assert.equal(real(path.join(masterDir, 'node_modules', '@_linked', 'core')), real(coreDir));
    assert.equal(real(path.join(stepDir, 'node_modules', '@_linked', 'core')), real(coreDir));
    assert.equal(marker(stepDir).parent, masterDir);
    const text = result.messages.join('\n');
    assert.match(text, new RegExp(`${coreDir}: @_linked/core on m1`));
    assert.match(text, /Master m1 now has: _linked-core, _linked-server\nBuild each added package there: npx linked build$/);
    // The master's worktree stays clean, and branch list sees the package.
    assert.equal(git(masterDir, 'status', '--porcelain'), '');
    const listed = (await branchList(app.root)).branches.find((b) => b.name === 'm1');
    assert.deepEqual(listed?.repos.map((r) => r.rel), ['.', 'packages-local/_linked-core', 'packages-local/_linked-server']);
  });

  test('refusals change nothing', async () => {
    const app = makeApp();
    await startMaster(app, 'm1', ['server']);
    const masterDir = path.join(app.container, 'wt', 'm1');
    const snapshot = () => [
      git(app.core, 'worktree', 'list', '--porcelain'),
      git(app.server, 'worktree', 'list', '--porcelain'),
      makeRun(app.core)('git', ['config', '--get-regexp', '^branch\\.m1\\.'], {cwd: app.core}).stdout,
      fs.readdirSync(path.join(masterDir, 'packages-local')).join(','),
    ];
    const before = snapshot();
    const cases: [string, string[], RegExp][] = [
      ['nope', ['core'], /nope is not a master/],
      ['m1', ['server'], /already in master m1/],
      ['m1', ['core', 'unknown'], /unknown/],
    ];
    for (const [name, pkgs, why] of cases) {
      const r = await branchAddPackage(app.root, name, pkgs);
      assert.equal(r.code, 1, `${name} ${pkgs}`);
      assert.match(r.messages.join('\n'), why);
      assert.deepEqual(snapshot(), before);
    }
    const stray = path.join(app.container, 'stray-core');
    git(app.core, 'worktree', 'add', '-q', '-b', 'm1--x', stray, 'dev');
    const stepCopy = await branchAddPackage(app.root, 'm1', ['core']);
    assert.equal(stepCopy.code, 1);
    assert.match(stepCopy.messages.join('\n'), /a step of m1 has a worktree of it already .*on m1--x/);
    git(app.core, 'worktree', 'remove', '--force', stray);
    git(app.core, 'branch', '-D', 'm1--x');
    git(app.core, 'branch', 'm1');
    const exists = await branchAddPackage(app.root, 'm1', ['core']);
    assert.equal(exists.code, 1);
    assert.match(exists.messages.join('\n'), /packages-local\/_linked-core: branch m1 already exists\.\nNothing was made\./);
    git(app.core, 'branch', '-D', 'm1');
    git(app.core, 'switch', '-q', '--detach');
    const detached = await branchAddPackage(app.root, 'm1', ['core']);
    assert.match(detached.messages.join('\n'), /detached HEAD/);
    const missing = await branchAddPackage(app.root, 'm1', ['core'], {target: 'nowhere'});
    assert.match(missing.messages.join('\n'), /"nowhere" does not exist/);
    assert.deepEqual(snapshot().slice(2), before.slice(2));
  });

  test('a failing git worktree add undoes the packages added before it', async () => {
    const app = makeApp();
    await startMaster(app, 'm1', []);
    const masterDir = path.join(app.container, 'wt', 'm1');
    const realRun = makeRun(app.root);
    // Packages are made in packages-local/ order: _linked-core first, then _linked-server, which fails.
    const run: Run = (cmd, args, opts) =>
      cmd === 'git' && args[0] === 'worktree' && args[1] === 'add' && opts?.cwd === app.server
        ? {status: 128, stdout: '', stderr: 'fatal: boom'}
        : realRun(cmd, args, opts);
    const r = await branchAddPackage(app.root, 'm1', ['server', 'core'], {}, run);
    assert.equal(r.code, 1);
    const text = r.messages.join('\n');
    assert.match(text, /git worktree add -b m1 .* failed: fatal: boom/);
    assert.match(text, /Undid what this run had made\./);
    assert.deepEqual(r.added, []);
    assert.equal(fs.existsSync(path.join(masterDir, 'packages-local', '_linked-core')), false);
    assert.equal(gitOk(app.core, 'rev-parse', '--verify', '-q', 'refs/heads/m1'), false);
    assert.equal(gitOk(app.core, 'config', 'branch.m1.linked-target'), false);
    assert.equal(gitOk(app.core, 'config', 'branch.m1.linked-worktree'), false);
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

describe('review fixes', () => {
  test('land refuses while origin has commits the local target lacks', async () => {
    const app = makeApp();
    await startMaster(app);
    commit(path.join(app.container, 'wt', 'm1'), 'src.txt', 'master\n');
    // Someone else pushed to origin/dev.
    const other = path.join(app.container, 'other');
    git(app.container, 'clone', '-q', '-b', 'dev', app.origin, other);
    git(other, 'config', 'user.email', 't@e');
    git(other, 'config', 'user.name', 'T');
    commit(other, 'remote.txt', 'r\n');
    git(other, 'push', '-q', 'origin', 'dev');

    const r = await branchLand(app.root, 'm1', {build: false});
    assert.equal(r.code, 1);
    assert.match(r.messages.join('\n'), /origin\/dev has commits the local dev lacks/);
  });

  test('a landed package whose build fails is not pushed', async () => {
    const app = makeApp();
    await startMaster(app);
    const serverOrigin = path.join(app.container, 'server.git');
    git(app.container, 'init', '-q', '--bare', serverOrigin);
    git(app.server, 'remote', 'add', 'origin', serverOrigin);
    git(app.server, 'push', '-q', 'origin', 'dev');
    commit(path.join(app.container, 'wt', 'm1', 'packages-local', '_linked-server'), 'server.txt', 'm\n');
    const realRun = makeRun(process.cwd());
    const run: Run = (cmd, args, opts) => (cmd === 'npx' ? {status: 1, stdout: '', stderr: 'boom'} : realRun(cmd, args, opts));
    const r = await branchLand(app.root, 'm1', {}, run);
    assert.equal(r.code, 5, r.messages.join('\n'));
    assert.match(r.messages.join('\n'), /not pushed, because its build failed/);
    assert.notEqual(git(serverOrigin, 'rev-parse', 'dev'), git(app.server, 'rev-parse', 'dev'));
  });

  test('a step that overrides a dependency of a master package is warned; relink finds the master by name', async () => {
    const app = makeApp();
    await startMaster(app, 'm1', ['server', 'core']);
    const step = await worktreeAdd(app.root, 'a1', {from: 'm1', with: ['core']});
    assert.equal(step.code, 0, step.messages.join('\n'));
    assert.match(step.messages.join('\n'), /master's @_linked\/server depends on @_linked\/core/);
    const relinked = await worktreeRelink(app.root, 'm1');
    assert.equal(relinked.code, 0, relinked.messages.join('\n'));
  });

  test('a packages/ member with an unbuilt require entry stays the install\'s', async () => {
    const {memberUsable} = await import('../../../src/commands/worktree-node-modules.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'member-'));
    tmpDirs.push(dir);
    fs.mkdirSync(path.join(dir, 'lib', 'esm'), {recursive: true});
    fs.writeFileSync(path.join(dir, 'lib', 'esm', 'index.js'), '');
    const pkg = {main: 'lib/esm/index.js', exports: {'.': {types: './lib/esm/index.d.ts', import: './lib/esm/index.js', require: './lib/cjs/index.js'}}};
    assert.equal(memberUsable(dir, pkg), false);
    fs.mkdirSync(path.join(dir, 'lib', 'cjs'));
    fs.writeFileSync(path.join(dir, 'lib', 'cjs', 'index.js'), '');
    assert.equal(memberUsable(dir, pkg), true);
    assert.equal(memberUsable(dir, {exports: {'./x.css': './src/x.css'}}), true);
    assert.equal(memberUsable(dir, {exports: {'.': {development: './src/index.ts', default: './lib/esm/index.js'}}}), true);
  });
});
