/**
 * THE rule for what an app provides to its localized checkouts -- the one list
 * that pruning (prune.ts), the run-time one-copy check (ensure.ts) and Vite's
 * `resolve.dedupe` (`../localized-dedupe.ts`) all start from.
 *
 * - every localized package the app has installed -- always, whatever a range
 *   says: the live checkout is the point of localizing it, for every importer;
 * - every runtime dependency a localized checkout declares (`dependencies`,
 *   `peerDependencies`, `optionalDependencies` -- what its source imports) that
 *   the app has at a version satisfying EVERY localized checkout's range for
 *   it. A range the app's version does not satisfy (or that cannot be read)
 *   leaves the name out, as `skipped`, with who asks what;
 * - `react` and `react-dom` when the app has them.
 *
 * Scoped to what is localized on purpose: a duplicate comes from a checkout's
 * own `npm install`, so the checkouts' declarations are what can produce one.
 * The server's "installed N times" warning stays as the cross-check for
 * anything this misses (a linked package hoisted into a checkout only
 * transitively).
 *
 * Synchronous and cheap -- the manifest, one `package.json` per localized
 * package and one per dependency it names -- because the run-time check calls
 * it before every `linked start`.
 */
import fs from 'node:fs';
import path from 'node:path';

import {readInstalledPkgSync} from '../installed-packages.js';
import {readManifest} from './manifest.js';
import {readJson} from './fsops.js';
import {satisfies} from './prune.js';

const RUNTIME_FIELDS = [
  'dependencies',
  'peerDependencies',
  'optionalDependencies',
];

/** A dependency the app has, left out because some localized checkout asks a range it misses. */
export interface ProvidedSkip {
  name: string;
  reason: 'range';
  /** The localized checkouts whose range the app's version does not satisfy. */
  asks: {from: string; range: string}[];
  appVersion: string;
}

export interface Provided {
  /** Sorted: the localized packages, the dependencies the app provides, react/react-dom. */
  names: string[];
  skipped: ProvidedSkip[];
  /** The localized packages among `names` (installed at the app root). */
  localized: string[];
  /** The names in `names` that are there as a localized checkout's dependency. */
  dependencies: string[];
}

/**
 * @param appRoot  the app root (where `local-packages.json` and `node_modules` are)
 * @param localizedNames  the localized package names; defaults to the
 *   manifest's. Pruning passes the entries it is working on, so a checkout
 *   being localized right now counts before the manifest records it.
 */
export function providedPackages(
  appRoot: string,
  localizedNames: string[] = manifestNames(appRoot),
): Provided {
  const localized = localizedNames.filter((name) =>
    fs.existsSync(path.join(appRoot, 'node_modules', name, 'package.json')),
  );
  const names = new Set<string>(localized);
  const skipped: ProvidedSkip[] = [];
  const dependencies: string[] = [];

  // name -> every localized checkout's runtime range for it
  const asks = new Map<string, {from: string; range: string}[]>();
  for (const from of localized) {
    const pkg =
      readJson(path.join(appRoot, 'node_modules', from, 'package.json')) ?? {};
    for (const field of RUNTIME_FIELDS) {
      for (const [dep, range] of Object.entries<string>(pkg[field] ?? {})) {
        if (names.has(dep)) continue;
        const list = asks.get(dep) ?? [];
        if (!list.some((a) => a.from === from)) list.push({from, range});
        asks.set(dep, list);
      }
    }
  }

  for (const [name, ranges] of asks) {
    const appVersion = readInstalledPkgSync(name, appRoot)?.json?.version;
    if (!appVersion) continue; // the app does not provide it
    const unmet = ranges.filter((a) => satisfies(appVersion, a.range) !== true);
    if (unmet.length)
      skipped.push({name, reason: 'range', asks: unmet, appVersion});
    else {
      names.add(name);
      dependencies.push(name);
    }
  }

  for (const name of ['react', 'react-dom']) {
    if (readInstalledPkgSync(name, appRoot)) names.add(name);
  }
  return {names: [...names].sort(), skipped, localized, dependencies};
}

function manifestNames(appRoot: string): string[] {
  try {
    return Object.keys(readManifest(appRoot, {warn: () => {}}).entries);
  } catch {
    return [];
  }
}
