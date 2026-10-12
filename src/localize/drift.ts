/**
 * Drift -- what npm is silent about once checkouts are workspace members:
 * a second copy of a localized package, a nested copy of a singleton, a
 * declared range a checkout misses, and a checkout npm installed that is gone.
 *
 * The implementation is `hooks/drift.cjs`, the one the lock-at-rest hook
 * requires after every install: plain CommonJS that runs without `lib/`. This
 * module loads it and gives it types, so `--list`, the check before `linked
 * start` and the hook report the same thing by the same rules.
 */
import {requireHook} from './hook-module.js';

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

interface DriftModule {
  driftProblems: (appRoot: string) => Drift[];
  describeDrift: (d: Drift) => string;
  satisfies: (version: string, range: string) => boolean | null;
}

const hook = requireHook<DriftModule>(
  'drift.cjs',
  (mod) =>
    typeof mod.driftProblems === 'function' &&
    typeof mod.describeDrift === 'function' &&
    typeof mod.satisfies === 'function',
);

/** Every drift in the installed tree, in a stable order. No install yet means none. */
export function driftProblems(appRoot: string): Drift[] {
  return hook.driftProblems(appRoot);
}

/** One line, for `--list` and the drift check before `start` and friends. */
export function describeDrift(d: Drift): string {
  return hook.describeDrift(d);
}

/**
 * Does `version` satisfy `range`? `null` means "cannot tell" -- a dist-tag,
 * `file:`, `npm:`, `workspace:`, a git URL, or a version that is not one --
 * and drift then reports nothing: npm links the checkout for such a range
 * anyway. npm's own `semver` decides, so prereleases follow npm's rule:
 * `1.3.0-beta.1` satisfies a range only when one of its comparators names a
 * prerelease on the same `major.minor.patch`.
 */
export function satisfies(version: string, range: string): boolean | null {
  return hook.satisfies(version, range);
}
