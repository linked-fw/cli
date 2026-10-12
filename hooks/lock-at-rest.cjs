// Keeps the committed package-lock.json clean at rest while checkouts in packages-local/* are
// workspace members. With them present npm rewrites the lockfile to list them; the committed one
// must stay the registry lockfile. The app's `postinstall` and `dependencies` scripts run this as
//   node node_modules/@_linked/cli/hooks/lock-at-rest.cjs
// so it is plain, unbuilt CommonJS with Node built-ins only: it must work when the cli is a fresh
// checkout without lib/, and it never needs the `linked` binary to exist.
//
// It never fails the install: no git, not a work tree, git refusing (safe.directory in Docker), no
// HEAD yet -- all exit 0 with nothing changed.
'use strict';
const {execFileSync, spawnSync} = require('child_process');
const fs = require('fs');
const path = require('path');

// npm runs lifecycle scripts from the package root: the app. (__dirname is no guide: a localized
// cli resolves to its checkout, not to node_modules/@_linked/cli.)
const root = process.cwd();

// npm pipes (and hides) the output of the `dependencies` script, so also write to the terminal.
let tty = null;
if (process.env.npm_lifecycle_event === 'dependencies') {
  try {
    tty = fs.openSync('/dev/tty', 'w');
  } catch {
    tty = null;
  }
}
function write(text) {
  process.stderr.write(text);
  if (tty !== null) {
    try {
      fs.writeSync(tty, text);
    } catch {
      /* the terminal went away; stderr has it */
    }
  }
}
const say = (m) => write(`[lock-at-rest] ${m}\n`);

function git(...args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function main() {
  const localDir = path.join(root, 'packages-local');
  let entries = [];
  try {
    entries = fs.readdirSync(localDir);
  } catch {
    return; // nothing localized: npm owns the lockfile as usual
  }
  const members = entries.filter((d) => {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(localDir, d, 'package.json'), 'utf8'));
      return typeof pkg.name === 'string' && pkg.name !== '';
    } catch {
      return false;
    }
  });
  if (!members.length) return;

  let changed, lockDirty;
  try {
    if (git('rev-parse', '--is-inside-work-tree').trim() !== 'true') return;
    // A changed manifest means the developer is changing dependencies: leave the lockfile alone.
    changed = git('diff', '--name-only', 'HEAD', '--', 'package.json', 'packages/*/package.json').trim();
    // Tracked and different from HEAD; an app that does not commit its lockfile has nothing to restore.
    lockDirty = git('diff', '--name-only', 'HEAD', '--', 'package-lock.json').trim();
  } catch {
    return; // no git, not a work tree, no HEAD, or git refused
  }

  const linked = `packages-local/{${members.join(',')}}`;
  if (changed) {
    if (lockDirty) {
      say(`WARNING: ${changed.split('\n').join(', ')} differ(s) from HEAD while ${linked} are linked.`);
      say('package-lock.json now references packages-local and must NOT be committed.');
      say(
        'To change dependencies: npx linked delocalize, npm install <dep>, commit, then npx linked localize --parked.',
      );
    }
  } else if (lockDirty) {
    try {
      // From HEAD, not the index: a staged lockfile written while linked is just as wrong.
      git('checkout', 'HEAD', '--', 'package-lock.json');
      say(`restored the committed package-lock.json (${linked} stay linked in node_modules)`);
    } catch (e) {
      say(`could not restore package-lock.json: ${String((e && e.stderr) || e).trim()}`);
    }
  }

  // The drift report. Report only: its exit code says drift, and drift never fails an install.
  const linkedBin = path.join(root, 'node_modules', '.bin', 'linked');
  if (fs.existsSync(linkedBin)) {
    const r = spawnSync(linkedBin, ['localize', '--list', '--check'], {cwd: root, encoding: 'utf8'});
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    if (out) write(out.endsWith('\n') ? out : `${out}\n`);
  }
}

try {
  main();
} catch (e) {
  say(`skipped: ${e && e.message ? e.message : e}`);
}
process.exit(0);
