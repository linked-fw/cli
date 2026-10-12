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
import fs from 'node:fs';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

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

/**
 * `hooks/drift.cjs` in this package: two levels up from `src/localize/`,
 * three from `lib/esm/localize/`, so it is looked for upwards.
 */
function hookFile(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = path.join(dir, 'hooks', 'drift.cjs');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir)
      throw new Error(
        `[localize] hooks/drift.cjs not found above ${fileURLToPath(import.meta.url)}`,
      );
    dir = parent;
  }
}

function load(): DriftModule {
  const file = hookFile();
  const mod: DriftModule = createRequire(import.meta.url)(file);
  if (
    typeof mod?.driftProblems !== 'function' ||
    typeof mod.describeDrift !== 'function' ||
    !Array.isArray(mod.SINGLETONS)
  )
    throw new Error(`[localize] ${file} does not export the drift check`);
  return mod;
}

const hook = load();

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
