/**
 * `--list` -- read the SYMLINKS, then reconcile against the manifest.
 *
 * The manifest records INTENT; the symlink is TRUTH. They can disagree -- most
 * commonly because `npm ci` deleted `node_modules` and exited 0 -- so this
 * reads the links first and reports the disagreement rather than assuming.
 * The four states are distinguished deliberately: both of the silent failures
 * this tool was built to end were disagreements between intent and truth.
 *
 * It also flags a directory in the checkout directory (`packages-local/`) that
 * nothing records and nothing links: every checkout there is meant to be
 * localized, and one that is not loads nobody's code while looking as if it
 * did.
 *
 * Never writes. Exits 0, unless `--check` and something recorded is not
 * actually linked.
 */
import fs from 'node:fs';
import path from 'node:path';

import {MANIFEST_FILENAME, readManifest} from './manifest.js';
import {isInside, linkTarget, readJson, scanLinks} from './fsops.js';
import {reportError} from './localize.js';
import type {Deps} from './run.js';

/** One row of `--list`: a recorded package, or a link the manifest does not know. */
export interface ListRow {
  name: string;
  state:
    | 'linked'
    | 'checkout-missing'
    | 'not-linked'
    | 'malformed'
    | 'untracked'
    | 'unrecorded';
  path: string;
  branch: string;
  note: string;
}

/** @returns {{rows: object[], notLinked: number}} */
export function collect(deps: Deps): {rows: ListRow[]; notLinked: number} {
  const manifest = readManifest(deps.appRoot, deps);
  const dir = path.join(deps.appRoot, manifest.dir);
  const rows: ListRow[] = [];

  for (const [name, entry] of Object.entries(manifest.entries)) {
    const checkout = path.join(deps.appRoot, entry.path);
    const target = linkTarget(deps.appRoot, name);

    if (target && isInside(target, dir)) {
      rows.push({
        name,
        state: 'linked',
        path: entry.path,
        branch: entry.branch,
        note: '',
      });
    } else if (!fs.existsSync(checkout)) {
      // Recorded, but nothing on disk. `localize <name>` re-clones it when the
      // entry has a repo or the package is published; otherwise it is restored by hand.
      rows.push({
        name,
        state: 'checkout-missing',
        path: entry.path,
        branch: '—',
        note: 'CHECKOUT MISSING',
      });
    } else {
      // Intent and checkout present, symlink gone. This is what `npm ci`
      // leaves behind, and it is the state that costs hours.
      rows.push({
        name,
        state: 'not-linked',
        path: entry.path,
        branch: entry.branch,
        note: 'checkout present',
      });
    }
  }

  for (const m of manifest.malformed) {
    rows.push({
      name: m.name,
      state: 'malformed',
      path: '—',
      branch: '—',
      note: `malformed entry (${m.reason})`,
    });
  }

  // A symlink out of node_modules that the manifest does not know about.
  // Reported, never touched.
  const untrackedTargets: string[] = [];
  for (const {name, target} of scanLinks(deps.appRoot)) {
    if (manifest.entries[name]) continue;
    untrackedTargets.push(target);
    rows.push({
      name,
      state: 'untracked',
      path: path.relative(deps.appRoot, target),
      branch: '—',
      note: `not in ${MANIFEST_FILENAME}`,
    });
  }

  // A directory in the checkout directory with no record (and no link, which
  // the row above already reports).
  const recorded = Object.values(manifest.entries).map((e) =>
    real(path.join(deps.appRoot, e.path)),
  );
  for (const sub of directoriesIn(dir)) {
    const abs = real(path.join(dir, sub));
    if (recorded.some((r) => r === abs || isInside(r, abs))) continue;
    if (untrackedTargets.some((t) => t === abs || isInside(t, abs))) continue;
    const pkg = readJson(path.join(abs, 'package.json'));
    rows.push({
      name: typeof pkg?.name === 'string' ? pkg.name : '—',
      state: 'unrecorded',
      path: path.join(manifest.dir, sub),
      branch: '—',
      note: `directory not in ${MANIFEST_FILENAME}`,
    });
  }

  const notLinked = rows.filter(
    (r) => r.state === 'not-linked' || r.state === 'checkout-missing',
  ).length;
  return {rows, notLinked};
}

export function list(opts: {check?: boolean}, deps: Deps): number {
  let result;
  try {
    result = collect(deps);
  } catch (e) {
    return reportError(e, deps);
  }
  const {rows, notLinked} = result;

  if (!rows.length) return 0; // nothing localized, nothing to say

  const pad = (n, s) => s.padEnd(n);
  const nameW = Math.max(...rows.map((r) => r.name.length)) + 2;
  const pathW = Math.max(...rows.map((r) => r.path.length)) + 2;
  for (const r of rows) {
    const label =
      r.state === 'linked' || r.state === 'untracked'
        ? 'linked'
        : r.state === 'unrecorded'
          ? 'UNRECORDED'
          : 'NOT LINKED';
    deps.log(
      pad(nameW, r.name) +
        pad(12, label) +
        pad(pathW, r.path) +
        pad(11, r.branch) +
        r.note,
    );
  }

  const count = (s) => rows.filter((r) => r.state === s).length;
  const parts = [`${count('linked')} linked`, `${notLinked} not linked`];
  if (count('untracked')) parts.push(`${count('untracked')} untracked link`);
  if (count('malformed')) parts.push(`${count('malformed')} malformed entry`);
  if (count('unrecorded'))
    parts.push(
      `${count('unrecorded')} unrecorded ${count('unrecorded') === 1 ? 'directory' : 'directories'}`,
    );
  deps.log('');
  deps.log(parts.join(' · '));

  return opts.check && notLinked > 0 ? 1 : 0;
}

/** The (non-hidden) directories directly in `dir`, following links; none when it is absent. */
function directoriesIn(dir: string): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names.filter((n) => {
    if (n.startsWith('.')) return false;
    try {
      return fs.statSync(path.join(dir, n)).isDirectory();
    } catch {
      return false;
    }
  });
}

function real(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}
