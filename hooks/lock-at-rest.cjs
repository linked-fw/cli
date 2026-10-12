// Keeps the committed package-lock.json clean at rest while checkouts in packages-local/* are
// workspace members. With them present npm rewrites the lockfile to list them; the committed one
// must stay the registry lockfile. The app's `postinstall` and `dependencies` scripts run it
// through a guard that does nothing when the cli is not installed (`npm ci --omit=dev`):
//   node -e "const p='node_modules/@_linked/cli/hooks/lock-at-rest.cjs';require('fs').existsSync(p)&&require(require('path').resolve(p))"
// so it runs when required as well as when run as `node lock-at-rest.cjs`. It is plain, unbuilt
// CommonJS with Node built-ins only: it must work when the cli is a fresh checkout without lib/,
// and it never needs the `linked` binary to exist.
//
// It never fails the install: no git, not a work tree, git refusing (safe.directory in Docker), no
// HEAD yet -- all leave the lockfile as npm wrote it.
'use strict';
const {execFileSync} = require('child_process');
const {createHash} = require('crypto');
const fs = require('fs');
const path = require('path');

const {LEAK, LOCAL_DIR, localMembers, manifestPathspecs} = require('./manifests.cjs');
const {hookLine, runsOurHook} = require('./hook-shim.cjs');
const {terminalDevice} = require('./platform.cjs');

// An app's lockfile is often over a megabyte, execFileSync's default buffer.
const MAX_BUFFER = 256 * 1024 * 1024;
const LOCKFILE = 'package-lock.json';
const ADVICE = 'To change dependencies: npx linked delocalize, npm install <dep>, commit, then npx linked localize --parked.';
// Where an interrupted first set-up leaves the checkouts: SETUP_ASIDE_DIR in src/localize/localize.ts.
const SETUP_ASIDE = `${LOCAL_DIR}/.setup-aside`;

