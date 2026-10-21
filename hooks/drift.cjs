// Drift -- what npm is silent about once checkouts are workspace members.
//
// npm links the app's dependency on a localized package to its checkout by name, whatever the
// version; when one checkout misses another's range it nests a registry copy that stays after the
// range is reverted; and `npm ci` exits 0 with a dangling link when a checkout directory is gone.
// Each of those loads code nobody meant to load, so this reports them:
//
// - `second-copy`: another copy of a localized package, besides its checkout;
// - `singleton-copy`: a nested copy of a package the app must load once;
// - `range-miss`: a declared range a checkout's version does not satisfy;
// - `missing-dir`: npm installed a checkout that is no longer there.
//
// It reads npm's hidden lockfile (`node_modules/.package-lock.json`): the committed
// `package-lock.json` is restored to the registry one after every install (lock-at-rest.cjs) and
// does not describe the linked tree. Ranges come from the live manifests, because the hidden
// lockfile lags an edit until the next install. It only reports; nothing here fails a command.
//
// The one implementation: lock-at-rest.cjs requires it after an install, and the cli's
// src/localize/drift.ts loads it (and its range check) for `linked localize --list` and the check
// before `linked start`.
// Plain, unbuilt CommonJS with Node built-ins only; `semver` is used when it can be required from
// here (the cli depends on it), and without it no range is checked.
'use strict';
const fs = require('fs');
const path = require('path');

const {
  LOCAL_DIR,
  readJson,
  trackedGlobs,
  expandGlobs,
  localMembers,
} = require('./manifests.cjs');

let semver = null;
try {
  semver = require('semver');
} catch {
  semver = null;
}

// One copy each, app-wide, localized or not: they hold registries of classes (or React's
// context), so a second copy splits the app in two.
const SINGLETONS = Object.freeze([
  '@_linked/core',
  '@_linked/react',
  '@_linked/server-utils',
]);

const DEP_FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
];

// What an app without `workspaces` is read with: the layout linked apps use.
const DEFAULT_GLOBS = ['packages/*'];

/**
 * Does `version` satisfy `range`? null means "cannot tell" -- a dist-tag, `file:`, `npm:`,
 * `workspace:`, a git URL, a version that is not one, or no `semver` to ask -- and drift then
 * reports nothing: npm links the checkout for such a range anyway. npm's own `semver` decides, so
 * prereleases follow npm's rule.
 */
function satisfies(version, range) {
  if (!semver || typeof version !== 'string' || typeof range !== 'string')
    return null;
  if (semver.valid(version) === null) return null;
  if (semver.validRange(range) === null) return null;
  return semver.satisfies(version, range);
}

/**
 * The checkout whose install `appRoot` runs on. A worktree that symlinks the main checkout's
 * `node_modules` runs on the main checkout's install, so its hidden lockfile describes the main
 * checkout's `packages-local/`, not the worktree's.
 */
function installRoot(appRoot) {
  const nodeModules = path.join(appRoot, 'node_modules');
  try {
    if (fs.lstatSync(nodeModules).isSymbolicLink())
      return path.dirname(fs.realpathSync(nodeModules));
  } catch {
    // No node_modules, or a dangling link: the app root itself.
  }
  return appRoot;
}

/** Every drift in the installed tree, in a stable order. No install yet means none. */
function driftProblems(appRootIn) {
  const appRoot = installRoot(appRootIn);
  const lock = readJson(
    path.join(appRoot, 'node_modules', '.package-lock.json'),
  );
  const packages =
    lock && typeof lock.packages === 'object' && lock.packages !== null
      ? lock.packages
      : null;
  if (!packages) return [];

  const members = localMembers(appRoot);
  const byName = new Map(members.map((m) => [m.name, m]));
  const problems = [];

  const memberKey = new RegExp(`^${LOCAL_DIR}/[^/]+$`);
  const keys = Object.keys(packages).sort();
  for (const key of keys) {
    if (
      memberKey.test(key) &&
      !fs.existsSync(path.join(appRoot, key, 'package.json'))
    )
      problems.push({kind: 'missing-dir', dir: key});
  }

  for (const key of keys) {
    const m = key.match(/(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)$/);
    if (!m) continue;
    const name = m[1];
    const entry = packages[key] || {};
    const version = typeof entry.version === 'string' ? entry.version : '';
    const member = byName.get(name);
    if (member) {
      // The checkout itself, reached through a link, is the one copy.
      if (entry.link === true && entry.resolved === member.dir) continue;
      problems.push({kind: 'second-copy', name, version, at: key});
    } else if (SINGLETONS.includes(name) && key !== `node_modules/${name}`) {
      problems.push({kind: 'singleton-copy', name, version, at: key});
    }
  }

  for (const importer of importers(appRoot, members)) {
    const pkg = readJson(path.join(appRoot, importer, 'package.json'));
    if (!pkg) continue;
    for (const field of DEP_FIELDS) {
      const declared = pkg[field];
      if (!declared || typeof declared !== 'object') continue;
      for (const [name, range] of Object.entries(declared)) {
        const member = byName.get(name);
        if (!member || typeof range !== 'string') continue;
        // null -- a tag, `file:`, `workspace:` -- is not a miss: npm links the checkout anyway.
        if (satisfies(member.version, range) !== false) continue;
        problems.push({
          kind: 'range-miss',
          name,
          version: member.version,
          dir: member.dir,
          range,
          field,
          importer: importer === '.' ? '<root>' : importer,
        });
      }
    }
  }
  return problems;
}

/**
 * The app, its tracked members (every `workspaces` glob but the checkouts') and its checkouts:
 * everything whose ranges npm resolves.
 */
function importers(appRoot, members) {
  const tracked = expandGlobs(
    appRoot,
    trackedGlobs(appRoot, DEFAULT_GLOBS),
  ).filter((dir) => dir !== LOCAL_DIR && !dir.startsWith(`${LOCAL_DIR}/`));
  return ['.', ...tracked, ...members.map((m) => m.dir)];
}

/** One line, for `--list`, the check before `start` and friends, and lock-at-rest. */
function describeDrift(d) {
  switch (d.kind) {
    case 'second-copy':
      return `second copy of localized ${d.name}@${d.version} at ${d.at}`;
    case 'singleton-copy':
      return `nested copy of ${d.name}@${d.version} at ${d.at} — the app should load one`;
    case 'range-miss':
      return `${d.name}@${d.version} (${d.dir}) does not satisfy ${d.field} "${d.range}" of ${d.importer}`;
    case 'missing-dir':
      return `${d.dir} is installed but its checkout is gone — run npm install`;
    default:
      return `unknown drift ${JSON.stringify(d)}`;
  }
}

module.exports = {driftProblems, describeDrift, satisfies, installRoot};
