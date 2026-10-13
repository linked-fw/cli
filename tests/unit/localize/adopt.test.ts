/**
 * `adopt` and `--parked`, with the subprocess runner stubbed: what adopt
 * refuses, and -- the property that distinguishes it from `localize` -- that
 * it never clones, pulls or fetches, but otherwise runs the same setup,
 * install and build.
 */
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {adopt, localizeParked} from '../../../src/localize/adopt.js';
import {localize} from '../../../src/localize/localize.js';
import {makeRun} from '../../../src/localize/run.js';
import {ensureAppSetup} from '../../../src/localize/app-setup.js';
import {makeConsumer, ok, rm, stubbed, test} from './helpers.js';

/**
 * An app, already set up for checkouts unless `setUp: false` -- the set-up
 * and the lockfile it captures have tests of their own.
 */
const consumer = (t, pkg = {}, {setUp = true} = {}) => {
  const root = makeConsumer({pkg});
  t.after(() => rm(root));
  if (setUp) ensureAppSetup(root);
  return root;
};

/** A checkout in `dir` (default packages-local) under `dirName`. */
function seed(
  appRoot,
  dirName,
  pkgJson,
  {git = true, dir = 'packages-local'} = {},
) {
  const checkout = path.join(appRoot, dir, dirName);
  fs.mkdirSync(checkout, {recursive: true});
  if (git) fs.mkdirSync(path.join(checkout, '.git'));
  if (pkgJson)
    fs.writeFileSync(
      path.join(checkout, 'package.json'),
      JSON.stringify(pkgJson),
    );
  return checkout;
}

const branchMain = (inv) =>
  inv.cmd === 'git' && inv.args[0] === 'symbolic-ref' ? ok('main\n') : ok();

test('adopt sets up, installs at the root and builds the checkout -- without cloning or pulling', (t) => {
  const appRoot = consumer(t, {}, {setUp: false});
  seed(appRoot, 'scope-thing', {name: '@scope/thing', version: '1.0.0'});
  let seenByLockOnly: boolean | null = null;
  let asideDuringLockOnly: boolean | null = null;
  const deps = stubbed(appRoot, (inv) => {
    if (inv.args.includes('--package-lock-only')) {
      seenByLockOnly = fs.existsSync(
        path.join(appRoot, 'packages-local/scope-thing'),
      );
      asideDuringLockOnly = fs.existsSync(
        path.join(
          appRoot,
          'packages-local/.setup-aside/scope-thing/package.json',
        ),
      );
    }
    return branchMain(inv);
  });

  assert.equal(adopt(['@scope/thing'], {}, deps), 0, deps.output());

  const gitVerbs = deps.calls
    .filter((c) => c.cmd === 'git')
    .map((c) => c.args[0]);
  for (const verb of ['clone', 'pull', 'fetch'])
    assert.equal(gitVerbs.includes(verb), false, `adopt ran git ${verb}`);
  assert.deepEqual(
    deps.calls
      .filter((c) => c.cmd !== 'git')
      .map(
        (c) => `${c.cmd} ${c.args.join(' ')}@${path.relative(appRoot, c.cwd)}`,
      ),
    [
      // The set-up's lockfile, made with the checkout moved aside.
      'npm install --package-lock-only --ignore-scripts --no-audit --no-fund@',
      'npm install --no-audit --no-fund@',
      'linked build @packages-local/scope-thing',
    ],
  );
  assert.equal(
    seenByLockOnly,
    false,
    'npm made the set-up lockfile without the checkout',
  );
  assert.ok(
    fs.existsSync(
      path.join(appRoot, 'packages-local/scope-thing/package.json'),
    ),
    'moved back',
  );
  assert.equal(
    asideDuringLockOnly,
    true,
    'set aside inside packages-local/, outside its glob',
  );
  assert.equal(
    fs.existsSync(path.join(appRoot, 'packages-local/.setup-aside')),
    false,
  );
  const pkg = JSON.parse(
    fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8'),
  );
  assert.deepEqual(pkg.workspaces, ['packages-local/*']);
  assert.match(
    deps.output(),
    /@scope\/thing -> packages-local\/scope-thing \(branch main\)/,
  );
});

test('adopt finds a member by name even under another directory name', (t) => {
  const appRoot = consumer(t);
  seed(appRoot, 'my-own-name', {name: '@scope/thing', version: '1.0.0'});
  const deps = stubbed(appRoot, branchMain);
  assert.equal(adopt(['@scope/thing'], {build: ''}, deps), 0, deps.output());
  assert.match(deps.output(), /adopting packages-local\/my-own-name/);
});

