/**
 * THE test. Everything else in this suite stubs the subprocess runner; this
 * one does not.
 *
 * It runs a real `git clone` and a real `npm install` in an app set up the way
 * `linked localize` sets one up (`"packages-local/*"` in `workspaces`, the
 * lock-at-rest hook in `postinstall` and `dependencies`), committed to git,
 * and asserts the two properties the design rests on:
 *
 *   1. npm links the checkout: `node_modules/<name>` is a symlink into
 *      `packages-local/`, and the checkout's dependency is installed for it;
 *   2. the working tree is clean afterwards: the hook put the committed
 *      lockfile back, so `git status --porcelain` is empty.
 *
 * Then the round trip: delocalize parks the checkout and `npm ci` restores the
 * registry tree, and localize takes it back, all with a clean tree. And the
 * first localize in an app not set up yet: the work tree then holds exactly
 * the set-up to commit, its lockfile hunk included.
 *
 * The hook is run from this repository (`hooks/lock-at-rest.cjs`) by absolute
 * path: the fixture app has no `node_modules/@_linked/cli` to run it from.
 *
 * Marked `slow:` -- real subprocess work, a few seconds in all, with a long
 * timeout for a cold npm cache. It runs in `test:unit`, the suite CI runs.
 */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import {localize} from '../../../src/localize/localize.js';
import {delocalize} from '../../../src/localize/delocalize.js';
import {buildFixtureRepo} from './fixtures/build-fixture-repo.js';
import {
  makeConsumer,
  realDeps,
  rm,
  scrubbedNpmEnv,
  test,
  tmpdir,
} from './helpers.js';

/** A real clone and a real install; generous for a cold npm cache on CI. */
const SLOW = 120_000;

const LOCK_AT_REST = path.resolve(__dirname, '../../../hooks/lock-at-rest.cjs');

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'localize tests',
  GIT_AUTHOR_EMAIL: 'tests@localize.invalid',
  GIT_COMMITTER_NAME: 'localize tests',
  GIT_COMMITTER_EMAIL: 'tests@localize.invalid',
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, {cwd, encoding: 'utf8', env: gitEnv});

/**
 * An app already set up for checkouts, installed with none and committed:
 * the state a developer is in after committing localize's one-time setup.
 */
function setUpApp(): string {
  const hook = `node ${JSON.stringify(LOCK_AT_REST)}`;
  const appRoot = makeConsumer({
    pkg: {
      workspaces: ['packages-local/*'],
      scripts: {postinstall: hook, dependencies: hook},
    },
  });
  fs.writeFileSync(
    path.join(appRoot, '.gitignore'),
    'node_modules/\npackages-local/\n.packages-local.parked/\n',
  );
  execFileSync('npm', ['install', '--no-audit', '--no-fund'], {
    cwd: appRoot,
    env: scrubbedNpmEnv(),
    stdio: 'pipe',
  });
  git(appRoot, 'init', '-q', '-b', 'main');
  git(appRoot, 'add', '-A');
  git(appRoot, 'commit', '-q', '-m', 'app');
  return appRoot;
}

const status = (appRoot: string) => git(appRoot, 'status', '--porcelain');

