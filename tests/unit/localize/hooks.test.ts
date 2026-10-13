/**
 * The dependency-free hooks in `hooks/`, run the way npm and git run them: as
 * `node hooks/<file>.cjs` in a real git repository, with nothing from `lib/`
 * or `node_modules`. `npm` is a stub on the PATH where a test needs one, so
 * what the hook asked npm for is recorded and nothing is installed.
 */
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {ensureAppSetup} from '../../../src/localize/app-setup.js';
import {hookLine, installGitHooks} from '../../../src/localize/git-hooks.js';
import {rm, test, tmpdir} from './helpers.js';

const HOOKS = path.resolve(__dirname, '../../../hooks');
const LOCK_AT_REST = path.join(HOOKS, 'lock-at-rest.cjs');
const GIT_HOOK = path.join(HOOKS, 'git-hook.cjs');

/** No npm lifecycle variables (no /dev/tty), and none of the developer's git config. */
function baseEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^npm_/i.test(k) || /^GIT_/.test(k)) continue;
    env[k] = v;
  }
  return {
    ...env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    ...extra,
  };
}

function git(cwd, ...args) {
  const r = spawnSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args],
    {
      cwd,
      encoding: 'utf8',
      env: baseEnv(),
    },
  );
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}

const LOCK = {name: 'app', lockfileVersion: 3, packages: {'': {name: 'app'}}};
const LEAKED = {
  ...LOCK,
  packages: {
    '': {name: 'app', workspaces: ['packages-local/*']},
    'packages-local/a': {name: '@x/a', version: '1.0.0'},
    'node_modules/@x/a': {resolved: 'packages-local/a', link: true},
  },
};
// The same leak in an app whose lockfile root does not carry the glob: the rule must catch the
// checkout entry itself, not the "packages-local/*" next to it.
const LEAKED_NO_GLOB = {
  ...LOCK,
  packages: {
    '': {name: 'app', workspaces: ['packages/*']},
    'packages-local/a': {name: '@x/a', version: '1.0.0'},
    'node_modules/@x/a': {resolved: 'packages-local/a', link: true},
  },
};
// What `npm update` might write: a registry lockfile, different from the committed one.
const UPDATED = {
  ...LOCK,
  packages: {'': {name: 'app'}, 'node_modules/left': {version: '1.1.0'}},
};
const json = (v) => JSON.stringify(v, null, 2) + '\n';
const read = (file) => fs.readFileSync(file, 'utf8');

/**
 * A committed app: package.json, package-lock.json, .gitignore for the checkouts. `sub` puts it in
 * a subdirectory of the repository; `files` adds committed files (app-relative).
 */
function app(
  t,
  {workspaces = ['packages-local/*'], sub = '', files = {}} = {},
) {
  const repo = tmpdir('localize-hooks-');
  t.after(() => rm(repo));
  const root = path.join(repo, sub);
  git(repo, 'init', '-q', '-b', 'main');
  fs.mkdirSync(root, {recursive: true});
  fs.writeFileSync(
    path.join(root, 'package.json'),
    json({name: 'app', workspaces}),
  );
  fs.writeFileSync(path.join(root, 'package-lock.json'), json(LOCK));
  fs.writeFileSync(
    path.join(root, '.gitignore'),
    'packages-local/\nnpm-calls\nnode_modules/\n.fake-bin/\n',
  );
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), {recursive: true});
    fs.writeFileSync(path.join(root, file), content);
  }
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  return root;
}

/** A checkout in packages-local/<dir>; `git` gives it a `.git` (a directory, `'file'` or none). */
function member(root, dir = 'a', name = '@x/a', {git: dotGit = 'dir'} = {}) {
  const d = path.join(root, 'packages-local', dir);
  fs.mkdirSync(d, {recursive: true});
  fs.writeFileSync(
    path.join(d, 'package.json'),
    json({name, version: '1.0.0'}),
  );
  if (dotGit === 'dir') fs.mkdirSync(path.join(d, '.git'));
  else if (dotGit === 'file')
    fs.writeFileSync(path.join(d, '.git'), 'gitdir: ../../.git/worktrees/x\n');
}

