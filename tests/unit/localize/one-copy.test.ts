/**
 * One copy, the details that make it safe and cheap enough to run before
 * every `linked start`:
 *
 * - which commands run the check (the preAction wiring);
 * - a copy that is already the app's (a symlink) is no hit;
 * - a copy prune would keep never reaches the prune, and costs no tree walk;
 * - a copy whose own dependencies would resolve differently from the app is kept;
 * - candidates are per checkout (one checkout's runtime dependency is not
 *   another's devDependency);
 * - one call converges;
 * - `--no-prune` is recorded and honoured.
 *
 * Real filesystem, stubbed subprocesses, as in prune.test.ts.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {Command} from 'commander';

import * as prune from '../../../src/localize/prune.js';
import {checkOneCopy, reinstall} from '../../../src/localize/ensure.js';
import {adopt} from '../../../src/localize/adopt.js';
import {relink} from '../../../src/localize/relink.js';
import {list} from '../../../src/localize/list.js';
import {readManifest, writeManifest} from '../../../src/localize/manifest.js';
import {checkoutNameFor} from '../../../src/localize/resolve.js';
import {
  ONE_COPY_COMMANDS,
  installOneCopyHook,
} from '../../../src/localize/one-copy-hook.js';
import {makeConsumer, rm, stubbed, test} from './helpers.js';

function consumer(t) {
  const root = makeConsumer();
  t.after(() => rm(root));
  return root;
}

function pkgAt(dir, json) {
  fs.mkdirSync(dir, {recursive: true});
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(json));
  return dir;
}

const appHas = (appRoot, name, version, extra = {}) =>
  pkgAt(path.join(appRoot, 'node_modules', name), {name, version, ...extra});

function checkout(appRoot, name, json) {
  const dir = path.join(appRoot, 'packages-local', checkoutNameFor(name));
  pkgAt(dir, {name, version: '1.0.0', ...json});
  fs.mkdirSync(path.join(dir, '.git'), {recursive: true});
  const link = path.join(appRoot, 'node_modules', name);
  fs.mkdirSync(path.dirname(link), {recursive: true});
  fs.rmSync(link, {recursive: true, force: true});
  fs.symlinkSync(path.relative(path.dirname(link), dir), link, 'dir');
  return dir;
}

const nested = (co, name, version, extra = {}) =>
  pkgAt(path.join(co, 'node_modules', name), {name, version, ...extra});
const has = (co, name) => fs.existsSync(path.join(co, 'node_modules', name));

const record = (appRoot, map, extra = {}) =>
  writeManifest(appRoot, {
    dir: 'packages-local',
    packages: Object.fromEntries(
      Object.entries(map).map(([name, p]) => [
        name,
        {
          repo: 'r',
          path: path.relative(appRoot, p as string),
          branch: 'main',
          ...(extra[name] ?? {}),
        },
      ]),
    ),
  });

function noRun(appRoot) {
  return stubbed(appRoot, (inv) => {
    throw new Error(`ran ${inv.cmd} ${inv.args.join(' ')}`);
  });
}

/** Count calls to `pruneProvided` made through the module (as ensure.ts makes them). */
function countPrunes(t) {
  const spy = jest.spyOn(prune, 'pruneProvided');
  t.after(() => spy.mockRestore());
  return () => spy.mock.calls.length;
}

// ---------------------------------------------------------------------------
// The preAction wiring
// ---------------------------------------------------------------------------

