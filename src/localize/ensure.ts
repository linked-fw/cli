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
 *   as `linked localize --ensure` for an app's npm `pre*` scripts. It plans
 *   the prune (prune.ts `planPrune`) without touching anything -- per-owner
 *   candidates, the same range guard, the same "would its dependencies
 *   resolve elsewhere" check -- and only when that plan removes something does
 *   it prune, and say so in one line on stderr. A copy prune would keep costs
 *   a stat and, at most, one requirement index per `node_modules` (read from
 *   npm's hidden lockfile), so a tree full of kept copies stays cheap. It
 *   never runs npm, prints nothing when there is nothing to do (or no
 *   manifest), skips a checkout recorded with `prune: false`, and never
 *   throws: a run command must not fail over a developer's private checkout
 *   state.
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
  newPruneCache,
  planPrune,
  pruneProvided,
  prunesEntry,
  shouldPrune,
} from './prune.js';
import type {PruneOptions} from './prune.js';
import {defaultDeps} from './run.js';
import type {Deps} from './run.js';
import {reportError} from './localize.js';

/**
 * `npm install --no-save` inside the checkout at `entry.path`, then prune it.
 *
 * `--no-save` keeps the checkout's tracked files out of it: npm installs what
 * the committed lockfile says and writes neither `package.json` nor
 * `package-lock.json` (only the gitignored hidden lockfile). Without it every
 * relink left a lockfile diff in each checkout it reinstalled, written in the
 * dialect of whichever npm was first on PATH -- measured: Node 22's bundled
 * npm 10.9.9 drops every `"libc"` field an npm 12 lockfile records, and any
 * npm syncs a lockfile header the release workflow bumped. Changing a
 * checkout's dependencies is a deliberate `npm install <dep>` inside it.
 *
 * `--include=dev` because this runs from the app's npm lifecycle hooks, and
 * npm exports the outer command's config to them as `npm_config_*`: measured,
 * `npm install --omit=dev` at the app root arrives as `npm_config_omit=dev`,
 * and an inner install that inherits it skips the checkout's
 * devDependencies, so the checkout no longer builds. A checkout is a
 * development copy; it always needs them.
 *
 * The package's name is read from the checkout's own `package.json`; the
 * other localized packages (siblings) from the manifest, so a checkout being
 * localized right now prunes before the manifest records it.
 *
 * @returns 0, or `EXIT_WARNED` when the prune failed (the install stands).
 * @throws {LocalizeError} `EXIT_INSTALL_FAILED` when `npm install` fails.
 */
export function ensure(
  entry: Pick<ManifestEntry, 'path' | 'subdir' | 'prune'>,
  deps: Deps,
  opts: PruneOptions = {},
): number {
  const pkgDir = path.join(deps.appRoot, entry.path);
  deps.log(`[localize] npm install in ${entry.path}`);
  const install = deps.run(
    'npm',
    ['install', '--no-save', '--include=dev', '--no-audit', '--no-fund'],
    {cwd: pkgDir},
  );
  if (install.status !== 0) {
    throw new LocalizeError(
      `npm install failed in ${entry.path}:\n${(install.stderr || install.stdout).trim()}`,
      EXIT_INSTALL_FAILED,
    );
  }
  if (!shouldPrune(opts) || !prunesEntry(entry)) return 0;

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
 * app provides -- exactly what `pruneProvided` would remove, decided first
 * without it, so the common case (nothing to remove, some copies kept) never
 * reaches the prune.
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

    if (!Object.values(entries).some(prunesEntry)) return {pruned: []};

    const cache = newPruneCache();
    const plan = planPrune(entries, {appRoot}, {}, cache);
    if (!plan.remove.length) return {pruned: []};

    // Prune's own report is per checkout and also speaks of what it keeps;
    // here only what went is worth a line, on every run command.
    const quiet = {appRoot, log: () => {}, warn: () => {}};
    const {removed} = pruneProvided(
      entries,
      {},
      quiet,
      {
        owners: [...new Set(plan.remove.map((d) => d.ownerName))],
        deps: [...new Set(plan.remove.map((d) => d.dep))],
      },
      cache,
    );
    const pruned = removed.map((r) => `${r.where}@${r.version}`);
    if (pruned.length) {
      deps.warn(
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
