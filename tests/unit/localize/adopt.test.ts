/**
 * `adopt`, with the subprocess runner stubbed: what it refuses, what it
 * records, and -- the property that distinguishes it from `localize` -- that it
 * never clones, pulls or fetches.
 */
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {adopt} from '../../../src/localize/adopt.js';
import {localize} from '../../../src/localize/localize.js';
import {relink} from '../../../src/localize/relink.js';
import {list} from '../../../src/localize/list.js';
import {readManifest} from '../../../src/localize/manifest.js';
import {makeRun} from '../../../src/localize/run.js';
import {fail, makeConsumer, ok, rm, stubbed, test} from './helpers.js';

const consumer = (t, pkg) => {
  const root = makeConsumer({pkg});
  t.after(() => rm(root));
  return root;
};

/** A checkout under its localize name, e.g. `@scope/thing` -> packages-local/scope-thing. */
function seed(appRoot, dirName, pkgJson, {git = true} = {}) {
  const checkout = path.join(appRoot, 'packages-local', dirName);
  fs.mkdirSync(checkout, {recursive: true});
  if (git) fs.mkdirSync(path.join(checkout, '.git'));
  if (pkgJson)
    fs.writeFileSync(
      path.join(checkout, 'package.json'),
      JSON.stringify(pkgJson),
    );
  return checkout;
}

/** git answers: a branch, and an origin only when one is given. */
const gitWith = (origin) => (inv) => {
  if (inv.args[0] === 'symbolic-ref') return ok('main\n');
  if (inv.args[0] === 'remote')
    return origin
      ? ok(origin + '\n')
      : fail("error: No such remote 'origin'", 2);
  return ok();
};

const linkOf = (appRoot, name) =>
  fs.realpathSync(path.join(appRoot, 'node_modules', name));

test('adopt installs inside the checkout, links it and records it -- without cloning or pulling', (t) => {
  const appRoot = consumer(t);
  const checkout = seed(appRoot, 'scope-thing', {
    name: '@scope/thing',
    version: '0.1.0',
  });
  const deps = stubbed(appRoot, gitWith('git@github.com:scope/thing.git'));

  assert.equal(adopt(['@scope/thing'], {}, deps), 0, deps.output());

  assert.equal(linkOf(appRoot, '@scope/thing'), fs.realpathSync(checkout));
  assert.deepEqual(readManifest(appRoot, deps).entries['@scope/thing'], {
    repo: 'git@github.com:scope/thing.git',
    path: path.join('packages-local', 'scope-thing'),
    branch: 'main',
  });
  const installs = deps.npmCalls().filter((c) => c.args[0] === 'install');
  assert.deepEqual(
    installs.map((c) => c.cwd),
    [checkout],
  );
  for (const forbidden of ['clone', 'pull', 'fetch']) {
    assert.ok(
      !deps.calls.some((c) => c.cmd === 'git' && c.args[0] === forbidden),
      `no git ${forbidden}`,
    );
  }
  assert.ok(
    !deps.npmCalls().some((c) => c.args[0] === 'view'),
    'no registry lookup',
  );
});

test('a checkout with no remote is recorded without a repo, and relinks and lists like any other', (t) => {
  const appRoot = consumer(t);
  seed(appRoot, 'fresh', {name: 'fresh', version: '1.0.0'});
  const deps = stubbed(appRoot, gitWith(undefined));

  assert.equal(adopt(['fresh'], {}, deps), 0, deps.output());
  const entry = readManifest(appRoot, deps).entries.fresh;
  assert.equal(entry.repo, undefined);
  assert.equal(entry.path, path.join('packages-local', 'fresh'));

  // npm ci removed the link; the postinstall puts it back.
  fs.rmSync(path.join(appRoot, 'node_modules'), {recursive: true});
  const after = stubbed(appRoot);
  assert.equal(relink(after), 0);
  assert.ok(
    fs.lstatSync(path.join(appRoot, 'node_modules', 'fresh')).isSymbolicLink(),
  );

  const listing = stubbed(appRoot);
  assert.equal(list({check: true}, listing), 0, listing.output());
  assert.match(listing.output(), /fresh/);
});

test('--repo is recorded in place of the origin, normalised', (t) => {
  const appRoot = consumer(t);
  seed(appRoot, 'thing', {name: 'thing', version: '1.0.0'});
  const deps = stubbed(appRoot, gitWith('https://github.com/old/thing.git'));

  assert.equal(
    adopt(['thing'], {repo: 'git+https://github.com/new/thing.git'}, deps),
    0,
    deps.output(),
  );
  assert.equal(
    readManifest(appRoot, deps).entries.thing.repo,
    'https://github.com/new/thing.git',
  );
});

test('--repo with more than one package is refused before anything runs', (t) => {
  const appRoot = consumer(t);
  const deps = stubbed(appRoot);
  assert.equal(adopt(['a', 'b'], {repo: 'https://x/a.git'}, deps), 6);
  assert.match(deps.output(), /only be used when adopting one package/);
  assert.equal(deps.calls.length, 0);
});