/** A `npm` on the PATH that records its arguments in `<root>/npm-calls` and exits `status`. */
function fakeNpm(root, status = 0) {
  const bin = path.join(root, '.fake-bin');
  fs.mkdirSync(bin, {recursive: true});
  const npm = path.join(bin, 'npm');
  fs.writeFileSync(
    npm,
    `#!/bin/sh\necho "$*" >> "${path.join(root, 'npm-calls')}"\nexit ${status}\n`,
  );
  fs.chmodSync(npm, 0o755);
  return `${bin}${path.delimiter}${process.env.PATH}`;
}
const npmCalls = (root) => {
  try {
    return fs
      .readFileSync(path.join(root, 'npm-calls'), 'utf8')
      .trim()
      .split('\n');
  } catch {
    return [];
  }
};

function node(script, args, cwd, env = baseEnv()) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd,
    encoding: 'utf8',
    env,
  });
}

// ---------------------------------------------------------------------------
// lock-at-rest
// ---------------------------------------------------------------------------

test('lock-at-rest: nothing localized leaves npm its lockfile', (t) => {
  const root = app(t);
  fs.writeFileSync(path.join(root, 'package-lock.json'), json(LEAKED));
  const r = node(LOCK_AT_REST, [], root);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');
  assert.equal(git(root, 'status', '--porcelain'), 'M package-lock.json');
});

test('lock-at-rest: with checkouts linked, the committed lockfile is restored', (t) => {
  const root = app(t);
  member(root);
  fs.writeFileSync(path.join(root, 'package-lock.json'), json(LEAKED));
  git(root, 'add', 'package-lock.json'); // staged is restored too
  const r = node(LOCK_AT_REST, [], root);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /restored the committed package-lock\.json/);
  assert.equal(git(root, 'status', '--porcelain'), '');
});

test('lock-at-rest: a changed package.json leaves the lockfile and says how to change dependencies', (t) => {
  const root = app(t);
  member(root);
  fs.writeFileSync(
    path.join(root, 'package.json'),
    json({
      name: 'app',
      workspaces: ['packages-local/*'],
      dependencies: {left: '^1.0.0'},
    }),
  );
  fs.writeFileSync(path.join(root, 'package-lock.json'), json(LEAKED));
  const r = node(LOCK_AT_REST, [], root);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /must NOT be committed/);
  assert.match(r.stderr, /delocalize/);
  assert.match(git(root, 'status', '--porcelain'), /M package-lock\.json/);
});

test('lock-at-rest: not a git repository, or no git at all, is exit 0 with nothing changed', (t) => {
  const dir = tmpdir('localize-hooks-nogit-');
  t.after(() => rm(dir));
  member(dir);
  fs.writeFileSync(path.join(dir, 'package-lock.json'), json(LEAKED));
  let r = node(
    LOCK_AT_REST,
    [],
    dir,
    baseEnv({GIT_CEILING_DIRECTORIES: path.dirname(dir)}),
  );
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');

  const root = app(t);
  member(root);
  fs.writeFileSync(path.join(root, 'package-lock.json'), json(LEAKED));
  r = node(LOCK_AT_REST, [], root, baseEnv({PATH: '/nonexistent'}));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');
  assert.equal(git(root, 'status', '--porcelain'), 'M package-lock.json');
});

test('lock-at-rest: a clean staged lockfile is what it restores, not HEAD', (t) => {
  const root = app(t);
  member(root);
  const lockfile = path.join(root, 'package-lock.json');
  fs.writeFileSync(lockfile, json(UPDATED));
  git(root, 'add', 'package-lock.json');
  fs.writeFileSync(lockfile, json(LEAKED_NO_GLOB));
  const r = node(LOCK_AT_REST, [], root);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /restored the staged package-lock\.json/);
  assert.match(r.stderr, /linked delocalize/);
  assert.equal(read(lockfile), json(UPDATED));
  assert.equal(git(root, 'status', '--porcelain'), 'M  package-lock.json');
});

test('lock-at-rest: a staged lockfile that lists a checkout goes too, back to HEAD', (t) => {
  const root = app(t);
  member(root);
  fs.writeFileSync(path.join(root, 'package-lock.json'), json(LEAKED_NO_GLOB));
  git(root, 'add', 'package-lock.json');
  const r = node(LOCK_AT_REST, [], root);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /restored the committed package-lock\.json/);
  assert.equal(git(root, 'status', '--porcelain'), '');
});

test('lock-at-rest: a changed manifest in any workspace folder leaves the lockfile', (t) => {
  const root = app(t, {
    workspaces: ['packages/*', 'apps/*', 'packages-local/*'],
    files: {'apps/x/package.json': json({name: 'x'})},
  });
  member(root);
  fs.writeFileSync(
    path.join(root, 'apps/x/package.json'),
    json({name: 'x', dependencies: {left: '^1.0.0'}}),
  );
  fs.writeFileSync(path.join(root, 'package-lock.json'), json(LEAKED));
  const r = node(LOCK_AT_REST, [], root);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /apps\/x\/package\.json differ/);
  assert.match(r.stderr, /delocalize/);
  assert.equal(read(path.join(root, 'package-lock.json')), json(LEAKED));
});

