// Keeps package-lock.json "clean at rest" while framework packages are developed in
// packages-local/*. npm always rewrites the lockfile to include present workspace members;
// the committed lockfile must stay the registry one. Runs from postinstall and dependencies.
const {execFileSync} = require('child_process');
const fs = require('fs'), path = require('path');
const root = path.resolve(__dirname, '..');
const git = (...a) => execFileSync('git', a, {cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']});
// npm pipes (and hides) the output of the `dependencies` script, so also write to the terminal.
let tty = null;
if (process.env.npm_lifecycle_event === 'dependencies') { try { tty = fs.openSync('/dev/tty', 'w'); } catch {} }
const say = (m) => { const line = `[lock-at-rest] ${m}\n`; process.stderr.write(line); if (tty !== null) fs.writeSync(tty, line); };

const localDir = path.join(root, 'packages-local');
const members = fs.existsSync(localDir)
  ? fs.readdirSync(localDir).filter((d) => fs.existsSync(path.join(localDir, d, 'package.json')))
  : [];
if (!members.length) process.exit(0); // nothing localized: npm owns the lockfile as usual

try { git('rev-parse', '--git-dir'); } catch { process.exit(0); } // not a git checkout (Docker build etc.)

// Any tracked manifest changed vs HEAD? Then the dev is changing dependencies: leave the lock alone.
const changed = git('diff', '--name-only', 'HEAD', '--', 'package.json', 'packages/*/package.json').trim();
const lockDirty = git('status', '--porcelain', '--', 'package-lock.json').trim();
if (changed) {
  if (lockDirty) {
    say(`WARNING: ${changed.split('\n').join(', ')} differ(s) from HEAD while packages-local/{${members.join(',')}} are linked.`);
    say('package-lock.json now references packages-local and must NOT be committed.');
    say('To change dependencies: move packages-local aside (npm run delocalize), npm install <dep>, commit, then npm run relocalize.');
  }
  process.exit(0);
}
if (lockDirty) {
  git('checkout', '--', 'package-lock.json');
  say(`restored the committed package-lock.json (packages-local/{${members.join(',')}} stay linked in node_modules)`);
}
// drift report (never fails the install)
try { execFileSync(process.execPath, [path.join(__dirname, 'check-local.cjs')], {cwd: root, stdio: 'inherit'}); } catch { say('localize check reported problems (see above)'); }