test('adopt refuses a missing checkout, a non-git directory and a name mismatch', (t) => {
  const appRoot = consumer(t);
  seed(appRoot, 'nogit', {name: 'nogit', version: '1.0.0'}, {git: false});
  seed(appRoot, 'wrong', {name: 'something-else', version: '1.0.0'});
  seed(appRoot, 'nopkg', null);

  const cases = [
    ['missing', /nothing to adopt at packages-local[/\\]missing/],
    ['nogit', /is not a git checkout/],
    ['wrong', /declares itself as "something-else"/],
    ['nopkg', /has no package.json naming it/],
  ];
  for (const [name, message] of cases) {
    const deps = stubbed(appRoot, gitWith(undefined));
    assert.equal(adopt([name], {}, deps), 6, name);
    assert.match(deps.output(), message, name);
    assert.equal(deps.npmCalls().length, 0, `${name}: nothing installed`);
  }
  assert.deepEqual(Object.keys(readManifest(appRoot).entries), []);
});

const HOOKS = {
  postinstall: 'linked localize --relink',
  dependencies: 'linked localize --relink',
};

test('adopt leaves the consumer package.json alone and runs the configured build in the checkout', (t) => {
  const appRoot = consumer(t, {dependencies: {}, scripts: HOOKS});
  const checkout = seed(appRoot, 'built', {name: 'built', version: '1.0.0'});
  const before = fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8');
  const deps = stubbed(appRoot, gitWith(undefined));

  assert.equal(adopt(['built'], {build: 'make it'}, deps), 0, deps.output());
  const build = deps.calls.find((c) => c.cmd === 'make it');
  assert.equal(build?.cwd, checkout);
  assert.equal(
    fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8'),
    before,
  );
});

test('localize on an unpublished package whose checkout is already there points at adopt', (t) => {
  const appRoot = consumer(t);
  seed(appRoot, 'scope-unpublished', {
    name: '@scope/unpublished',
    version: '0.1.0',
  });
  const deps = stubbed(appRoot, (inv) =>
    inv.args[0] === 'view' ? fail('npm error code E404', 1) : ok(),
  );

  assert.equal(localize(['@scope/unpublished'], {}, deps), 4);
  assert.match(deps.output(), /linked localize @scope\/unpublished --adopt/);
});

test('a fresh `git init` with no commit yet is recorded on its branch, not as HEAD', (t) => {
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
  assert.equal(readManifest(appRoot, deps).entries.unborn.branch, 'trunk');
});

// npm runs the root `postinstall` only on a bare install, the root
// `dependencies` script after any command that changes node_modules -- so a
// recorded package needs both, and localize/adopt add them when missing.
const appScripts = (appRoot) =>
  JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8'))
    .scripts;

test('adopt adds both relink hooks to an app that has neither, and says so once', (t) => {
  const appRoot = consumer(t);
  seed(appRoot, 'hooked', {name: 'hooked', version: '1.0.0'});
  const deps = stubbed(appRoot, gitWith(undefined));

  assert.equal(adopt(['hooked'], {}, deps), 0, deps.output());
  assert.deepEqual(appScripts(appRoot), HOOKS);
  assert.match(
    deps.output(),
    /Added `linked localize --relink` to the app's postinstall and dependencies scripts so npm keeps the links/,
  );
});

test('adopt appends to scripts that do something else and leaves ones that already relink', (t) => {
  const appRoot = consumer(t, {
    scripts: {postinstall: 'patch-package', dependencies: HOOKS.dependencies},
  });
  seed(appRoot, 'merged', {name: 'merged', version: '1.0.0'});
  const deps = stubbed(appRoot, gitWith(undefined));

  assert.equal(adopt(['merged'], {}, deps), 0, deps.output());
  assert.deepEqual(appScripts(appRoot), {
    postinstall: 'patch-package && linked localize --relink',
    dependencies: 'linked localize --relink',
  });
  assert.match(deps.output(), /to the app's postinstall script so npm/);
});

test('a run that records nothing does not touch the app scripts', (t) => {
  const appRoot = consumer(t);
  const before = fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8');
  const deps = stubbed(appRoot, gitWith(undefined));

  assert.equal(adopt(['absent'], {}, deps), 6, deps.output());
  assert.equal(
    fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8'),
    before,
  );
  assert.doesNotMatch(deps.output(), /Added `linked localize --relink`/);
});

test('localize adds the relink hooks when it records a package', (t) => {
  const appRoot = consumer(t, {
    scripts: {postinstall: 'linked-localize --relink'},
  });
  const deps = stubbed(appRoot, (inv) => {
    if (inv.args[0] === 'clone') {
      const dest = inv.args[2];
      fs.mkdirSync(path.join(dest, '.git'), {recursive: true});
      fs.writeFileSync(
        path.join(dest, 'package.json'),
        JSON.stringify({name: 'widget', version: '1.0.0'}),
      );
      return ok();
    }
    if (inv.args[0] === 'symbolic-ref') return ok('main\n');
    return ok();
  });

  assert.equal(localize(['widget'], {repo: 'r'}, deps), 0, deps.output());
  assert.deepEqual(appScripts(appRoot), {
    postinstall: 'linked-localize --relink',
    dependencies: 'linked localize --relink',
  });
  assert.match(deps.output(), /to the app's dependencies script so npm/);
});
