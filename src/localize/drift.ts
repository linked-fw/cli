/**
 * Drift -- what npm is silent about once checkouts are workspace members.
 *
 * npm links the app's dependency on a localized package to its checkout by
 * name, whatever the version; when one checkout misses another's range it
 * nests a registry copy that stays after the range is reverted; and `npm ci`
 * exits 0 with a dangling link when a checkout directory is gone. Each of
 * those loads code nobody meant to load, so this reports them:
 *
 * - `second-copy`: another copy of a localized package, besides its checkout;
 * - `singleton-copy`: a nested copy of a package the app must load once;
 * - `range-miss`: a declared range a checkout's version does not satisfy;
 * - `missing-dir`: npm installed a checkout that is no longer there.
 *
 * It reads npm's hidden lockfile (`node_modules/.package-lock.json`): the
 * committed `package-lock.json` is restored to the registry one after every
 * install (hooks/lock-at-rest.cjs) and does not describe the linked tree.
 * Ranges come from the live manifests, because the hidden lockfile lags an
 * edit until the next install. It only reports; nothing here fails a command.
 */
import fs from 'node:fs';
import path from 'node:path';

import {readJson} from './fsops.js';
import {LOCAL_DIR, localMembers} from './members.js';
import type {Member} from './members.js';
import {satisfies} from './semver.js';

export type Drift =
  | {kind: 'second-copy'; name: string; version: string; at: string}
  | {kind: 'singleton-copy'; name: string; version: string; at: string}
  | {
      kind: 'range-miss';
      name: string;
      version: string;
      dir: string;
      range: string;
      field: string;
      importer: string;
    }
  | {kind: 'missing-dir'; dir: string};

/**
 * One copy each, app-wide, localized or not: they hold registries of classes
 * (or React's context), so a second copy splits the app in two.
 */
export const SINGLETONS: readonly string[] = [
  '@_linked/core',
  '@_linked/react',
  '@_linked/server-utils',
];

const DEP_FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
] as const;

interface LockEntry {
  version?: unknown;
  link?: unknown;
  resolved?: unknown;
}

/** Every drift in the installed tree, in a stable order. No install yet means none. */
export function driftProblems(appRoot: string): Drift[] {
  const lock = readJson(
    path.join(appRoot, 'node_modules', '.package-lock.json'),
  );
  const packages: Record<string, LockEntry> | null =
    lock && typeof lock.packages === 'object' && lock.packages !== null
      ? lock.packages
      : null;
  if (!packages) return [];

  const members = localMembers(appRoot);
  const byName = new Map(members.map((m) => [m.name, m]));
  const problems: Drift[] = [];

  const memberKey = new RegExp(`^${LOCAL_DIR}/[^/]+$`);
  for (const key of Object.keys(packages).sort()) {
    if (
      memberKey.test(key) &&
      !fs.existsSync(path.join(appRoot, key, 'package.json'))
    )
      problems.push({kind: 'missing-dir', dir: key});
  }

  for (const key of Object.keys(packages).sort()) {
    const m = key.match(/(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)$/);
    if (!m) continue;
    const name = m[1];
    const entry = packages[key] ?? {};
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
        // `null` -- a tag, `file:`, `workspace:` -- is not a miss: npm links the checkout anyway.
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

/** The app, its tracked members (`packages/*`) and its checkouts: everything whose ranges npm resolves. */
function importers(appRoot: string, members: Member[]): string[] {
  const out = ['.'];
  let tracked: string[] = [];
  try {
    tracked = fs.readdirSync(path.join(appRoot, 'packages')).sort();
  } catch {
    /* no packages/ */
  }
  for (const dir of tracked) {
    if (fs.existsSync(path.join(appRoot, 'packages', dir, 'package.json')))
      out.push(`packages/${dir}`);
  }
  return [...out, ...members.map((m) => m.dir)];
}

/** One line, for `--list` and the drift check before `start` and friends. */
export function describeDrift(d: Drift): string {
  switch (d.kind) {
    case 'second-copy':
      return `second copy of localized ${d.name}@${d.version} at ${d.at}`;
    case 'singleton-copy':
      return `nested copy of ${d.name}@${d.version} at ${d.at} — the app should load one`;
    case 'range-miss':
      return `${d.name}@${d.version} (${d.dir}) does not satisfy ${d.field} "${d.range}" of ${d.importer}`;
    case 'missing-dir':
      return `${d.dir} is installed but its checkout is gone — run npm install`;
  }
}