test('the check runs before exactly start, script, call and build-all', async () => {
  assert.deepEqual([...ONE_COPY_COMMANDS].sort(), [
    'build-all',
    'call',
    'script',
    'start',
  ]);
  const ran: string[] = [];
  const program = new Command();
  program
    .exitOverride()
    .configureOutput({writeOut: () => {}, writeErr: () => {}});
  installOneCopyHook(program, () => ran.push('check'));
  const names = [
    'start',
    'script',
    'call',
    'build-all',
    'localize',
    'build',
    'publish',
  ];
  for (const name of names) program.command(name).action(() => {});

  const triggered: string[] = [];
  for (const name of names) {
    ran.length = 0;
    await program.parseAsync(['node', 'linked', name]);
    if (ran.length) triggered.push(name);
  }
  ran.length = 0;
  for (const argv of [['help'], ['--help'], ['start', '--help']]) {
    try {
      await program.parseAsync(['node', 'linked', ...argv]);
    } catch {
      /* exitOverride: help "exits" */
    }
  }
  assert.deepEqual(triggered, ['start', 'script', 'call', 'build-all']);
  assert.equal(ran.length, 0, 'help never triggers it');

  // ...and the real program installs it, over commands with those names.
  const cli = fs.readFileSync(
    path.join(__dirname, '../../../src/cli.ts'),
    'utf8',
  );
  assert.match(cli, /^installOneCopyHook\(program\);$/m);
  for (const name of ONE_COPY_COMMANDS)
    assert.match(cli, new RegExp(`\\.command\\('${name}[ '\\]]`), name);
});

// ---------------------------------------------------------------------------
// Detection: cheap, and the same answer prune would give
// ---------------------------------------------------------------------------

test('a checkout copy that is a symlink to the app copy is no hit', (t) => {
  const appRoot = consumer(t);
  const core = appHas(appRoot, '@fw/core', '2.25.0');
  const b = checkout(appRoot, '@fw/b', {version: '1.0.0'});
  const a = checkout(appRoot, '@fw/a', {
    dependencies: {'@fw/core': '^2.0.0', '@fw/b': '^1.0.0'},
  });
  fs.mkdirSync(path.join(a, 'node_modules', '@fw'), {recursive: true});
  fs.symlinkSync(core, path.join(a, 'node_modules', '@fw', 'core'), 'dir');
  fs.symlinkSync(b, path.join(a, 'node_modules', '@fw', 'b'), 'dir');
  record(appRoot, {'@fw/a': a, '@fw/b': b});

  const prunes = countPrunes(t);
  const deps = noRun(appRoot);
  assert.deepEqual(checkOneCopy(appRoot, deps), {pruned: []});
  assert.equal(deps.output(), '');
  assert.equal(prunes(), 0);
  assert.ok(
    fs.lstatSync(path.join(a, 'node_modules', '@fw', 'core')).isSymbolicLink(),
  );
  assert.ok(
    fs.lstatSync(path.join(a, 'node_modules', '@fw', 'b')).isSymbolicLink(),
  );
});

/** A checkout full of copies prune keeps, inside a big node_modules. */
function keptOnly(t, {lockfile}) {
  const appRoot = consumer(t);
  appHas(appRoot, 'react', '19.1.0');
  appHas(appRoot, 'react-dom', '19.1.0', {
    peerDependencies: {react: '^19.1.0'},
  });
  appHas(appRoot, 'lib', '1.0.0');
  const a = checkout(appRoot, '@fw/a', {
    dependencies: {lib: '^1.0.0'},
    peerDependencies: {react: '^18.0.0', 'react-dom': '^18.0.0'},
  });
  // own range rules these out: decided from A's package.json alone
  nested(a, 'react', '18.3.1');
  nested(a, 'react-dom', '18.3.1', {peerDependencies: {react: '^18.3.1'}});
  // in A's range, but another installed package asks more than the app has
  nested(a, 'lib', '1.5.0');
  nested(a, 'needs-lib', '1.0.0', {dependencies: {lib: '^1.5.0'}});
  // bulk: none of it is a candidate
  for (let i = 0; i < 400; i++)
    nested(a, `filler-${i}`, '1.0.0', {dependencies: {lib: '*'}});
  if (lockfile) {
    const packages = {};
    for (const name of fs.readdirSync(path.join(a, 'node_modules'))) {
      packages[`node_modules/${name}`] = JSON.parse(
        fs.readFileSync(
          path.join(a, 'node_modules', name, 'package.json'),
          'utf8',
        ),
      );
    }
    fs.writeFileSync(
      path.join(a, 'node_modules', '.package-lock.json'),
      JSON.stringify({name: '@fw/a', lockfileVersion: 3, packages}),
    );
  }
  record(appRoot, {'@fw/a': a});
  return {appRoot, a};
}

