// The git hooks `linked localize` writes into a clone (src/localize/git-hooks.ts) all hand over to
//   node node_modules/@_linked/cli/hooks/git-hook.cjs <hook> [git's arguments]
// from the app directory, which may sit below the git top level. Plain, unbuilt CommonJS with Node
// built-ins only, like lock-at-rest.cjs: a fresh cli checkout without lib/ must still run it.
//
// - pre-commit: refuse a staged package.json or package-lock.json that lists a checkout
//   ("packages-local/<dir>"); the glob "packages-local/*" itself is the committed setup. When git
//   cannot show what is staged, it refuses too: a guard that cannot look does not let things by.
// - post-merge, post-checkout: `npm install` when the dependency manifests changed, so the
//   checkouts are linked again on top of the new lockfile. Nothing at all when this work tree has
//   no checkouts (hooks are shared by every worktree of a repository). Never fails the git command.
'use strict';
const {execFileSync, spawnSync} = require('child_process');

const {LEAK, localMembers, manifestPathspecs} = require('./manifests.cjs');

const MANIFESTS = ['package.json', 'package-lock.json'];
const NO_COMMIT = /^0+$/;

// An app's lockfile is often over a megabyte, execFileSync's default buffer.
const MAX_BUFFER = 256 * 1024 * 1024;

// The app directory: the hook shim starts this from there, and npm and every pathspec below are
// relative to it.
const root = process.cwd();

function git(...args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: MAX_BUFFER,
  });
}

const errorText = (e) => String((e && e.stderr) || (e && e.message) || e).trim();
const BYPASS = '  (git commit --no-verify skips this check.)\n';

function preCommit() {
  let staged;
  try {
    // Added, copied, modified, renamed -- not deleted: a staged deletion lists no checkout.
    staged = git('diff', '--cached', '--name-only', '--diff-filter=d', '--relative').split('\n');
  } catch (e) {
    process.stderr.write(`pre-commit: refusing: cannot list the staged files: ${errorText(e)}\n${BYPASS}`);
    return 1;
  }
  let refused = 0;
  for (const file of MANIFESTS) {
    if (!staged.includes(file)) continue;
    let content;
    try {
      content = git('show', `:./${file}`);
    } catch (e) {
      process.stderr.write(`pre-commit: refusing ${file}: cannot read the staged copy: ${errorText(e)}\n${BYPASS}`);
      refused = 1;
      continue;
    }
    if (!LEAK.test(content)) continue;
    process.stderr.write(
      `pre-commit: refusing ${file}: it references packages-local/ (written while packages were localized).\n`,
    );
    refused = 1;
  }
  if (refused) {
    process.stderr.write(
      '  To change dependencies: npx linked delocalize, npm install <dep>, commit, then npx linked localize --parked.\n',
    );
  }
  return refused;
}

/** `npm install` when the dependency manifests differ between two commits. Always 0. */
function installIfChanged(oldRev, newRev) {
  if (!oldRev || !newRev || oldRev === newRev) return 0;
  if (NO_COMMIT.test(oldRev)) return 0; // a fresh clone: the developer runs npm ci
  if (!localMembers(root).length) return 0; // no checkouts here: npm ci / npm install as usual
  // `git diff --quiet` exits 1 when there are differences; anything else is "cannot tell".
  const files = [...manifestPathspecs(root), 'package-lock.json'];
  const diff = spawnSync('git', ['diff', '--quiet', oldRev, newRev, '--', ...files], {cwd: root, stdio: 'ignore'});
  if (diff.status !== 1) return 0;

  process.stderr.write(`[git hook] dependency manifests changed (${oldRev.slice(0, 9)}..${newRev.slice(0, 9)}): npm install\n`);
  const start = Date.now();
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const r = spawnSync(npm, ['install', '--no-audit', '--no-fund'], {cwd: root, stdio: 'inherit', env: npmEnv()});
  if (r.status !== 0) {
    process.stderr.write('[git hook] npm install FAILED - run it by hand\n');
    return 0;
  }
  process.stderr.write(`[git hook] npm install done in ${Math.round((Date.now() - start) / 1000)}s\n`);
  return 0;
}

// git exports the variables that locate this repository to its hooks; npm would hand them to every
// checkout's lifecycle scripts, and a `git` there would act on the app's repository, not its own.
function npmEnv() {
  const env = {...process.env};
  for (const key of [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_INDEX_FILE',
    'GIT_COMMON_DIR',
    'GIT_PREFIX',
    'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  ])
    delete env[key];
  return env;
}

function revParse(rev) {
  try {
    return git('rev-parse', '--verify', '--quiet', rev).trim();
  } catch {
    return '';
  }
}

function main(argv) {
  const [hook, ...args] = argv;
  switch (hook) {
    case 'pre-commit':
      return preCommit();
    case 'post-merge':
      return installIfChanged(revParse('ORIG_HEAD'), revParse('HEAD'));
    case 'post-checkout':
      // $3 is 1 for a branch checkout and 0 for a file checkout -- lock-at-rest's own restore of
      // package-lock.json is one, and must not start another install.
      if (args[2] !== '1') return 0;
      return installIfChanged(args[0], args[1]);
    default:
      return 0;
  }
}

let code = 0;
try {
  code = main(process.argv.slice(2));
} catch (e) {
  process.stderr.write(`[git hook] skipped: ${e && e.message ? e.message : e}\n`);
}
process.exit(code);
