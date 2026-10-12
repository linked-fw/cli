/**
 * `--list` -- what is localized, what is parked, and the drift (drift.ts).
 *
 * The record is the directories: every checkout in `packages-local/` is a
 * workspace member, every one in `.packages-local.parked/` is parked. A row
 * per checkout -- name, directory, branch, version -- then one line per drift.
 *
 * `--check` is what `hooks/lock-at-rest.cjs` runs after every install, so it
 * prints only the drift (nothing when there is none) and exits 1 when there is
 * any. Never writes.
 */
import path from 'node:path';

import {describeDrift, driftProblems} from './drift.js';
import type {Drift} from './drift.js';
import {EXIT_DRIFT} from './errors.js';
import {currentBranch, legacyManifestHint} from './localize.js';
import {localMembers, parkedMembers} from './members.js';
import type {Member} from './members.js';
import type {Deps} from './run.js';

/** One row of `--list`. */
export interface ListRow extends Member {
  state: 'localized' | 'parked';
  branch: string;
}

export function collect(deps: Deps): {rows: ListRow[]; drift: Drift[]} {
  const row = (m: Member, state: ListRow['state']): ListRow => ({
    ...m,
    state,
    branch: currentBranch(path.join(deps.appRoot, m.dir), deps),
  });
  return {
    rows: [
      ...localMembers(deps.appRoot).map((m) => row(m, 'localized')),
      ...parkedMembers(deps.appRoot).map((m) => row(m, 'parked')),
    ],
    drift: driftProblems(deps.appRoot),
  };
}

export function list(opts: {check?: boolean}, deps: Deps): number {
  legacyManifestHint(deps);
  if (opts.check) {
    const drift = driftProblems(deps.appRoot);
    for (const d of drift) deps.warn(`[localize] drift: ${describeDrift(d)}`);
    return drift.length ? EXIT_DRIFT : 0;
  }

  const {rows, drift} = collect(deps);
  if (!rows.length && !drift.length) return 0; // nothing localized, nothing to say

  if (rows.length) {
    const nameW = Math.max(...rows.map((r) => r.name.length)) + 2;
    const dirW = Math.max(...rows.map((r) => r.dir.length)) + 2;
    const branchW = Math.max(...rows.map((r) => r.branch.length)) + 2;
    for (const r of rows) {
      deps.log(
        r.name.padEnd(nameW) +
          r.dir.padEnd(dirW) +
          r.branch.padEnd(branchW) +
          (r.version || '—') +
          (r.state === 'parked' ? '  (parked)' : ''),
      );
    }
  }
  for (const d of drift) deps.log(`drift: ${describeDrift(d)}`);

  const count = (s: ListRow['state']) => rows.filter((r) => r.state === s).length;
  const parts = [`${count('localized')} localized`];
  if (count('parked')) parts.push(`${count('parked')} parked`);
  parts.push(drift.length ? `${drift.length} drift` : 'no drift');
  deps.log(parts.join(' · '));
  return 0;
}