test(
  'slow: a real localize clones, npm links the checkout, and the tree is clean after the hook',
  async (t) => {
    const scratch = tmpdir('localize-fixture-');
    const {repoUrl, depName, name} = buildFixtureRepo(scratch);
    const appRoot = setUpApp();
    t.after(() => {
      rm(scratch);
      rm(appRoot);
    });
    const lockBefore = fs.readFileSync(path.join(appRoot, 'package-lock.json'));

    const deps = realDeps(appRoot);
    // `--repo` rather than a registry lookup: the fixture package is not
    // published anywhere. Everything after resolution is real.
    const code = localize([name], {repo: repoUrl, build: ''}, deps);
    assert.equal(code, 0, `localize failed:\n${deps.output()}`);
    assert.doesNotMatch(deps.output(), /set up this app/, 'already set up');

    const checkout = path.join(appRoot, 'packages-local', name);
    assert.ok(fs.existsSync(path.join(checkout, '.git')), 'a real clone');

    // 1. npm linked the member, and installed its dependency for it.
    const link = path.join(appRoot, 'node_modules', name);
    assert.ok(
      fs.lstatSync(link).isSymbolicLink(),
      'node_modules/<name> is a symlink',
    );
    assert.equal(fs.realpathSync(link), fs.realpathSync(checkout));
    const mod = await import(path.join(link, 'src', 'index.js'));
    assert.equal(mod.widget, 'from source');
    assert.ok(
      fs.existsSync(
        path.join(appRoot, 'node_modules', depName, 'package.json'),
      ),
      `${depName} was installed with the root install`,
    );

    // 2. the hook restored the committed lockfile: nothing to commit.
    assert.equal(status(appRoot), '', 'git status --porcelain is empty');
    assert.deepEqual(
      fs.readFileSync(path.join(appRoot, 'package-lock.json')),
      lockBefore,
    );
    // ...while npm's own record of the tree has the member.
    const hidden = JSON.parse(
      fs.readFileSync(
        path.join(appRoot, 'node_modules/.package-lock.json'),
        'utf8',
      ),
    );
    assert.ok(
      hidden.packages[`packages-local/${name}`],
      'the hidden lockfile lists it',
    );

    // --- delocalize parks it, npm ci restores the registry tree -------------
    assert.equal(delocalize([name], {}, deps), 0, deps.output());
    assert.equal(fs.existsSync(link), false, 'no member, no link');
    assert.ok(
      fs.existsSync(
        path.join(appRoot, '.packages-local.parked', name, 'src', 'index.js'),
      ),
      'the work is parked, not deleted',
    );
    assert.equal(status(appRoot), '');

    // --- and localize takes it back, without cloning -----------------------
    assert.equal(localize([name], {repo: 'unused'}, deps), 0, deps.output());
    assert.equal(fs.realpathSync(link), fs.realpathSync(checkout));
    assert.equal(status(appRoot), '');
  },
  SLOW,
);

test(
  'slow: a real localize of a package inside a monorepo links the package, not the repository root',
  (t) => {
    const scratch = tmpdir('localize-fixture-');
    const {repoUrl, depName, name} = buildFixtureRepo(scratch, {
      subdir: 'packages/widget',
    });
    const appRoot = setUpApp();
    t.after(() => {
      rm(scratch);
      rm(appRoot);
    });

    const deps = realDeps(appRoot);
    const code = localize(
      [name],
      {repo: repoUrl, subdir: 'packages/widget', build: ''},
      deps,
    );
    assert.equal(code, 0, deps.output());

    const clone = path.join(appRoot, 'packages-local', '.repos', name);
    const pkgDir = path.join(clone, 'packages', 'widget');
    assert.ok(
      fs.existsSync(path.join(clone, '.git')),
      'the clone is the whole repository',
    );
    assert.equal(
      fs.realpathSync(path.join(appRoot, 'node_modules', name)),
      fs.realpathSync(pkgDir),
    );
    assert.ok(fs.existsSync(path.join(appRoot, 'node_modules', depName)));
    assert.equal(
      fs.existsSync(
        path.join(appRoot, 'node_modules', 'fixture-monorepo-root'),
      ),
      false,
      'the repository root is not a member',
    );
    assert.equal(status(appRoot), '');
  },
  SLOW,
);

test(
  'slow: a real localize refuses a monorepo root and leaves no clone behind',
  (t) => {
    const scratch = tmpdir('localize-fixture-');
    const {repoUrl, name} = buildFixtureRepo(scratch, {
      subdir: 'packages/widget',
    });
    const appRoot = setUpApp();
    t.after(() => {
      rm(scratch);
      rm(appRoot);
    });

    const deps = realDeps(appRoot);
    // No --subdir: the repository root is a different package.
    const code = localize([name], {repo: repoUrl}, deps);

    assert.equal(code, 6, deps.output());
    assert.match(deps.output(), /declares itself as "fixture-monorepo-root"/);
    assert.match(deps.output(), /--subdir/);
    assert.equal(
      fs.readdirSync(path.join(appRoot, 'packages-local')).join(','),
      '',
      'no clone left in packages-local/',
    );
    assert.equal(
      fs.existsSync(path.join(appRoot, 'node_modules', name)),
      false,
    );
  },
  SLOW,
);