test('lock-at-rest: an app below the git top level restores its own lockfile', (t) => {
  const root = app(t, {sub: 'web/app'});
  member(root);
  fs.writeFileSync(path.join(root, 'package-lock.json'), json(LEAKED));
  const r = node(LOCK_AT_REST, [], root);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /restored the committed package-lock\.json/);
  assert.equal(git(root, 'status', '--porcelain'), '');
});

test('lock-at-rest: drift is reported once per change of the installed tree', (t) => {
  const root = app(t);
  member(root);
  const hidden = path.join(root, 'node_modules', '.package-lock.json');
  fs.mkdirSync(path.dirname(hidden), {recursive: true});
  const tree = (version) =>
    json({
      name: 'app',
      lockfileVersion: 3,
      packages: {
        'packages-local/a': {name: '@x/a', version: '1.0.0'},
        'node_modules/@x/a': {resolved: 'packages-local/a', link: true},
        'node_modules/foo/node_modules/@x/a': {version},
      },
    });
  fs.writeFileSync(hidden, tree('0.9.0'));

  let r = node(LOCK_AT_REST, [], root);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /drift: second copy of localized @x\/a@0\.9\.0/);
  r = node(LOCK_AT_REST, [], root); // `dependencies` after `postinstall`: same tree
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');
  // The next `npm install` that changes nothing still rewrites the file: same content, new mtime.
  fs.writeFileSync(hidden, tree('0.9.0'));
  const later = new Date(Date.now() + 60_000);
  fs.utimesSync(hidden, later, later);
  r = node(LOCK_AT_REST, [], root);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '', 'an unchanged tree is not reported again');

  fs.writeFileSync(hidden, tree('0.10.0'));
  r = node(LOCK_AT_REST, [], root);
  assert.match(r.stderr, /drift: second copy of localized @x\/a@0\.10\.0/);
});

/** What `npm install` leaves in node_modules: the hidden lockfile the report is stamped on. */
function installedTree(root, extra = {}) {
  const hidden = path.join(root, 'node_modules', '.package-lock.json');
  fs.mkdirSync(path.dirname(hidden), {recursive: true});
  fs.writeFileSync(
    hidden,
    json({
      name: 'app',
      lockfileVersion: 3,
      packages: {
        'packages-local/a': {name: '@x/a', version: '1.0.0'},
        'node_modules/@x/a': {resolved: 'packages-local/a', link: true},
        ...extra,
      },
    }),
  );
}

const HOOKS_NOTICE =
  /git hooks are not installed in this clone: run `npx linked localize @x\/a --adopt --build ''` once/;

test('lock-at-rest: a clone with checkouts but no git hooks is told how to install them, once', (t) => {
  const root = app(t);
  member(root);
  installedTree(root);
  let r = node(LOCK_AT_REST, [], root);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, HOOKS_NOTICE);
  assert.equal(r.stderr.match(new RegExp(HOOKS_NOTICE.source, 'g'))?.length, 1);
  r = node(LOCK_AT_REST, [], root); // `dependencies` after `postinstall`
  assert.equal(r.stderr, '', 'not again for the same install');
});

test('lock-at-rest: the hooks notice names a checkout that is a git checkout, else any', (t) => {
  const root = app(t);
  member(root, 'a', '@x/a', {git: 'none'});
  member(root, 'b', '@x/b', {git: 'file'});
  installedTree(root);
  let r = node(LOCK_AT_REST, [], root);
  assert.match(
    r.stderr,
    /run `npx linked localize @x\/b --adopt --build ''` once/,
  );

  fs.rmSync(path.join(root, 'packages-local', 'b', '.git'));
  installedTree(root, {'node_modules/left': {version: '1.0.0'}});
  r = node(LOCK_AT_REST, [], root);
  assert.match(
    r.stderr,
    /run `npx linked localize <any checkout's name> --adopt --build ''` once/,
  );
});