function run() {
  // npm runs lifecycle scripts from the package root: the app, which may sit below the git top
  // level. (__dirname is no guide: a localized cli resolves to its checkout.)
  const root = process.cwd();

  // npm pipes (and hides) the output of the `dependencies` script, so also write to the terminal,
  // opened the first time there is something to say.
  let tty;
  function write(text) {
    process.stderr.write(text);
    if (process.env.npm_lifecycle_event !== 'dependencies') return;
    if (tty === undefined) {
      const device = terminalDevice();
      try {
        // Windows has no such device: there, only stderr (hidden by npm for this script).
        tty = device ? fs.openSync(device, 'w') : null;
      } catch {
        tty = null;
      }
    }
    if (tty === null) return;
    try {
      fs.writeSync(tty, text);
    } catch {
      /* the terminal went away; stderr has it */
    }
  }
  const say = (m) => write(`[lock-at-rest] ${m}\n`);

  function git(...args) {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: MAX_BUFFER,
    });
  }

  /** The staged lockfile, or null when the index has none (or git cannot say). */
  function staged() {
    try {
      return git('show', `:./${LOCKFILE}`);
    } catch {
      return null;
    }
  }

  function restore(members) {
    let changed, lockDirty;
    try {
      if (git('rev-parse', '--is-inside-work-tree').trim() !== 'true') return;
      // A changed manifest means the developer is changing dependencies: leave the lockfile alone.
      changed = git('diff', '--name-only', '--relative', 'HEAD', '--', ...manifestPathspecs(root)).trim();
      // Tracked and different from HEAD; an app that does not commit its lockfile has nothing to restore.
      lockDirty = git('diff', '--name-only', '--relative', 'HEAD', '--', LOCKFILE).trim();
    } catch {
      return; // no git, not a work tree, no HEAD, or git refused
    }
    if (!lockDirty) return;

    const linked = `${members.map((m) => m.dir).join(', ')} stay linked in node_modules`;
    if (changed) {
      say(`WARNING: ${changed.split('\n').join(', ')} differ(s) from HEAD while checkouts are linked (${linked}).`);
      say(`${LOCKFILE} now references packages-local and must NOT be committed.`);
      say(ADVICE);
      return;
    }

    // The staged lockfile is the developer's, unless it was written while linked too.
    const index = staged();
    if (index === null) {
      say(`${LOCKFILE} is not in the index; left as npm wrote it.`);
      return;
    }
    try {
      if (LEAK.test(index)) {
        git('checkout', 'HEAD', '--', LOCKFILE);
        say(`restored the committed ${LOCKFILE} (the staged one listed a checkout; ${linked})`);
      } else {
        if (!git('diff', '--name-only', '--', LOCKFILE).trim()) return; // the work tree is the index
        const stagedChange = git('diff', '--cached', '--name-only', '--', LOCKFILE).trim() !== '';
        git('checkout', '--', LOCKFILE);
        say(`restored the ${stagedChange ? 'staged' : 'committed'} ${LOCKFILE} (${linked})`);
      }
      say('Changes to dependencies made while localized are not kept: they need `linked delocalize` first.');
    } catch (e) {
      say(`could not restore ${LOCKFILE}: ${String((e && e.stderr) || e).trim()}`);
    }
  }

  // A clone set up by hand (a bootstrap that copied packages-local/ in, or ran `npm install` only)
  // never got the git hooks: no pre-commit refuses a leaked lockfile, and no npm install follows a
  // pull. The lines to print when this is a work tree, `core.hooksPath` is unset (then the hooks
  // are added by hand, see git-hooks.ts) and the hooks directory has no pre-commit that runs ours;
  // none otherwise.
  function hooksNotice(members) {
    try {
      if (git('rev-parse', '--is-inside-work-tree').trim() !== 'true') return [];
    } catch {
      return [];
    }
    try {
      if (git('config', 'core.hooksPath').trim()) return [];
    } catch {
      /* unset */
    }
    let file, prefix;
    try {
      file = path.resolve(root, git('rev-parse', '--git-path', 'hooks').trim(), 'pre-commit');
      prefix = git('rev-parse', '--show-prefix').trim();
    } catch {
      return [];
    }
    let text = null;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      /* no pre-commit */
    }
    if (text === null) {
      // --adopt needs a git checkout: name one that is.
      const checkout = members.find((m) => fs.existsSync(path.join(root, m.dir, '.git')));
      const name = checkout ? checkout.name : "<any checkout's name>";
      return [`git hooks are not installed in this clone: run \`npx linked localize ${name} --adopt --build ''\` once`];
    }
    if (runsOurHook(text)) return [];
    // localize leaves a hook it did not write alone, so --adopt would not help: add ours by hand.
    return [
      `${path.relative(root, file)} is not ours, so nothing refuses a commit of a lockfile that ` +
        'lists a checkout. Add this line to it (it does nothing where the cli is not installed):',
      `  ${hookLine('pre-commit', prefix)}`,
    ];
  }

  // The drift report and the missing-hooks notice, after the hidden lockfile npm just wrote; only
  // when its content changed since the last report, so the second of `postinstall` and
  // `dependencies`, and an install that changed nothing, stay quiet. npm rewrites the file on every
  // install, so its mtime says nothing: the stamp is a hash of the content. Report only.
  function report(members) {
    const nodeModules = path.join(root, 'node_modules');
    let content;
    try {
      content = fs.readFileSync(path.join(nodeModules, '.package-lock.json'));
    } catch {
      return; // nothing installed
    }
    const stamp = `${createHash('sha1').update(content).digest('hex')}\n`;
    const stampFile = path.join(nodeModules, '.cache', 'linked-localize', 'drift-stamp');
    try {
      if (fs.readFileSync(stampFile, 'utf8') === stamp) return;
    } catch {
      /* no report yet */
    }
    const {driftProblems, describeDrift} = require('./drift.cjs');
    for (const d of driftProblems(root)) write(`[localize] drift: ${describeDrift(d)}\n`);
    for (const line of hooksNotice(members)) say(line);
    try {
      fs.mkdirSync(path.dirname(stampFile), {recursive: true});
      fs.writeFileSync(stampFile, stamp);
    } catch {
      /* reported again next time */
    }
  }

  try {
    // Rare, and the checkouts there are invisible to npm until moved back: said on every install.
    if (fs.existsSync(path.join(root, SETUP_ASIDE)))
      say(`checkouts are set aside in ${SETUP_ASIDE}/ (an interrupted set-up): \`npx linked localize --list\` moves them back`);
    const members = localMembers(root);
    if (!members.length) return; // nothing localized: npm owns the lockfile as usual
    restore(members);
    report(members);
  } catch (e) {
    say(`skipped: ${e && e.message ? e.message : e}`);
  } finally {
    if (typeof tty === 'number') {
      try {
        fs.closeSync(tty);
      } catch {
        /* closed already */
      }
    }
  }
}

run();