test('kept copies never reach pruneProvided, and the index is read from the hidden lockfile without a walk', (t) => {
  const {appRoot, a} = keptOnly(t, {lockfile: true});
  const prunes = countPrunes(t);
  const readdir = jest.spyOn(fs, 'readdirSync');
  const reads = jest.spyOn(fs, 'readFileSync');
  t.after(() => {
    readdir.mockRestore();
    reads.mockRestore();
  });

  const started = performance.now();
  const deps = noRun(appRoot);
  assert.deepEqual(checkOneCopy(appRoot, deps), {pruned: []});
  const ms = performance.now() - started;

  assert.equal(prunes(), 0, 'nothing to remove: the prune is never entered');
  assert.equal(deps.output(), '');
  // One listing of A's node_modules, and no package.json per package in it
  // (402 there): the ranges come from the one hidden lockfile.
  assert.ok(
    readdir.mock.calls.length <= 3,
    `readdirSync x${readdir.mock.calls.length}`,
  );
  assert.ok(
    reads.mock.calls.length < 40,
    `readFileSync x${reads.mock.calls.length}`,
  );
  assert.ok(ms < 500, `took ${ms.toFixed(0)} ms`);
  assert.ok(has(a, 'react') && has(a, 'react-dom') && has(a, 'lib'));

  // planPrune agrees, and says why.
  const plan = prune.planPrune(readManifest(appRoot).entries, {appRoot});
  assert.deepEqual(plan.remove, []);
  assert.deepEqual(plan.keep.map((k) => `${k.dep}:${k.reason}`).sort(), [
    'lib:range',
    'react-dom:range',
    'react:range',
  ]);
});

test('without a hidden lockfile the tree is walked at most once per call, and only when a range must be read', (t) => {
  const {appRoot} = keptOnly(t, {lockfile: false});
  const entries = readManifest(appRoot).entries;
  const cache = prune.newPruneCache();
  prune.planPrune(entries, {appRoot}, {}, cache);
  assert.equal(cache.builds, 1, 'lib needs the index; react/react-dom do not');
  prune.planPrune(entries, {appRoot}, {}, cache);
  assert.equal(cache.builds, 1, 'the index is reused');

  // a tree whose kept copies are all ruled out by the checkout's own range: no index
  const appRoot2 = consumer(t);
  appHas(appRoot2, 'react', '19.1.0');
  const b = checkout(appRoot2, '@fw/b', {peerDependencies: {react: '^18.0.0'}});
  nested(b, 'react', '18.3.1');
  for (let i = 0; i < 50; i++) nested(b, `filler-${i}`, '1.0.0');
  record(appRoot2, {'@fw/b': b});
  const cache2 = prune.newPruneCache();
  const plan = prune.planPrune(
    readManifest(appRoot2).entries,
    {appRoot: appRoot2},
    {},
    cache2,
  );
  assert.equal(plan.keep.length, 1);
  assert.equal(cache2.builds, 0);
});

// ---------------------------------------------------------------------------
// Resolution context
// ---------------------------------------------------------------------------