test(
  'slow: a first localize in an app not yet set up leaves exactly the set-up to commit',
  (t) => {
    const scratch = tmpdir('localize-fixture-');
    const {repoUrl, depName, depTarball, name} = buildFixtureRepo(scratch);
    const appRoot = makeConsumer({
      pkg: {dependencies: {[depName]: `file:${depTarball}`}},
    });
    t.after(() => {
      rm(scratch);
      rm(appRoot);
    });
    fs.writeFileSync(path.join(appRoot, '.gitignore'), 'node_modules/\n');
    execFileSync('npm', ['install', '--no-audit', '--no-fund'], {
      cwd: appRoot,
      env: scrubbedNpmEnv(),
      stdio: 'pipe',
    });
    git(appRoot, 'init', '-q', '-b', 'main');
    git(appRoot, 'add', '-A');
    git(appRoot, 'commit', '-q', '-m', 'app');

    const deps = realDeps(appRoot);
    const code = localize([name], {repo: repoUrl, build: ''}, deps);
    assert.equal(code, 0, deps.output());
    assert.match(deps.output(), /set up this app for checkouts/);
    assert.match(deps.output(), /put back the set-up's lockfile/);
    assert.ok(
      fs.lstatSync(path.join(appRoot, 'node_modules', name)).isSymbolicLink(),
      'and the checkout is linked',
    );

    assert.deepEqual(status(appRoot).split('\n').filter(Boolean).sort(), [
      ' M .gitignore',
      ' M package-lock.json',
      ' M package.json',
    ]);
    const lockDiff = git(appRoot, 'diff', '-U0', '--', 'package-lock.json');
    // Only the root entry's set-up hunk: the glob, and the install script the hook added.
    const changed = lockDiff
      .split('\n')
      .filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---) /.test(l))
      .map((l) => l.replace(/\s+/g, ''));
    assert.deepEqual(
      changed,
      [
        '+"hasInstallScript":true,',
        '+"workspaces":[',
        '+"packages-local/*"',
        '+],',
      ],
      lockDiff,
    );
    assert.equal((lockDiff.match(/^@@/gm) ?? []).length, 1, 'one hunk');
  },
  SLOW,
);

test(
  'slow: an app with workspaces and an install script gets its set-up lockfile by an edit that npm ci accepts',
  (t) => {
    const scratch = tmpdir('localize-fixture-');
    const {repoUrl, depName, depTarball, name} = buildFixtureRepo(scratch);
    const appRoot = makeConsumer({
      pkg: {
        workspaces: ['packages/*'],
        scripts: {postinstall: 'node -e 0'},
        dependencies: {[depName]: `file:${depTarball}`},
      },
    });
    t.after(() => {
      rm(scratch);
      rm(appRoot);
    });
    fs.mkdirSync(path.join(appRoot, 'packages'));
    fs.writeFileSync(path.join(appRoot, '.gitignore'), 'node_modules/\n');
    execFileSync('npm', ['install', '--no-audit', '--no-fund'], {
      cwd: appRoot,
      env: scrubbedNpmEnv(),
      stdio: 'pipe',
    });
    git(appRoot, 'init', '-q', '-b', 'main');
    git(appRoot, 'add', '-A');
    git(appRoot, 'commit', '-q', '-m', 'app');

    const deps = realDeps(appRoot);
    const code = localize([name], {repo: repoUrl, build: ''}, deps);
    assert.equal(code, 0, deps.output());
    assert.match(
      deps.output(),
      /root entry's "workspaces" now matches package\.json/,
    );
    assert.doesNotMatch(deps.output(), /package-lock-only/);

    const changed = git(appRoot, 'diff', '-U0', '--', 'package-lock.json')
      .split('\n')
      .filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---) /.test(l))
      .map((l) => l.replace(/\s+/g, ''));
    assert.deepEqual(changed, [
      '-"packages/*"',
      '+"packages/*",',
      '+"packages-local/*"',
    ]);

    // What CI sees: the committed set-up, no checkout.
    fs.renameSync(
      path.join(appRoot, 'packages-local'),
      path.join(scratch, 'parked'),
    );
    execFileSync('npm', ['ci', '--no-audit', '--no-fund'], {
      cwd: appRoot,
      env: scrubbedNpmEnv(),
      stdio: 'pipe',
    });
  },
  SLOW,
);
