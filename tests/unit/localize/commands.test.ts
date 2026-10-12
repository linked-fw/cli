/**
 * localize, delocalize and --list with the subprocess runner stubbed: the
 * order of what runs and where, the guards, and the moves on disk. What needs
 * a REAL clone and a REAL npm lives in real-localize.test.ts.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {localize} from '../../../src/localize/localize.js';
import {delocalize} from '../../../src/localize/delocalize.js';
import {list} from '../../../src/localize/list.js';
import {ensureAppSetup} from '../../../src/localize/app-setup.js';
import {fail, makeConsumer, ok, rm, stubbed, test} from './helpers.js';

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

/** A checkout on disk, as a clone would leave it. */
function seedCheckout(appRoot, rel, pkg) {
  const dir = path.join(appRoot, rel);
  fs.mkdirSync(path.join(dir, '.git'), {recursive: true});
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg));
  return dir;
}

/** A runner whose `git clone <url> <dir>` leaves a checkout of `pkg` at `<dir>`. */
function cloning(appRoot, pkgFor, handler?) {
  return stubbed(appRoot, (inv) => {
    if (inv.cmd === 'git' && inv.args[0] === 'clone') {
      const name = pkgFor.name;
      seedCheckout(appRoot, path.relative(appRoot, inv.args[2]), {
        version: '1.0.0',
        ...pkgFor,
        name,
      });
      return ok();
    }
    if (inv.cmd === 'git' && inv.args[0] === 'symbolic-ref') return ok('main\n');
    return handler?.(inv);
  });
}

/** What ran, as `cmd args… @ cwd relative to the app`. */
const trace = (deps, appRoot) =>
  deps.calls
    .filter((c) => !(c.cmd === 'git' && c.args[0] !== 'clone'))
    .map(
      (c) =>
        `${c.cmd}${c.args.length ? ' ' + c.args.join(' ') : ''} @ ${
          c.cwd ? path.relative(appRoot, c.cwd) || '.' : '-'
        }`.replace(appRoot + path.sep, ''),
    );

// --- localize --------------------------------------------------------------

test('localize clones, sets up, installs once at the root, then builds', (t) => {
  const appRoot = consumer(t, {dependencies: {'@x/a': '^1.0.0'}}, {setUp: false});
  const deps = cloning(appRoot, {name: '@x/a'});

  const code = localize(['@x/a'], {repo: 'https://example.invalid/a.git'}, deps);

  assert.equal(code, 0, deps.output());
  assert.deepEqual(trace(deps, appRoot), [
    'npm install --package-lock-only --ignore-scripts --no-audit --no-fund @ .',
    'git clone https://example.invalid/a.git packages-local/x-a @ -',
    'npm install --no-audit --no-fund @ .',
    'linked build @ packages-local/x-a',
  ]);
  const pkg = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8'));
  assert.deepEqual(pkg.workspaces, ['packages-local/*']);
  assert.match(pkg.scripts.postinstall, /hooks\/lock-at-rest\.cjs/);
  assert.match(
    fs.readFileSync(path.join(appRoot, '.gitignore'), 'utf8'),
    /packages-local\/\n\.packages-local\.parked\//,
  );
  assert.match(deps.output(), /commit these/);
  assert.match(deps.output(), /@x\/a -> packages-local\/x-a \(branch main\)/);
});

/** A runner that writes `package-lock.json` as npm would: `lockOnly` for the set-up call, `installed` for the install. */
function writingLockfile(appRoot, {lockOnly, installed}) {
  const lockfile = path.join(appRoot, 'package-lock.json');
  return cloning(appRoot, {name: '@x/a'}, (inv) => {
    if (inv.cmd !== 'npm' || inv.args[0] !== 'install') return undefined;
    if (inv.args.includes('--package-lock-only')) {
      // npm sees no checkout: the set-up moved none in yet.
      assert.equal(fs.existsSync(path.join(appRoot, 'packages-local/x-a')), false);
      if (lockOnly === null) return fail('npm ERR! ENOTFOUND registry');
      fs.writeFileSync(lockfile, lockOnly);
    } else {
      fs.writeFileSync(lockfile, installed);
    }
    return ok();
  });
}

