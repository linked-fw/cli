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
  SINGLETONS: readonly string[];
  driftProblems: (appRoot: string) => Drift[];
  describeDrift: (d: Drift) => string;
}

const hook = requireHook<DriftModule>(
  'drift.cjs',
  (mod) =>
    typeof mod.driftProblems === 'function' &&
    typeof mod.describeDrift === 'function' &&
    Array.isArray(mod.SINGLETONS),
);

/**
 * One copy each, app-wide, localized or not: they hold registries of classes
 * (or React's context), so a second copy splits the app in two.
 */
export const SINGLETONS: readonly string[] = hook.SINGLETONS;

/** Every drift in the installed tree, in a stable order. No install yet means none. */
export function driftProblems(appRoot: string): Drift[] {
  return hook.driftProblems(appRoot);
}

/** One line, for `--list` and the drift check before `start` and friends. */
export function describeDrift(d: Drift): string {
  return hook.describeDrift(d);
}