test('lock-at-rest: a pre-commit that is not ours is named, with the line to add, until it has it', (t) => {
  const root = app(t, {sub: 'web'});
  member(root);
  installedTree(root);
  const hook = path.join(path.dirname(root), '.git', 'hooks', 'pre-commit');
  fs.writeFileSync(hook, '#!/bin/sh\nexit 0\n');
  let r = node(LOCK_AT_REST, [], root);
  assert.equal(r.status, 0, r.stderr);
  const line = hookLine('pre-commit', 'web/');
  assert.match(
    r.stderr,
    /\[lock-at-rest\] \.\.\/\.git\/hooks\/pre-commit is not ours/,
  );
  assert.ok(r.stderr.includes(`\n[lock-at-rest]   ${line}\n`), r.stderr);
  assert.doesNotMatch(r.stderr, /--adopt|git hooks are not installed/);

  // The developer adds the line: the notice stops.
  fs.appendFileSync(hook, `${line}\n`);
  installedTree(root, {'node_modules/left': {version: '1.0.0'}});
  r = node(LOCK_AT_REST, [], root);
  assert.equal(r.stderr, '');
});

test('a hand-added hook line refuses the commit even when it is not the last line', (t) => {
  const root = app(t);
  const stub = path.join(
    root,
    'node_modules',
    '@_linked',
    'cli',
    'hooks',
    'git-hook.cjs',
  );
  fs.mkdirSync(path.dirname(stub), {recursive: true});
  const hook = path.join(root, 'hand-hook');
  fs.writeFileSync(hook, `#!/bin/sh\n${hookLine('pre-commit')}\necho other\n`);
  const run = () =>
    spawnSync('sh', [hook], {cwd: root, encoding: 'utf8', env: baseEnv()});

  fs.writeFileSync(
    stub,
    "process.stderr.write('refused\\n'); process.exit(1);\n",
  );
  let r = run();
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /refused/);
  assert.equal(r.stdout, '');

  // A hook that lets the commit through leaves the rest of the file to run.
  fs.writeFileSync(stub, 'process.exit(0);\n');
  r = run();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'other\n');

  // Without the cli installed the line is a no-op.
  fs.rmSync(path.join(root, 'node_modules'), {recursive: true});
  r = run();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'other\n');
});

test('lock-at-rest: checkouts left in packages-local/.setup-aside are pointed out on every install', (t) => {
  const root = app(t);
  fs.mkdirSync(path.join(root, 'packages-local', '.setup-aside', 'a'), {
    recursive: true,
  });
  const ASIDE =
    /checkouts are set aside in packages-local\/\.setup-aside\/ \(an interrupted set-up\): `npx linked localize --list` moves them back/;
  for (let i = 0; i < 2; i++) {
    const r = node(LOCK_AT_REST, [], root);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, ASIDE);
  }
  fs.rmSync(path.join(root, 'packages-local', '.setup-aside'), {
    recursive: true,
  });
  assert.equal(node(LOCK_AT_REST, [], root).stderr, '');
});

test('lock-at-rest: no hooks notice once localize wrote the hooks, or under core.hooksPath, or with nothing localized', (t) => {
  const withHooks = app(t);
  member(withHooks);
  installedTree(withHooks);
  // As localize writes them, without the developer's git config (a global core.hooksPath).
  const saved = {...process.env};
  Object.assign(process.env, {
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
  });
  let installed;
  try {
    installed = installGitHooks(withHooks);
  } finally {
    for (const k of ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM']) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
  assert.ok(installed.written.some((f) => f.endsWith('pre-commit')));
  let r = node(LOCK_AT_REST, [], withHooks);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /git hooks are not installed/);

  const husky = app(t);
  member(husky);
  installedTree(husky);
  git(husky, 'config', 'core.hooksPath', '.husky/_');
  r = node(LOCK_AT_REST, [], husky);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /git hooks are not installed/);

  const none = app(t);
  installedTree(none);
  r = node(LOCK_AT_REST, [], none);
  assert.equal(r.stderr, '');
});

test('lock-at-rest: the guarded command is a silent no-op without the cli, and runs the hook with it', (t) => {
  const root = app(t);
  member(root);
  // The scripts exactly as app set-up writes them into package.json.
  ensureAppSetup(root);
  const {scripts} = JSON.parse(read(path.join(root, 'package.json')));
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'setup');
  fs.writeFileSync(path.join(root, 'package-lock.json'), json(LEAKED));

  const sh = (cmd) =>
    spawnSync('sh', ['-c', cmd], {cwd: root, encoding: 'utf8', env: baseEnv()});
  let r = sh(scripts.postinstall);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout + r.stderr, '');
  assert.equal(git(root, 'status', '--porcelain'), 'M package-lock.json');

  const cli = path.join(root, 'node_modules', '@_linked', 'cli');
  fs.mkdirSync(cli, {recursive: true});
  fs.symlinkSync(HOOKS, path.join(cli, 'hooks'));
  r = sh(scripts.dependencies);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /restored the committed package-lock\.json/);
  assert.equal(git(root, 'status', '--porcelain'), '');
});

