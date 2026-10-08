/**
 * One copy, always: every package the app provides loads once, whichever tool
 * runs the code -- Vite, `tsc`, plain Node, `tsx`, a test runner.
 *
 * Two halves:
 *
 * - **`ensure(entry)`** -- the ONLY way a checkout gets installed: `npm
 *   install` inside it, then prune it (prune.ts). localize's install step,
 *   `--relink`'s reinstall and `linked localize --reinstall <pkg>` all go
 *   through it, so the copies an install puts back exist only until it
 *   returns. Hand-running `npm install` in a checkout is what `--reinstall`
 *   replaces.
 * - **`checkOneCopy(appRoot)`** -- the run-time check. Before `linked start`,
 *   `script`, `call` and `build-all` (a commander `preAction` in cli.ts), and
 *   as `linked localize --ensure` for an app's npm `pre*` scripts. Stat-only:
 *   for every recorded checkout and every name the app provides, does
 *   `<checkout>/node_modules/<name>` exist with a real path other than the
 *   app's copy? Only then does it prune -- through prune's guarded path, so a
 *   copy whose ranges the app does not satisfy stays -- and it says what it
 *   removed in one line. It never runs npm, prints nothing when there is
 *   nothing to do (or no manifest), and never throws: a run command must not
 *   fail over a developer's private checkout state.
 */
import fs from 'node:fs';
import path from 'node:path';

import {
  EXIT_INSTALL_FAILED,
  EXIT_REFUSED,
  EXIT_WARNED,
  LocalizeError,
} from './errors.js';
import {manifestPath, readManifest} from './manifest.js';
import type {ManifestEntry} from './manifest.js';
import {readJson} from './fsops.js';
import {
  nodeModulesRoots,
  pruneProvided,
  realOrSelf,
  shouldPrune,
} from './prune.js';
import type {PruneOptions} from './prune.js';
import {providedPackages} from './provided.js';
import {defaultDeps} from './run.js';
import type {Deps} from './run.js';
import {reportError} from './localize.js';

/**
 * `npm install` inside the checkout at `entry.path`, then prune it.
 *
 * The package's name is read from the checkout's own `package.json`; the
 * other localized packages (siblings) from the manifest, so a checkout being
 * localized right now prunes before the manifest records it.
 *
 * @returns 0, or `EXIT_WARNED` when the prune failed (the install stands).
 * @throws {LocalizeError} `EXIT_INSTALL_FAILED` when `npm install` fails.
 */
export function ensure(
  entry: Pick<ManifestEntry, 'path' | 'subdir'>,
  deps: Deps,
  opts: PruneOptions = {},
): number {
  const pkgDir = path.join(deps.appRoot, entry.path);
  deps.log(`[localize] npm install in ${entry.path}`);
  const install = deps.run('npm', ['install', '--no-audit', '--no-fund'], {
    cwd: pkgDir,
  });
  if (install.status !== 0) {
    throw new LocalizeError(
      `npm install failed in ${entry.path}:\n${(install.stderr || install.stdout).trim()}`,
      EXIT_INSTALL_FAILED,
    );
  }
  if (!shouldPrune(opts)) return 0;

  const name = readJson(path.join(pkgDir, 'package.json'))?.name;
  if (typeof name !== 'string') return 0;
  try {
    const entries = {...recordedEntries(deps), [name]: entry as ManifestEntry};
    pruneProvided(entries, opts, deps, {owners: [name]});
    return 0;
  } catch (e) {
    deps.warn(
      `[localize] pruning ${entry.path} failed, its node_modules are as npm left them: ${e.message}`,
    );
    return EXIT_WARNED;
  }
}

/** `linked localize --reinstall <pkg>`: `ensure` for one recorded package. */
export function reinstall(
  name: string,
  opts: PruneOptions,
  deps: Deps,
): number {
  try {
    const entry = readManifest(deps.appRoot, deps).entries[name];
    if (!entry) {
      throw new LocalizeError(
        `${name} is not localized here, so there is no checkout to reinstall. ` +
          '`linked localize --list` shows what is.',
        EXIT_REFUSED,
      );
    }
    if (!fs.existsSync(path.join(deps.appRoot, entry.path, 'package.json'))) {
      throw new LocalizeError(
        `${name} is recorded at ${entry.path}, which has no package.json.`,
        EXIT_REFUSED,
      );
    }
    return ensure(entry, deps, opts);
  } catch (e) {
    return reportError(e, deps);
  }
}

/**
 * The run-time check: remove every recorded checkout's own copy of what the
 * app provides. Stat-only until there is something to remove.
 *
 * @returns what was removed, as `<checkout>/node_modules/<name>@<version>`.
 */
export function checkOneCopy(
  appRoot: string = process.cwd(),
  deps: Pick<Deps, 'log' | 'warn'> = defaultDeps(appRoot),
): {pruned: string[]} {
  try {
    if (!fs.existsSync(manifestPath(appRoot))) return {pruned: []};
    const entries = readManifest(appRoot, {warn: () => {}}).entries;
    const owners = Object.keys(entries);
    if (!owners.length) return {pruned: []};

    // The app's copy of each provided name, by real path.
    const appReal = new Map<string, string>();
    for (const name of providedPackages(appRoot, owners).names) {
      const dir = path.join(appRoot, 'node_modules', name);
      if (fs.existsSync(dir)) appReal.set(name, realOrSelf(dir));
    }

    const hitOwners = new Set<string>();
    const hitNames = new Set<string>();
    for (const [owner, entry] of Object.entries(entries)) {
      const pkgDir = path.join(appRoot, entry.path);
      for (const nm of nodeModulesRoots(pkgDir, entry)) {
        for (const [name, real] of appReal) {
          if (name === owner) continue;
          const copy = path.join(nm, name);
          if (fs.existsSync(copy) && realOrSelf(copy) !== real) {
            hitOwners.add(owner);
            hitNames.add(name);
          }
        }
      }
    }
    if (!hitOwners.size) return {pruned: []};

    // Prune's own report is per checkout and also speaks of what it keeps;
    // here only what went is worth a line, on every run command.
    const quiet = {appRoot, log: () => {}, warn: () => {}};
    const {removed} = pruneProvided(entries, {}, quiet, {
      owners: [...hitOwners],
      deps: [...hitNames],
    });
    const pruned = removed.map(
      (r) => `${r.owner}/node_modules/${r.dep}@${r.version}`,
    );
    if (pruned.length) {
      deps.log(
        `[localize] one copy: removed ${pruned.join(', ')} — the app provides ` +
          `${pruned.length === 1 ? 'it' : 'them'}.`,
      );
    }
    return {pruned};
  } catch (e) {
    deps.warn(
      `[localize] one-copy check failed, nothing more was removed: ${e?.message ?? e}`,
    );
    return {pruned: []};
  }
}

function recordedEntries(deps: Deps): Record<string, ManifestEntry> {
  try {
    return readManifest(deps.appRoot, {warn: () => {}}).entries;
  } catch {
    return {};
  }
}
