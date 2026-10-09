/**
 * One copy, always: the shared rule (provided.ts), install-then-prune
 * (`ensure`) and the run-time check (`checkOneCopy`), plus `--list` flagging a
 * checkout directory nothing records.
 *
 * Real filesystem, stubbed subprocesses, as in prune.test.ts.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import semver from 'semver';

import {providedPackages} from '../../../src/localize/provided.js';
import {checkOneCopy, ensure, reinstall} from '../../../src/localize/ensure.js';
import {collect, list} from '../../../src/localize/list.js';
import {writeManifest} from '../../../src/localize/manifest.js';
import {checkoutNameFor} from '../../../src/localize/resolve.js';
import {
  EXIT_INSTALL_FAILED,
  EXIT_REFUSED,
} from '../../../src/localize/errors.js';
import {localizedDedupe} from '../../../src/localized-dedupe.js';
import {readInstalledPkg} from '../../../src/installed-packages.js';
import {fail, makeConsumer, ok, rm, stubbed, test} from './helpers.js';

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

const record = (appRoot, map) =>
  writeManifest(appRoot, {
    dir: 'packages-local',
    packages: Object.fromEntries(
      Object.entries(map).map(([name, p]) => [
        name,
        {repo: 'r', path: path.relative(appRoot, p as string), branch: 'main'},
      ]),
    ),
  });

/** Deps whose `run` fails the test: the run-time check must never spawn anything. */
function noRun(appRoot) {
  const deps = stubbed(appRoot, (inv) => {
    throw new Error(`checkOneCopy ran ${inv.cmd} ${inv.args.join(' ')}`);
  });
  return deps;
}

// ---------------------------------------------------------------------------
// The rule: parity with the localizedDedupe that shipped before it existed.
// ---------------------------------------------------------------------------