// ---------------------------------------------------------------------------
// git-hook
// ---------------------------------------------------------------------------

test('pre-commit refuses a staged lockfile that lists a checkout', (t) => {
  const root = app(t);
  fs.writeFileSync(path.join(root, 'package-lock.json'), json(LEAKED));
  git(root, 'add', 'package-lock.json');
  const r = node(GIT_HOOK, ['pre-commit'], root);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /refusing package-lock\.json/);
});

test('pre-commit refuses a checkout entry without the glob beside it', (t) => {
  const root = app(t, {workspaces: ['packages/*']});
  fs.writeFileSync(path.join(root, 'package-lock.json'), json(LEAKED_NO_GLOB));
  git(root, 'add', 'package-lock.json');
  const r = node(GIT_HOOK, ['pre-commit'], root);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /refusing package-lock\.json/);
});

test('pre-commit refuses when it cannot read a staged manifest', (t) => {
  const root = app(t);
  fs.writeFileSync(path.join(root, 'package-lock.json'), json(UPDATED));
  git(root, 'add', 'package-lock.json');
  // A git that lists the index but fails to show a file from it.
  const realGit = spawnSync('sh', ['-c', 'command -v git'], {
    encoding: 'utf8',
  }).stdout.trim();
  const bin = path.join(root, '.fake-bin');
  fs.mkdirSync(bin, {recursive: true});
  fs.writeFileSync(
    path.join(bin, 'git'),
    `#!/bin/sh\nif [ "$1" = show ]; then echo "fatal: unable to read blob" >&2; exit 128; fi\nexec "${realGit}" "$@"\n`,
  );
  fs.chmodSync(path.join(bin, 'git'), 0o755);
  const r = node(
    GIT_HOOK,
    ['pre-commit'],
    root,
    baseEnv({PATH: `${bin}${path.delimiter}${process.env.PATH}`}),
  );
  assert.equal(r.status, 1);
  assert.match(
    r.stderr,
    /refusing package-lock\.json: cannot read the staged copy: fatal: unable to read blob/,
  );
  assert.match(r.stderr, /--no-verify/);
});

test('pre-commit lets a staged deletion of the lockfile through', (t) => {
  const root = app(t);
  git(root, 'rm', '-q', 'package-lock.json');
  const r = node(GIT_HOOK, ['pre-commit'], root);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');
});

test("pre-commit in an app below the git top level reads the app's manifests", (t) => {
  const root = app(t, {sub: 'web/app'});
  fs.writeFileSync(path.join(root, 'package-lock.json'), json(LEAKED_NO_GLOB));
  git(root, 'add', 'package-lock.json');
  const r = node(GIT_HOOK, ['pre-commit'], root);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /refusing package-lock\.json/);
});

test('pre-commit refuses a leaked lockfile over a megabyte', (t) => {
  const root = app(t);
  const filler = Object.fromEntries(
    Array.from({length: 20000}, (_, i) => [
      `node_modules/pad-${i}`,
      {version: '1.0.0', resolved: 'x'.repeat(40)},
    ]),
  );
  const big = {...LEAKED, packages: {...LEAKED.packages, ...filler}};
  fs.writeFileSync(path.join(root, 'package-lock.json'), json(big));
  assert.ok(
    fs.statSync(path.join(root, 'package-lock.json')).size > 1024 * 1024,
  );
  git(root, 'add', 'package-lock.json');
  const r = node(GIT_HOOK, ['pre-commit'], root);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /refusing package-lock\.json/);
});

test('pre-commit refuses a staged package.json that lists a checkout', (t) => {
  const root = app(t);
  fs.writeFileSync(
    path.join(root, 'package.json'),
    json({name: 'app', workspaces: ['packages-local/*', 'packages-local/a']}),
  );
  git(root, 'add', 'package.json');
  assert.equal(node(GIT_HOOK, ['pre-commit'], root).status, 1);
});