test('a copy whose dependency would resolve to a different version from the app is kept', (t) => {
  const appRoot = consumer(t);
  appHas(appRoot, 'react', '19.1.0');
  appHas(appRoot, 'prism', '2.4.1', {peerDependencies: {react: '>=16.0.0'}});
  const a = checkout(appRoot, '@fw/a', {
    dependencies: {prism: '^2.4.1'},
    peerDependencies: {react: '^18.0.0'},
  });
  nested(a, 'react', '18.3.1'); // kept: A's range
  nested(a, 'prism', '2.4.1', {peerDependencies: {react: '>=16.0.0'}});
  record(appRoot, {'@fw/a': a});

  const deps = stubbed(appRoot);
  relink(deps);
  assert.ok(
    has(a, 'prism'),
    "from the app's copy, prism's react is 19 while the checkout keeps 18",
  );
  assert.match(
    deps.warns.join('\n'),
    /prism@2\.4\.1 \(its react would change\)/,
  );
  const listed = stubbed(appRoot);
  list({}, listed);
  assert.match(
    listed.output(),
    /fw-a\/node_modules\/prism@2\.4\.1: from the checkout its react is 18\.3\.1, from the app's copy 19\.1\.0/,
  );
});

test('the @types package TypeScript would take counts; the same version at another path does not', (t) => {
  const appRoot = consumer(t);
  appHas(appRoot, 'util', '1.0.0');
  appHas(appRoot, '@types/util', '2.0.0');
  appHas(appRoot, 'typed', '1.0.0', {dependencies: {util: '^1.0.0'}});
  appHas(appRoot, 'plain', '1.0.0', {dependencies: {util: '^1.0.0'}});
  const a = checkout(appRoot, '@fw/a', {
    dependencies: {typed: '^1.0.0', plain: '^1.0.0'},
  });
  nested(a, 'util', '1.0.0'); // same version, A's own copy: not a candidate in A
  nested(a, '@types/util', '1.0.0');
  nested(a, 'typed', '1.0.0', {dependencies: {util: '^1.0.0'}});
  record(appRoot, {'@fw/a': a});

  relink(stubbed(appRoot));
  assert.ok(
    has(a, 'typed'),
    "typed's @types/util would go from 1.0.0 to 2.0.0",
  );

  // Without the types mismatch, util at 1.0.0 in both places is the same code.
  fs.rmSync(path.join(a, 'node_modules', '@types'), {recursive: true});
  relink(stubbed(appRoot));
  assert.equal(has(a, 'typed'), false);
});

// ---------------------------------------------------------------------------
// Per-owner candidates, convergence
// ---------------------------------------------------------------------------

test("one checkout's runtime dependency does not make another's devDependency copy a candidate", (t) => {
  const appRoot = consumer(t);
  appHas(appRoot, 'tool-x', '3.2.0');
  const b = checkout(appRoot, '@fw/b', {dependencies: {'tool-x': '^3.0.0'}});
  const a = checkout(appRoot, '@fw/a', {devDependencies: {'tool-x': '^3.0.0'}});
  nested(a, 'tool-x', '3.1.0');
  nested(b, 'tool-x', '3.1.0');
  record(appRoot, {'@fw/a': a, '@fw/b': b});

  relink(stubbed(appRoot));
  assert.ok(has(a, 'tool-x'), "A's tooling stays A's");
  assert.equal(has(b, 'tool-x'), false, "B's runtime copy goes");
  // ...and relink does not take A's devDependency for one pruned on purpose
  fs.rmSync(path.join(a, 'node_modules', 'tool-x'), {recursive: true});
  const again = stubbed(appRoot);
  relink(again);
  assert.equal(again.npmCalls().length, 1, again.output());
  assert.equal(again.npmCalls()[0].cwd, a);
});