/** localizedDedupe as it was before `providedPackages` (cli 1.41.1), verbatim in behaviour. */
async function legacyLocalizedDedupe(appRoot) {
  const FIELDS = ['dependencies', 'peerDependencies', 'optionalDependencies'];
  const readJson = (f) => {
    try {
      return JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch {
      return null;
    }
  };
  const sat = (v, r) => {
    try {
      return semver.validRange(r) !== null && semver.satisfies(v, r);
    } catch {
      return false;
    }
  };
  const manifest = readJson(path.join(appRoot, 'local-packages.json'));
  const localized = Object.keys(manifest?.packages ?? {}).filter((n) =>
    fs.existsSync(path.join(appRoot, 'node_modules', n, 'package.json')),
  );
  const names = new Set<string>(localized);
  const skipped: any[] = [];
  const asks = new Map<string, any[]>();
  for (const from of localized) {
    const pkg =
      readJson(path.join(appRoot, 'node_modules', from, 'package.json')) ?? {};
    for (const field of FIELDS) {
      for (const [dep, range] of Object.entries<string>(pkg[field] ?? {})) {
        if (names.has(dep)) continue;
        const l = asks.get(dep) ?? [];
        if (!l.some((a) => a.from === from)) l.push({from, range});
        asks.set(dep, l);
      }
    }
  }
  const nestedMap = new Map<string, string>();
  const nm = path.join(appRoot, 'node_modules');
  const pkgNames = (dir) => {
    let e: string[];
    try {
      e = fs.readdirSync(dir);
    } catch {
      return [];
    }
    const out: string[] = [];
    for (const x of e) {
      if (x.startsWith('.')) continue;
      if (x.startsWith('@')) {
        try {
          for (const s of fs.readdirSync(path.join(dir, x)))
            out.push(`${x}/${s}`);
        } catch {}
      } else out.push(x);
    }
    return out;
  };
  const walk = (dir, depth) => {
    for (const n of pkgNames(dir)) {
      const d = path.join(dir, n);
      let st;
      try {
        st = fs.lstatSync(d);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue;
      if (depth > 0 && !nestedMap.has(n))
        nestedMap.set(n, path.relative(path.dirname(nm), d));
      walk(path.join(d, 'node_modules'), depth + 1);
    }
  };
  if (asks.size) walk(nm, 0);
  for (const [name, ranges] of asks) {
    const app = await readInstalledPkg(name, appRoot);
    if (!app?.json?.version) continue;
    const unmet = ranges.filter((a) => !sat(app.json.version, a.range));
    if (unmet.length)
      skipped.push({
        name,
        reason: 'range',
        asks: unmet,
        appVersion: app.json.version,
      });
    else if (nestedMap.has(name))
      skipped.push({name, reason: 'nested', nestedAt: nestedMap.get(name)});
    else names.add(name);
  }
  for (const name of ['react', 'react-dom'])
    if (await readInstalledPkg(name, appRoot)) names.add(name);
  return {names: [...names].sort(), skipped};
}

/** Every branch of the rule in one app. */
function ruleFixture(t) {
  const appRoot = consumer(t);
  appHas(appRoot, '@fw/core', '2.25.0');
  appHas(appRoot, 'lodash', '4.17.21');
  appHas(appRoot, 'motion', '12.4.0');
  appHas(appRoot, 'react', '19.1.0');
  appHas(appRoot, 'react-dom', '19.1.0');
  appHas(appRoot, 'zod', '3.23.0');
  appHas(appRoot, 'odd', 'not-a-version');
  appHas(appRoot, 'typescript', '5.9.3');
  // a registry install that nests its own lodash and react-dom
  pkgAt(
    path.join(appRoot, 'node_modules', 'old-tool', 'node_modules', 'lodash'),
    {
      name: 'lodash',
      version: '3.10.1',
    },
  );
  pkgAt(
    path.join(appRoot, 'node_modules', 'old-tool', 'node_modules', 'react-dom'),
    {name: 'react-dom', version: '18.0.0'},
  );
  const a = checkout(appRoot, '@fw/a', {
    dependencies: {
      '@fw/core': '^2.22.8',
      '@fw/b': '^1.0.0', // a localized sibling: always in
      lodash: '^4.17.0', // nested elsewhere: Vite leaves it out, the rule keeps it
      motion: '^13.0.0', // the app's 12 misses: skipped
      missing: '^1.0.0', // the app does not have it
      odd: '^1.0.0', // a version that is not one
    },
    peerDependencies: {react: '^18.0.0', 'react-dom': '>=18'},
    optionalDependencies: {zod: '^3.0.0'},
    devDependencies: {typescript: '^5.0.0'}, // not runtime: never in
  });
  const b = checkout(appRoot, '@fw/b', {
    version: '2.0.0',
    dependencies: {'@fw/core': '~2.25.0', zod: 'latest'}, // a dist-tag: cannot tell -> skipped
  });
  writeManifest(appRoot, {
    dir: 'packages-local',
    packages: {
      '@fw/a': {path: path.relative(appRoot, a), branch: 'main'},
      '@fw/b': {path: path.relative(appRoot, b), branch: 'main'},
      '@fw/gone': {path: 'packages-local/fw-gone', branch: 'main'}, // recorded, not installed
    },
  });
  return appRoot;
}

const bySkip = (s) =>
  [...s].sort((x, y) =>
    `${x.name}:${x.reason}`.localeCompare(`${y.name}:${y.reason}`),
  );

test('rule parity: localizedDedupe gives exactly what it gave before providedPackages existed', async (t) => {
  const appRoot = ruleFixture(t);
  const before = await legacyLocalizedDedupe(appRoot);
  const now = await localizedDedupe(appRoot);
  assert.deepEqual(now.names, before.names);
  assert.deepEqual(bySkip(now.skipped), bySkip(before.skipped));
  // and the fixture really does exercise every branch
  assert.deepEqual(before.names, [
    '@fw/a',
    '@fw/b',
    '@fw/core',
    'react',
    'react-dom',
  ]);
  assert.deepEqual(
    before.skipped.map((s) => `${s.name}:${s.reason}`).sort(),
    [
      'lodash:nested',
      'motion:range',
      'odd:range',
      'react-dom:nested',
      'react:range',
      'zod:range',
    ].sort(),
  );
});

test('the rule itself keeps what only Vite must drop: a dependency some registry install nests', (t) => {
  const appRoot = ruleFixture(t);
  const rule = providedPackages(appRoot);
  assert.deepEqual(rule.names, [
    '@fw/a',
    '@fw/b',
    '@fw/core',
    'lodash',
    'react',
    'react-dom',
  ]);
  assert.deepEqual(rule.localized, ['@fw/a', '@fw/b']);
  assert.deepEqual(rule.skipped.map((s) => s.name).sort(), [
    'motion',
    'odd',
    'react',
    'zod',
  ]);
});

test('the rule with nothing localized: react and react-dom only', (t) => {
  const appRoot = consumer(t);
  appHas(appRoot, 'react', '19.1.0');
  assert.deepEqual(providedPackages(appRoot).names, ['react']);
});

// ---------------------------------------------------------------------------
// ensure: npm install in the checkout, then prune it
// ---------------------------------------------------------------------------

test('ensure installs inside the checkout, then prunes what the install put back', (t) => {
  const appRoot = consumer(t);
  appHas(appRoot, '@fw/core', '2.25.0');
  appHas(appRoot, 'react', '19.1.0');
  const a = checkout(appRoot, '@fw/a', {
    dependencies: {'@fw/core': '^2.22.8', tool: '^1.0.0'},
    peerDependencies: {react: '^19.0.0'},
  });
  record(appRoot, {'@fw/a': a});

  let sawCopiesAfterInstall = false;
  const deps = stubbed(appRoot, (inv) => {
    if (inv.cmd === 'npm') {
      nested(a, '@fw/core', '2.22.8');
      nested(a, 'react', '19.0.0');
      nested(a, 'tool', '1.0.0');
      sawCopiesAfterInstall = has(a, '@fw/core');
    }
    return ok();
  });

  assert.equal(ensure({path: 'packages-local/fw-a'}, deps), 0, deps.output());
  assert.deepEqual(
    deps.npmCalls().map((c) => [c.args[0], c.cwd]),
    [['install', a]],
    'one npm install, inside the checkout, never at the root',
  );
  assert.ok(sawCopiesAfterInstall);
  assert.equal(
    has(a, '@fw/core'),
    false,
    'the install put core back; ensure took it out',
  );
  assert.equal(has(a, 'react'), false);
  assert.ok(has(a, 'tool'), 'what the app does not provide stays');
  assert.match(
    deps.output(),
    /fw-a: removed its own copies .*@fw\/core@2\.22\.8/,
  );
});

test('ensure installs with --no-save, so the checkout keeps its committed lockfile', (t) => {
  // A plain `npm install` rewrites the checkout's package-lock.json in the
  // dialect of whichever npm is first on PATH. Measured: Node 22's bundled
  // npm 10.9.9 drops every `"libc"` entry an npm 12 lockfile records, and any
  // npm syncs a lockfile header the release bumped. `--no-save` installs from
  // the lockfile and writes neither package.json nor package-lock.json.
  const appRoot = consumer(t);
  const a = checkout(appRoot, '@fw/a', {dependencies: {tool: '^1.0.0'}});
  record(appRoot, {'@fw/a': a});
  const deps = stubbed(appRoot, () => ok());

  assert.equal(ensure({path: 'packages-local/fw-a'}, deps), 0, deps.output());
  const [install] = deps.npmCalls();
  assert.equal(install.args[0], 'install');
  assert.ok(
    install.args.includes('--no-save'),
    `npm ${install.args.join(' ')} would rewrite the checkout's lockfile`,
  );
});

test('ensure installs with --include=dev, whatever the outer npm command omitted', (t) => {
  // ensure runs from the app's npm lifecycle hooks, and npm exports the outer
  // command's config to them as npm_config_*: `npm install --omit=dev` at the
  // app root arrives as npm_config_omit=dev, and an inner `npm install` that
  // inherits it skips the checkout's devDependencies -- its compiler among
  // them, so the checkout no longer builds. `--include=dev` wins over omit.
  const appRoot = consumer(t);
  const a = checkout(appRoot, '@fw/a', {devDependencies: {tool: '^1.0.0'}});
  record(appRoot, {'@fw/a': a});
  const deps = stubbed(appRoot, () => ok());

  assert.equal(ensure({path: 'packages-local/fw-a'}, deps), 0, deps.output());
  const [install] = deps.npmCalls();
  assert.equal(install.args[0], 'install');
  assert.ok(
    install.args.includes('--include=dev'),
    `npm ${install.args.join(' ')} would inherit npm_config_omit=dev and skip devDependencies`,
  );
});

test('ensure with {prune: false} only installs', (t) => {
  const appRoot = consumer(t);
  appHas(appRoot, '@fw/core', '2.25.0');
  const a = checkout(appRoot, '@fw/a', {dependencies: {'@fw/core': '^2.0.0'}});
  record(appRoot, {'@fw/a': a});
  const deps = stubbed(appRoot, (inv) => {
    if (inv.cmd === 'npm') nested(a, '@fw/core', '2.22.8');
    return ok();
  });
  assert.equal(ensure({path: 'packages-local/fw-a'}, deps, {prune: false}), 0);
  assert.ok(has(a, '@fw/core'));
});

test('ensure throws EXIT_INSTALL_FAILED when the install fails, and prunes nothing', (t) => {
  const appRoot = consumer(t);
  appHas(appRoot, '@fw/core', '2.25.0');
  const a = checkout(appRoot, '@fw/a', {dependencies: {'@fw/core': '^2.0.0'}});
  nested(a, '@fw/core', '2.22.8');
  record(appRoot, {'@fw/a': a});
  const deps = stubbed(appRoot, () => fail('ENETUNREACH'));
  assert.throws(
    () => ensure({path: 'packages-local/fw-a'}, deps),
    (e: any) =>
      e.code === EXIT_INSTALL_FAILED &&
      /npm install failed in packages-local\/fw-a:\nENETUNREACH/.test(
        e.message,
      ),
  );
  assert.ok(has(a, '@fw/core'));
});

test('--reinstall <pkg> goes through ensure: install in that checkout, then prune', (t) => {
  const appRoot = consumer(t);
  appHas(appRoot, '@fw/core', '2.25.0');
  const a = checkout(appRoot, '@fw/a', {dependencies: {'@fw/core': '^2.0.0'}});
  record(appRoot, {'@fw/a': a});
  const deps = stubbed(appRoot, (inv) => {
    if (inv.cmd === 'npm') nested(a, '@fw/core', '2.22.8');
    return ok();
  });
  assert.equal(reinstall('@fw/a', {}, deps), 0, deps.output());
  assert.deepEqual(
    deps.npmCalls().map((c) => c.cwd),
    [a],
  );
  assert.equal(has(a, '@fw/core'), false);

  const unknown = stubbed(appRoot);
  assert.equal(reinstall('@fw/nope', {}, unknown), EXIT_REFUSED);
  assert.equal(unknown.npmCalls().length, 0);
  assert.match(unknown.errors.join('\n'), /@fw\/nope is not localized here/);
});

// ---------------------------------------------------------------------------
// checkOneCopy: the run-time check
// ---------------------------------------------------------------------------

/** A clean, localized app: A and B localized, core at the root, nothing duplicated. */
function cleanApp(t) {
  const appRoot = consumer(t);
  appHas(appRoot, '@fw/core', '2.25.0');
  appHas(appRoot, 'react', '19.1.0');
  const b = checkout(appRoot, '@fw/b', {
    version: '1.3.0',
    dependencies: {'@fw/core': '^2.0.0'},
  });
  const a = checkout(appRoot, '@fw/a', {
    dependencies: {'@fw/core': '^2.0.0', '@fw/b': '^1.0.0', tool: '1'},
  });
  nested(a, 'tool', '1.0.0'); // the app lacks it: a checkout's own, legitimately
  record(appRoot, {'@fw/a': a, '@fw/b': b});
  return {appRoot, a, b};
}

test('checkOneCopy removes a planted duplicate, says so in ONE line, and never runs anything', (t) => {
  const {appRoot, a, b} = cleanApp(t);
  // what a hand-run `npm install` in the checkouts leaves behind
  nested(a, '@fw/core', '2.22.8');
  nested(a, '@fw/b', '1.1.0');
  nested(b, 'react', '19.0.0');
  const bin = path.join(a, 'node_modules', '.bin');
  fs.mkdirSync(bin, {recursive: true});
  fs.symlinkSync('../@fw/core/cli.js', path.join(bin, 'core'));

  const deps = noRun(appRoot);
  const {pruned} = checkOneCopy(appRoot, deps);

  assert.deepEqual(pruned.sort(), [
    'packages-local/fw-a/node_modules/@fw/b@1.1.0',
    'packages-local/fw-a/node_modules/@fw/core@2.22.8',
    'packages-local/fw-b/node_modules/react@19.0.0',
  ]);
  assert.equal(has(a, '@fw/core'), false);
  assert.equal(has(a, '@fw/b'), false);
  assert.equal(has(b, 'react'), false);
  assert.ok(has(a, 'tool'), 'not provided by the app: untouched');
  assert.equal(fs.existsSync(path.join(bin, 'core')), false);
  // On stderr: it precedes a run command's own output, which may be piped.
  assert.equal(deps.warns.length, 1, deps.output());
  assert.equal(deps.logs.length + deps.errors.length, 0, deps.output());
  assert.match(
    deps.warns[0],
    /^\[localize\] one copy: removed .*fw-a\/node_modules\/@fw\/core@2\.22\.8.* — the app provides them\.$/,
  );
  assert.equal(deps.calls.length, 0);

  // ...and a second run has nothing to say.
  const again = noRun(appRoot);
  assert.deepEqual(checkOneCopy(appRoot, again).pruned, []);
  assert.equal(again.output(), '');
});

test('checkOneCopy is silent and touches nothing when the app is clean', (t) => {
  const {appRoot, a} = cleanApp(t);
  const deps = noRun(appRoot);
  assert.deepEqual(checkOneCopy(appRoot, deps), {pruned: []});
  assert.equal(deps.output(), '');
  assert.ok(has(a, 'tool'));
});

test('checkOneCopy is a no-op with no manifest, even with duplicates on disk', (t) => {
  const appRoot = consumer(t);
  appHas(appRoot, '@fw/core', '2.25.0');
  const a = checkout(appRoot, '@fw/a', {dependencies: {'@fw/core': '^2.0.0'}});
  nested(a, '@fw/core', '2.22.8');
  const deps = noRun(appRoot);
  assert.deepEqual(checkOneCopy(appRoot, deps), {pruned: []});
  assert.equal(deps.output(), '');
  assert.ok(has(a, '@fw/core'), 'unrecorded checkouts are not its business');
});

test("checkOneCopy goes through prune's guard: a copy another package needs stays, quietly", (t) => {
  const {appRoot, a} = cleanApp(t);
  nested(a, '@fw/core', '2.30.0');
  // tool resolves to A's core and asks more than the app's 2.25.0
  fs.writeFileSync(
    path.join(a, 'node_modules', 'tool', 'package.json'),
    JSON.stringify({
      name: 'tool',
      version: '1.0.0',
      dependencies: {'@fw/core': '^2.30.0'},
    }),
  );
  const deps = noRun(appRoot);
  assert.deepEqual(checkOneCopy(appRoot, deps).pruned, []);
  assert.ok(has(a, '@fw/core'));
  assert.equal(
    deps.output(),
    '',
    'kept copies are for localize/relink to report, not every start',
  );
});

test('checkOneCopy never throws: a broken manifest is one warning', (t) => {
  const appRoot = consumer(t);
  fs.writeFileSync(path.join(appRoot, 'local-packages.json'), '{not json');
  const deps = noRun(appRoot);
  assert.deepEqual(checkOneCopy(appRoot, deps), {pruned: []});
  assert.match(deps.warns.join('\n'), /one-copy check failed/);
});

// ---------------------------------------------------------------------------
// --list flags a directory in packages-local/ that nothing records
// ---------------------------------------------------------------------------

test('--list flags a directory in packages-local/ with no record (and only those)', (t) => {
  const {appRoot} = cleanApp(t);
  // nothing records or links it
  pkgAt(path.join(appRoot, 'packages-local', '_linked-stray'), {
    name: '@_linked/stray',
    version: '1.0.0',
  });
  // linked but unrecorded: already reported as an untracked link, not twice
  const linked = pkgAt(path.join(appRoot, 'packages-local', 'loose'), {
    name: 'loose',
    version: '1.0.0',
  });
  fs.symlinkSync(linked, path.join(appRoot, 'node_modules', 'loose'), 'dir');
  fs.mkdirSync(path.join(appRoot, 'packages-local', '.cache'));
  fs.writeFileSync(path.join(appRoot, 'packages-local', 'README'), '');

  const deps = stubbed(appRoot);
  const {rows} = collect(deps);
  const states = Object.fromEntries(rows.map((r) => [r.path, r.state]));
  assert.deepEqual(states, {
    'packages-local/fw-a': 'linked',
    'packages-local/fw-b': 'linked',
    'packages-local/loose': 'untracked',
    'packages-local/_linked-stray': 'unrecorded',
  });
  assert.equal(
    rows.find((r) => r.state === 'unrecorded')!.name,
    '@_linked/stray',
  );

  assert.equal(
    list({check: true}, deps),
    0,
    'an unrecorded directory does not fail --check',
  );
  assert.match(
    deps.output(),
    /@_linked\/stray\s+UNRECORDED\s+packages-local\/_linked-stray/,
  );
  assert.match(
    deps.output(),
    /2 linked · 0 not linked · 1 untracked link · 1 unrecorded directory/,
  );
});