test('pre-commit lets the glob itself through', (t) => {
  const root = app(t);
  fs.writeFileSync(
    path.join(root, 'package-lock.json'),
    json({
      ...LOCK,
      packages: {
        '': {name: 'app', workspaces: ['packages/*', 'packages-local/*']},
      },
    }),
  );
  git(root, 'add', 'package-lock.json');
  const r = node(GIT_HOOK, ['pre-commit'], root);
  assert.equal(r.status, 0, r.stderr);
  // An unstaged leak is not what is being committed.
  fs.writeFileSync(path.join(root, 'package-lock.json'), json(LEAKED));
  assert.equal(node(GIT_HOOK, ['pre-commit'], root).status, 0);
});

test('post-checkout of files ($3 = 0) does nothing: no git, no npm', (t) => {
  const root = app(t);
  const head = git(root, 'rev-parse', 'HEAD');
  const r = node(
    GIT_HOOK,
    ['post-checkout', head, head, '0'],
    root,
    baseEnv({PATH: '/nonexistent'}),
  );
  assert.equal(r.status, 0);
  assert.equal(r.stderr, '');
  assert.equal(r.stdout, '');
});

/** The current commit as `old`, a new branch `branch` at `new` that changes `file`. */
function twoCommits(root, file, content, branch = 'side') {
  const old = git(root, 'rev-parse', 'HEAD');
  git(root, 'checkout', '-q', '-b', branch);
  fs.mkdirSync(path.dirname(path.join(root, file)), {recursive: true});
  fs.writeFileSync(path.join(root, file), content);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', `change ${file}`);
  return {old, new: git(root, 'rev-parse', 'HEAD')};
}

test('post-checkout of a branch installs when the manifests changed, and only then', (t) => {
  const root = app(t, {workspaces: ['packages/*', 'packages-local/*']});
  member(root);
  const PATH = fakeNpm(root);
  const deps = twoCommits(
    root,
    'packages/site/package.json',
    json({name: 'site'}),
  );
  let r = node(
    GIT_HOOK,
    ['post-checkout', deps.old, deps.new, '1'],
    root,
    baseEnv({PATH}),
  );
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(npmCalls(root), ['install --no-audit --no-fund']);

  const other = twoCommits(root, 'README.md', 'docs only\n', 'docs');
  r = node(
    GIT_HOOK,
    ['post-checkout', other.old, other.new, '1'],
    root,
    baseEnv({PATH}),
  );
  assert.equal(r.status, 0, r.stderr);
  assert.equal(
    npmCalls(root).length,
    1,
    'no install for a change outside the manifests',
  );
});

test('post-merge compares ORIG_HEAD with HEAD, and a failed install never fails git', (t) => {
  const root = app(t);
  member(root);
  const PATH = fakeNpm(root, 1);
  twoCommits(
    root,
    'package-lock.json',
    json({...LOCK, packages: {'': {name: 'app', version: '2.0.0'}}}),
  );
  git(root, 'checkout', '-q', 'main');
  git(root, 'merge', '-q', '--ff-only', 'side');
  const r = node(GIT_HOOK, ['post-merge', '0'], root, baseEnv({PATH}));
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(npmCalls(root), ['install --no-audit --no-fund']);
  assert.match(r.stderr, /npm install FAILED/);
});

test('post-merge in a work tree without checkouts runs no npm', (t) => {
  const root = app(t);
  const PATH = fakeNpm(root);
  twoCommits(root, 'package-lock.json', json(UPDATED));
  git(root, 'checkout', '-q', 'main');
  git(root, 'merge', '-q', '--ff-only', 'side');
  const r = node(GIT_HOOK, ['post-merge', '0'], root, baseEnv({PATH}));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');
  assert.deepEqual(npmCalls(root), []);
});

test('post-checkout watches every workspace folder of an app below the git top level', (t) => {
  const root = app(t, {
    sub: 'web/app',
    workspaces: ['apps/*', 'packages-local/*'],
  });
  member(root);
  const PATH = fakeNpm(root);
  const repo = path.dirname(path.dirname(root));
  // Outside the app: not its dependencies.
  const outside = twoCommits(
    repo,
    'package.json',
    json({name: 'repo-root'}),
    'outside',
  );
  let r = node(
    GIT_HOOK,
    ['post-checkout', outside.old, outside.new, '1'],
    root,
    baseEnv({PATH}),
  );
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(npmCalls(root), []);

  const inside = twoCommits(
    repo,
    'web/app/apps/x/package.json',
    json({name: 'x'}),
    'inside',
  );
  r = node(
    GIT_HOOK,
    ['post-checkout', inside.old, inside.new, '1'],
    root,
    baseEnv({PATH}),
  );
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(npmCalls(root), ['install --no-audit --no-fund']);
});