test('one call converges: a removal that unblocks another is followed in the same call', (t) => {
  const build = () => {
    const appRoot = consumer(t);
    appHas(appRoot, 'react', '19.1.0');
    appHas(appRoot, 'react-dom', '19.1.0', {
      peerDependencies: {react: '^19.0.0'},
    });
    const a = checkout(appRoot, '@fw/a', {
      peerDependencies: {react: '^19.0.0', 'react-dom': '^19.0.0'},
    });
    // react-dom's react resolves to A's 19.0.0 here and to 19.1.0 from the app:
    // kept on the first pass, removable once A's react is gone.
    nested(a, 'react', '19.0.0');
    nested(a, 'react-dom', '19.0.0', {peerDependencies: {react: '^19.0.0'}});
    record(appRoot, {'@fw/a': a});
    return {appRoot, a};
  };

  const one = build();
  const prunes = countPrunes(t);
  const {pruned} = checkOneCopy(one.appRoot, noRun(one.appRoot));
  assert.deepEqual(pruned.sort(), [
    'packages-local/fw-a/node_modules/react-dom@19.0.0',
    'packages-local/fw-a/node_modules/react@19.0.0',
  ]);
  assert.equal(prunes(), 1, 'one prune call, which iterates');
  assert.deepEqual(checkOneCopy(one.appRoot, noRun(one.appRoot)).pruned, []);

  const two = build();
  relink(stubbed(two.appRoot));
  assert.equal(has(two.a, 'react'), false);
  assert.equal(has(two.a, 'react-dom'), false);
});

// ---------------------------------------------------------------------------
// --no-prune is recorded and honoured
// ---------------------------------------------------------------------------

test('--no-prune at adopt is recorded as prune: false, and every later prune honours it', (t) => {
  const appRoot = consumer(t);
  appHas(appRoot, '@fw/core', '2.25.0');
  const a = checkout(appRoot, '@fw/a', {dependencies: {'@fw/core': '^2.0.0'}});
  nested(a, '@fw/core', '2.22.8');

  assert.equal(
    adopt(['@fw/a'], {prune: false, dir: 'packages-local'}, stubbed(appRoot)),
    0,
  );
  assert.equal(readManifest(appRoot).entries['@fw/a'].prune, false);
  const raw = JSON.parse(
    fs.readFileSync(path.join(appRoot, 'local-packages.json'), 'utf8'),
  );
  assert.equal(raw.version, 1, 'the schema version does not move');
  assert.equal(raw.packages['@fw/a'].prune, false);
  assert.ok(has(a, '@fw/core'));

  // the run-time check
  const prunes = countPrunes(t);
  assert.deepEqual(checkOneCopy(appRoot, noRun(appRoot)), {pruned: []});
  assert.equal(prunes(), 0);
  // relink: no prune, and a missing dependency is not excused as provided
  relink(stubbed(appRoot));
  assert.ok(has(a, '@fw/core'));
  // --reinstall
  assert.equal(reinstall('@fw/a', {}, stubbed(appRoot)), 0);
  assert.ok(has(a, '@fw/core'));
  // --list says so
  const listed = stubbed(appRoot);
  list({}, listed);
  assert.match(listed.output(), /prune: off/);

  // adopting again without --no-prune turns it back on
  assert.equal(adopt(['@fw/a'], {dir: 'packages-local'}, stubbed(appRoot)), 0);
  assert.equal(readManifest(appRoot).entries['@fw/a'].prune, undefined);
  assert.equal(has(a, '@fw/core'), false);
});

test('a prune: false checkout still counts as a sibling for the others', (t) => {
  const appRoot = consumer(t);
  const b = checkout(appRoot, '@fw/b', {version: '1.2.0'});
  const a = checkout(appRoot, '@fw/a', {dependencies: {'@fw/b': '^1.0.0'}});
  nested(a, '@fw/b', '1.1.0');
  nested(b, 'react', '19.0.0');
  appHas(appRoot, 'react', '19.1.0');
  record(appRoot, {'@fw/a': a, '@fw/b': b}, {'@fw/b': {prune: false}});

  const {pruned} = checkOneCopy(appRoot, noRun(appRoot));
  assert.deepEqual(pruned, ['packages-local/fw-a/node_modules/@fw/b@1.1.0']);
  assert.ok(has(b, 'react'), "B's own node_modules are left as npm left them");
});