test('first set-up: the lockfile npm makes before the clone is written back after the install', (t) => {
  const appRoot = consumer(t, {}, {setUp: false});
  const lockfile = path.join(appRoot, 'package-lock.json');
  fs.writeFileSync(lockfile, '{"before": true}\n');
  const setupLock = '{"workspaces": ["packages-local/*"]}\n';
  const deps = writingLockfile(appRoot, {
    lockOnly: setupLock,
    installed: '{"packages": {"packages-local/x-a": {}}}\n',
  });

  assert.equal(localize(['@x/a'], {repo: 'https://example.invalid/a.git'}, deps), 0, deps.output());

  assert.deepEqual(trace(deps, appRoot).slice(0, 3), [
    'npm install --package-lock-only --ignore-scripts --no-audit --no-fund @ .',
    'git clone https://example.invalid/a.git packages-local/x-a @ -',
    'npm install --no-audit --no-fund @ .',
  ]);
  assert.equal(fs.readFileSync(lockfile, 'utf8'), setupLock, 'the set-up lockfile, not the install\'s');
  assert.match(deps.output(), /put back the set-up's lockfile/);
  assert.match(deps.output(), /git add package\.json package-lock\.json \.gitignore/);
  assert.doesNotMatch(deps.output(), /npx linked delocalize/);
});

test('first set-up: when npm cannot make the lockfile, the manual steps are printed and nothing is written back', (t) => {
  const appRoot = consumer(t, {}, {setUp: false});
  const installed = '{"packages": {"packages-local/x-a": {}}}\n';
  const deps = writingLockfile(appRoot, {lockOnly: null, installed});

  assert.equal(localize(['@x/a'], {repo: 'https://example.invalid/a.git'}, deps), 0, deps.output());

  assert.equal(fs.readFileSync(path.join(appRoot, 'package-lock.json'), 'utf8'), installed);
  assert.match(deps.output(), /could not make the set-up's package-lock\.json in one step/);
  assert.match(deps.output(), /ENOTFOUND/);
  assert.match(deps.output(), /npx linked delocalize\n {2}npm install\n/);
  assert.match(deps.output(), /npx linked localize --parked/);
});

test('first set-up: a root entry with workspaces and an install script is edited, without npm', (t) => {
  const hook = 'linked localize --relink';
  const appRoot = consumer(
    t,
    {workspaces: ['packages/*'], scripts: {postinstall: hook}},
    {setUp: false},
  );
  const lockfile = path.join(appRoot, 'package-lock.json');
  const lock = (workspaces) =>
    JSON.stringify(
      {
        name: 'consumer',
        version: '1.0.0',
        lockfileVersion: 3,
        requires: true,
        packages: {'': {name: 'consumer', version: '1.0.0', hasInstallScript: true, workspaces}},
      },
      null,
      2,
    ) + '\n';
  fs.writeFileSync(lockfile, lock(['packages/*']));
  const deps = writingLockfile(appRoot, {
    lockOnly: null,
    installed: '{"packages": {"packages-local/x-a": {}}}\n',
  });

  assert.equal(localize(['@x/a'], {repo: 'https://example.invalid/a.git'}, deps), 0, deps.output());

  assert.equal(deps.calls.some((c) => c.args.includes('--package-lock-only')), false);
  assert.equal(fs.readFileSync(lockfile, 'utf8'), lock(['packages/*', 'packages-local/*']));
  assert.match(deps.output(), /root entry's "workspaces" now matches package\.json/);
  assert.match(deps.output(), /put back the set-up's lockfile/);
  assert.doesNotMatch(deps.output(), /npx linked delocalize/);
});

test('an app already set up makes no set-up lockfile', (t) => {
  const appRoot = consumer(t);
  const deps = cloning(appRoot, {name: '@x/a'});
  assert.equal(localize(['@x/a'], {repo: 'https://example.invalid/a.git'}, deps), 0);
  assert.equal(deps.calls.some((c) => c.args.includes('--package-lock-only')), false);
  assert.doesNotMatch(deps.output(), /commit these|set-up/);
});

test('one install for several names, and a failing build only warns (exit 5)', (t) => {
  const appRoot = consumer(t);
  let n = 0;
  const deps = stubbed(appRoot, (inv) => {
    if (inv.cmd === 'git' && inv.args[0] === 'clone') {
      seedCheckout(appRoot, path.relative(appRoot, inv.args[2]), {
        name: ['@x/a', '@x/b'][n++],
        version: '1.0.0',
      });
      return ok();
    }
    if (inv.cmd === 'linked build' && inv.cwd.endsWith('x-b')) return fail('tsc broke');
  });

  const code = localize(['@x/a', '@x/b'], {repo: 'https://example.invalid/r.git'}, deps);

  assert.equal(code, 5, deps.output());
  assert.equal(deps.npmCalls().length, 1, 'one npm install for both');
  assert.match(deps.output(), /x-b: `linked build` failed/);
  assert.match(deps.output(), /tsc broke/);
});

test('localize builds the cli with npm run build, and --build overrides every default', (t) => {
  const appRoot = consumer(t);
  const deps = cloning(appRoot, {name: '@_linked/cli'});
  assert.equal(localize(['@_linked/cli'], {repo: 'https://example.invalid/cli.git'}, deps), 0);
  assert.ok(
    trace(deps, appRoot).includes('npm run build @ packages-local/_linked-cli'),
    trace(deps, appRoot).join('\n'),
  );

  const appRoot2 = consumer(t);
  const deps2 = cloning(appRoot2, {name: '@_linked/cli'});
  localize(['@_linked/cli'], {repo: 'https://example.invalid/cli.git', build: ''}, deps2);
  assert.equal(
    deps2.calls.filter((c) => /build/.test(c.cmd) || c.args.includes('build')).length,
    0,
    "--build '' builds nothing",
  );
});

test('the cli builds before the others and then gets its bin linked', (t) => {
  const appRoot = consumer(t);
  let n = 0;
  const deps = stubbed(appRoot, (inv) => {
    if (inv.cmd === 'git' && inv.args[0] === 'clone') {
      seedCheckout(appRoot, path.relative(appRoot, inv.args[2]), {
        name: ['@x/a', '@_linked/cli'][n++],
        version: '1.0.0',
      });
      return ok();
    }
  });

  const code = localize(['@x/a', '@_linked/cli'], {repo: 'https://example.invalid/r.git'}, deps);

  assert.equal(code, 0, deps.output());
  assert.deepEqual(trace(deps, appRoot).slice(2), [
    'npm install --no-audit --no-fund @ .',
    'npm run build @ packages-local/_linked-cli',
    'npm rebuild @_linked/cli --ignore-scripts @ .',
    'linked build @ packages-local/x-a',
  ]);
});

test('a failed cli build links no bin', (t) => {
  const appRoot = consumer(t);
  const deps = cloning(appRoot, {name: '@_linked/cli'}, (inv) =>
    inv.cmd === 'npm run build' ? fail('core has no lib/') : undefined,
  );

  assert.equal(localize(['@_linked/cli'], {repo: 'https://example.invalid/cli.git'}, deps), 5);
  assert.equal(
    deps.calls.filter((c) => c.cmd === 'npm' && c.args[0] === 'rebuild').length,
    0,
    deps.output(),
  );
});

test('an override on a checkout already localized refuses localizing another', (t) => {
  const appRoot = consumer(t, {overrides: {'@_linked/core': '$@_linked/core'}});
  seedCheckout(appRoot, 'packages-local/_linked-core', {name: '@_linked/core', version: '1.0.0'});
  const deps = cloning(appRoot, {name: '@x/a'});

  const code = localize(['@x/a'], {repo: 'https://example.invalid/a.git'}, deps);

  assert.equal(code, 6, deps.output());
  assert.match(deps.output(), /"@_linked\/core"/);
  assert.equal(deps.calls.length, 0, 'nothing cloned or installed');
  assert.equal(fs.existsSync(path.join(appRoot, 'packages-local/x-a')), false);
});

test('localize refuses a conflicting override: exit 6, the key named, nothing cloned or changed', (t) => {
  const appRoot = consumer(t, {overrides: {'@_linked/core': '$@_linked/core'}});
  const before = fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8');
  const deps = cloning(appRoot, {name: '@_linked/core'});

  const code = localize(['@_linked/core'], {repo: 'https://example.invalid/core.git'}, deps);

  assert.equal(code, 6);
  assert.match(deps.output(), /"@_linked\/core"/);
  assert.match(deps.output(), /Remove that key from "overrides"/);
  assert.equal(deps.calls.length, 0, 'nothing ran');
  assert.equal(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8'), before);
  assert.equal(fs.existsSync(path.join(appRoot, 'packages-local')), false);
});

test('localize takes a parked checkout back: no clone, no build, one install', (t) => {
  const appRoot = consumer(t);
  seedCheckout(appRoot, '.packages-local.parked/x-a', {name: '@x/a', version: '1.0.0'});
  const deps = stubbed(appRoot);

  const code = localize(['@x/a'], {}, deps);

  assert.equal(code, 0, deps.output());
  assert.ok(fs.existsSync(path.join(appRoot, 'packages-local/x-a/package.json')));
  assert.equal(fs.existsSync(path.join(appRoot, '.packages-local.parked/x-a')), false);
  assert.deepEqual(trace(deps, appRoot), ['npm install --no-audit --no-fund @ .']);
});

test('an existing directory is refused with an --adopt hint, and nothing is installed', (t) => {
  const appRoot = consumer(t);
  seedCheckout(appRoot, 'packages-local/x-a', {name: '@x/a', version: '1.0.0'});
  const deps = stubbed(appRoot);

  const code = localize(['@x/a'], {repo: 'https://example.invalid/a.git'}, deps);

  assert.equal(code, 6);
  assert.match(deps.output(), /linked localize @x\/a --adopt/);
  assert.equal(deps.calls.length, 0);
});

test('a clone that is not the package is removed again, so it never becomes a member', (t) => {
  const appRoot = consumer(t);
  const deps = cloning(appRoot, {name: 'monorepo-root'});

  const code = localize(['@x/a'], {repo: 'https://example.invalid/mono.git'}, deps);

  assert.equal(code, 6);
  assert.match(deps.output(), /declares itself as "monorepo-root"/);
  assert.match(deps.output(), /--subdir/);
  assert.equal(fs.existsSync(path.join(appRoot, 'packages-local/x-a')), false);
  assert.equal(deps.npmCalls().length, 0);
});

test('a failed root install exits 7 and builds nothing', (t) => {
  const appRoot = consumer(t);
  const deps = cloning(appRoot, {name: '@x/a'}, (inv) =>
    inv.cmd === 'npm' ? fail('ERESOLVE') : undefined,
  );

  const code = localize(['@x/a'], {repo: 'https://example.invalid/a.git'}, deps);

  assert.equal(code, 7);
  assert.match(deps.output(), /ERESOLVE/);
  assert.equal(deps.calls.some((c) => c.cmd === 'linked build'), false);
});

test('--dir other than packages-local is a usage error (exit 2)', (t) => {
  const appRoot = consumer(t);
  const deps = stubbed(appRoot);
  assert.equal(localize(['@x/a'], {dir: 'vendor'}, deps), 2);
  assert.equal(localize(['@x/a'], {dir: 'packages-local/'}, stubbed(appRoot, () => fail())), 4);
});

// --- delocalize ------------------------------------------------------------

test('delocalize the last checkout parks it and runs npm ci', (t) => {
  const appRoot = consumer(t);
  seedCheckout(appRoot, 'packages-local/x-a', {name: '@x/a', version: '1.0.0'});
  const deps = stubbed(appRoot);

  assert.equal(delocalize(['@x/a'], {}, deps), 0, deps.output());

  assert.ok(fs.existsSync(path.join(appRoot, '.packages-local.parked/x-a/package.json')));
  assert.equal(fs.existsSync(path.join(appRoot, 'packages-local/x-a')), false);
  assert.deepEqual(trace(deps, appRoot), ['npm ci --no-audit --no-fund @ .']);
  assert.match(deps.output(), /linked localize @x\/a` takes it back/);
});

test('delocalize one of two runs npm install then npm rebuild <name>', (t) => {
  const appRoot = consumer(t);
  seedCheckout(appRoot, 'packages-local/x-a', {name: '@x/a', version: '1.0.0'});
  seedCheckout(appRoot, 'packages-local/x-b', {name: '@x/b', version: '1.0.0'});
  const deps = stubbed(appRoot);

  // A short name works when it is unambiguous.
  assert.equal(delocalize(['b'], {}, deps), 0, deps.output());

  assert.deepEqual(trace(deps, appRoot), [
    'npm install --no-audit --no-fund @ .',
    'npm rebuild @x/b @ .',
  ]);
  assert.ok(fs.existsSync(path.join(appRoot, 'packages-local/x-a')));
});

test('delocalize --purge refuses on unpushed commits, and --force deletes', (t) => {
  const appRoot = consumer(t);
  const dir = seedCheckout(appRoot, 'packages-local/x-a', {name: '@x/a', version: '1.0.0'});
  const unpushed = (inv) =>
    inv.cmd === 'git' && inv.args[0] === 'log' ? ok('abc123 wip\n') : undefined;

  const deps = stubbed(appRoot, unpushed);
  assert.equal(delocalize(['@x/a'], {purge: true}, deps), 6);
  assert.match(deps.output(), /1 commit no remote has/);
  assert.ok(fs.existsSync(dir), 'kept');
  assert.equal(deps.npmCalls().length, 0, 'nothing changed, nothing installed');

  const forced = stubbed(appRoot, unpushed);
  assert.equal(delocalize(['@x/a'], {purge: true, force: true}, forced), 0);
  assert.equal(fs.existsSync(dir), false);
  assert.equal(fs.existsSync(path.join(appRoot, '.packages-local.parked')), false);
});

test('delocalize of something not localized warns (exit 5) and installs nothing', (t) => {
  const appRoot = consumer(t);
  seedCheckout(appRoot, '.packages-local.parked/x-a', {name: '@x/a', version: '1.0.0'});
  const deps = stubbed(appRoot);
  assert.equal(delocalize(['@x/a', '@x/zzz'], {}, deps), 5);
  assert.match(deps.output(), /already parked/);
  assert.match(deps.output(), /@x\/zzz is not localized/);
  assert.equal(deps.npmCalls().length, 0);
});

test('a monorepo package is a link into packages-local/.repos, and parks and comes back as one', (t) => {
  const appRoot = consumer(t);
  const deps = stubbed(appRoot, (inv) => {
    if (inv.cmd === 'git' && inv.args[0] === 'clone') {
      const clone = inv.args[2];
      seedCheckout(appRoot, path.relative(appRoot, clone), {name: 'root'});
      fs.mkdirSync(path.join(clone, 'packages/a'), {recursive: true});
      fs.writeFileSync(
        path.join(clone, 'packages/a/package.json'),
        JSON.stringify({name: '@x/a', version: '1.0.0'}),
      );
      return ok();
    }
  });

  const code = localize(
    ['@x/a'],
    {repo: 'https://example.invalid/mono.git', subdir: 'packages/a'},
    deps,
  );
  assert.equal(code, 0, deps.output());
  const member = path.join(appRoot, 'packages-local/x-a');
  assert.ok(fs.lstatSync(member).isSymbolicLink());
  assert.equal(
    fs.realpathSync(member),
    fs.realpathSync(path.join(appRoot, 'packages-local/.repos/x-a/packages/a')),
  );
  assert.ok(trace(deps, appRoot).includes('linked build @ packages-local/x-a'));

  assert.equal(delocalize(['@x/a'], {}, stubbed(appRoot)), 0);
  const parked = path.join(appRoot, '.packages-local.parked/x-a');
  assert.equal(
    fs.realpathSync(parked),
    fs.realpathSync(path.join(appRoot, 'packages-local/.repos/x-a/packages/a')),
    'the parked link still reaches the package',
  );

  assert.equal(localize(['@x/a'], {}, stubbed(appRoot)), 0);
  assert.equal(
    fs.realpathSync(member),
    fs.realpathSync(path.join(appRoot, 'packages-local/.repos/x-a/packages/a')),
    'taken back, still the package inside the clone',
  );
});

// --- --list ----------------------------------------------------------------

test('--list shows members, parked and a range-miss line; --list --check exits 1 then', (t) => {
  const appRoot = consumer(t, {dependencies: {'@x/a': '^2.0.0'}});
  seedCheckout(appRoot, 'packages-local/x-a', {name: '@x/a', version: '1.4.0'});
  seedCheckout(appRoot, '.packages-local.parked/x-b', {name: '@x/b', version: '3.0.0'});
  fs.writeFileSync(
    path.join(appRoot, 'node_modules/.package-lock.json'),
    JSON.stringify({
      packages: {
        'node_modules/@x/a': {resolved: 'packages-local/x-a', link: true},
        'packages-local/x-a': {version: '1.4.0'},
      },
    }),
  );
  const branch = (inv) =>
    inv.cmd === 'git' && inv.args[0] === 'symbolic-ref' ? ok('feat/x\n') : undefined;

  const deps = stubbed(appRoot, branch);
  assert.equal(list({}, deps), 0);
  const out = deps.output();
  assert.match(out, /@x\/a\s+packages-local\/x-a\s+feat\/x\s+1\.4\.0/);
  assert.match(out, /@x\/b\s+\.packages-local\.parked\/x-b\s+feat\/x\s+3\.0\.0\s+\(parked\)/);
  assert.match(out, /drift: @x\/a@1\.4\.0 \(packages-local\/x-a\) does not satisfy dependencies "\^2\.0\.0" of <root>/);
  assert.match(out, /1 localized · 1 parked · 1 drift/);

  const check = stubbed(appRoot, branch);
  assert.equal(list({check: true}, check), 1);
  assert.deepEqual(check.logs, [], '--check prints only the drift');
  assert.equal(check.warns.length, 1);
});

test('--list says nothing when nothing is localized, and --check exits 0', (t) => {
  const appRoot = consumer(t);
  const deps = stubbed(appRoot);
  assert.equal(list({}, deps), 0);
  assert.equal(list({check: true}, deps), 0);
  assert.equal(deps.output(), '');
});

test('a leftover local-packages.json gets one migration hint and is otherwise ignored', (t) => {
  const appRoot = consumer(t);
  fs.writeFileSync(path.join(appRoot, 'local-packages.json'), '{"packages": {"@x/a": {}}}');
  const deps = stubbed(appRoot);
  assert.equal(list({}, deps), 0);
  assert.equal(deps.warns.length, 1);
  assert.match(deps.warns[0], /local-packages\.json is no longer read/);
});

// --- an interrupted set-up -------------------------------------------------

test('checkouts an interrupted set-up left in packages-local/.setup-aside are moved back first', (t) => {
  for (const command of ['list', 'delocalize', 'localize'] as const) {
    const appRoot = consumer(t);
    seedCheckout(appRoot, 'packages-local/.setup-aside/x-a', {name: '@x/a', version: '1.0.0'});
    const deps = stubbed(appRoot, (inv) =>
      inv.cmd === 'git' && inv.args[0] === 'symbolic-ref' ? ok('main\n') : undefined,
    );
    if (command === 'list') assert.equal(list({}, deps), 0, deps.output());
    // Nothing named so: the restored checkout is what is parked.
    if (command === 'delocalize') assert.equal(delocalize([], {}, deps), 0, deps.output());
    if (command === 'localize')
      assert.equal(localize(['@x/a'], {}, deps), 6, 'then refused as already there');
    assert.match(
      deps.output(),
      /moved 1 checkout back from packages-local\/\.setup-aside\/ into packages-local\//,
      command,
    );
    assert.equal(fs.existsSync(path.join(appRoot, 'packages-local/.setup-aside')), false, command);
    const home = command === 'delocalize' ? '.packages-local.parked/x-a' : 'packages-local/x-a';
    assert.ok(fs.existsSync(path.join(appRoot, home, 'package.json')), `${command}: ${home}`);
  }
});

test('a leftover that clashes with a checkout of the same name refuses (exit 6) and moves nothing', (t) => {
  const appRoot = consumer(t);
  seedCheckout(appRoot, 'packages-local/.setup-aside/x-a', {name: '@x/a', version: '1.0.0'});
  seedCheckout(appRoot, 'packages-local/x-a', {name: '@x/a', version: '2.0.0'});
  const deps = stubbed(appRoot);
  assert.equal(list({}, deps), 6);
  assert.match(deps.output(), /packages-local\/x-a now exists too.*Nothing was moved/s);
  assert.ok(fs.existsSync(path.join(appRoot, 'packages-local/.setup-aside/x-a/package.json')));
  assert.equal(deps.calls.length, 0);
});