test('adopt refuses a missing checkout, a non-git directory and a name mismatch', (t) => {
  const appRoot = consumer(t);
  seed(appRoot, 'nogit', {name: 'nogit'}, {git: false});
  seed(appRoot, 'other', {name: 'something-else'});

  const deps = stubbed(appRoot);
  assert.equal(adopt(['missing'], {}, deps), 6);
  assert.match(deps.output(), /nothing to adopt at packages-local\/missing/);
  assert.equal(adopt(['nogit'], {}, deps), 6);
  assert.match(deps.output(), /not a git checkout/);
  assert.equal(adopt(['other'], {}, deps), 6);
  assert.match(deps.output(), /declares itself as "something-else"/);
  assert.equal(deps.npmCalls().length, 0, 'a refusal installs nothing');
});

test('adopt of a parked package points at localize, which takes it back', (t) => {
  const appRoot = consumer(t);
  seed(appRoot, 'thing', {name: 'thing'}, {dir: '.packages-local.parked'});
  const deps = stubbed(appRoot);
  assert.equal(adopt(['thing'], {}, deps), 6);
  assert.match(
    deps.output(),
    /thing is parked\. To take it back:\n {2}linked localize thing/,
  );
});

test('a fresh `git init` with no commit yet is reported on its branch, not as HEAD', (t) => {
  const appRoot = consumer(t);
  const checkout = seed(
    appRoot,
    'unborn',
    {name: 'unborn', version: '1.0.0'},
    {git: false},
  );
  const init = spawnSync('git', ['init', '--quiet', '-b', 'trunk'], {
    cwd: checkout,
  });
  assert.equal(init.status, 0, String(init.stderr));

  // Real git -- the point is what git itself answers on an unborn branch --
  // but no real npm.
  const realGit = makeRun(appRoot);
  const deps = stubbed(appRoot, (inv) =>
    inv.cmd === 'git' ? realGit(inv.cmd, inv.args, {cwd: inv.cwd}) : ok(),
  );

  assert.equal(adopt(['unborn'], {}, deps), 0, deps.output());
  assert.match(
    deps.output(),
    /unborn -> packages-local\/unborn \(branch trunk\)/,
  );
});

test('localize on an unpublished package whose checkout is already there points at adopt', (t) => {
  const appRoot = consumer(t);
  seed(appRoot, 'local-only', {name: 'local-only'});
  const deps = stubbed(appRoot);
  assert.equal(localize(['local-only'], {}, deps), 6);
  assert.match(deps.output(), /linked localize local-only --adopt/);
  assert.equal(
    deps.calls.some((c) => c.cmd === 'npm'),
    false,
    'refused before any registry lookup or install',
  );
});

test('--parked takes every parked checkout back with one install and no builds', (t) => {
  const appRoot = consumer(t);
  seed(
    appRoot,
    'a',
    {name: 'a', version: '1.0.0'},
    {dir: '.packages-local.parked'},
  );
  seed(
    appRoot,
    'b',
    {name: 'b', version: '1.0.0'},
    {dir: '.packages-local.parked'},
  );
  const deps = stubbed(appRoot, branchMain);

  assert.equal(localizeParked({}, deps), 0, deps.output());

  assert.ok(fs.existsSync(path.join(appRoot, 'packages-local/a/package.json')));
  assert.ok(fs.existsSync(path.join(appRoot, 'packages-local/b/package.json')));
  assert.deepEqual(
    deps.calls
      .filter((c) => c.cmd !== 'git')
      .map((c) => `${c.cmd} ${c.args[0]}`),
    ['npm install'],
  );

  const none = stubbed(appRoot);
  assert.equal(localizeParked({}, none), 0);
  assert.match(none.output(), /nothing is parked/);
  assert.equal(none.calls.length, 0);
});

test('--parked refuses (exit 6) a parked name that is already a member under another directory', (t) => {
  const appRoot = consumer(t);
  seed(
    appRoot,
    'a',
    {name: 'a', version: '1.0.0'},
    {dir: '.packages-local.parked'},
  );
  seed(appRoot, 'a-copy', {name: 'a', version: '1.0.0'});
  const deps = stubbed(appRoot, branchMain);

  assert.equal(localizeParked({}, deps), 6, deps.output());

  assert.match(
    deps.output(),
    /a is parked in \.packages-local\.parked\/a, but packages-local\/a-copy is a already/,
  );
  assert.ok(
    fs.existsSync(path.join(appRoot, '.packages-local.parked/a/package.json')),
  );
  assert.equal(fs.existsSync(path.join(appRoot, 'packages-local/a')), false);
  assert.equal(
    deps.calls.some((c) => c.cmd === 'npm'),
    false,
  );
});
