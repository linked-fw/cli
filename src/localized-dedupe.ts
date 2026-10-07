/**
 * What Vite's `resolve.dedupe` lists: the packages a LOCALIZED checkout could
 * otherwise load a second copy of.
 *
 * The duplicates come from localization, not from being a linked package. A
 * localized checkout (`linked localize`) is a git clone under the app root with
 * its own `npm install`, so its `node_modules` holds its own copy of what it
 * depends on — often older than the app's, and a registry copy of any sibling
 * that is localized too. Vite serves the checkout's source and resolves its
 * imports from there, so without a dedupe the dev server loads those copies next
 * to the app's (measured: three `@_linked/core` in one SSR process).
 *
 * So the list is:
 *
 * - every localized package — always, whatever a range says: the live checkout
 *   is the point of localizing it, for every importer;
 * - every runtime dependency a localized checkout declares (`dependencies`,
 *   `peerDependencies`, `optionalDependencies` — what its source imports) that
 *   the app has at a version satisfying EVERY localized checkout's range for it;
 * - `react` and `react-dom` when the app has them.
 *
 * A dedupe resolves the name from the app root for EVERY importer and checks no
 * version — measured: a checkout asking `motion@^13` got the app's 12.43.0. Two
 * cases are therefore left out:
 *
 * - a range the app's version does not satisfy: the checkout keeps its own copy
 *   (reported, see `describeSkipped`);
 * - a name some registry install in the app nests its own copy of. npm only
 *   nests when the hoisted copy does not satisfy that package, so deduping the
 *   name would hand it the wrong version.
 *
 * Plain Node, `tsx` and test runners never read this list; for them
 * `linked localize` removes the checkout's copies from disk instead.
 */
import fs from 'node:fs';
import path from 'node:path';
import semver from 'semver';
import {readInstalledPkg} from './installed-packages.js';
import {localizedPackageNames} from './lifecycle.js';

const RUNTIME_FIELDS = [
  'dependencies',
  'peerDependencies',
  'optionalDependencies',
];

export interface SkippedDedupe {
  name: string;
  reason: 'range' | 'nested';
  /** For `range`: who asks what, and what the app has. */
  asks?: {from: string; range: string}[];
  appVersion?: string;
  /** For `nested`: one registry install that carries its own copy. */
  nestedAt?: string;
}

export interface LocalizedDedupe {
  names: string[];
  skipped: SkippedDedupe[];
}

export async function localizedDedupe(
  appRoot: string = process.cwd(),
): Promise<LocalizedDedupe> {
  const localized = localizedPackageNames(appRoot).filter((name) =>
    fs.existsSync(path.join(appRoot, 'node_modules', name, 'package.json')),
  );
  const names = new Set<string>(localized);
  const skipped: SkippedDedupe[] = [];

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

  const nested = asks.size
    ? nestedCopies(path.join(appRoot, 'node_modules'))
    : new Map();
  for (const [name, ranges] of asks) {
    const app = await readInstalledPkg(name, appRoot);
    if (!app?.json?.version) continue; // nothing at the root to dedupe to
    const appVersion = app.json.version;
    const unmet = ranges.filter((a) => !satisfies(appVersion, a.range));
    if (unmet.length) {
      skipped.push({name, reason: 'range', asks: unmet, appVersion});
    } else if (nested.has(name)) {
      skipped.push({name, reason: 'nested', nestedAt: nested.get(name)});
    } else {
      names.add(name);
    }
  }

  for (const name of ['react', 'react-dom']) {
    if (await readInstalledPkg(name, appRoot)) names.add(name);
  }
  return {names: [...names].sort(), skipped};
}

/** One line for the dev log about the ranges the app does not satisfy; null when there are none. */
export function describeSkipped(skipped: SkippedDedupe[]): string | null {
  const range = skipped.filter((s) => s.reason === 'range');
  if (!range.length) return null;
  return (
    `[linked] dedupe: ${range.length} package${range.length === 1 ? '' : 's'} a localized checkout ` +
    `keeps its own copy of, because the app's version is outside its range: ` +
    range
      .map(
        (s) =>
          `${s.name} (${s.asks!.map((a) => `${a.from} asks ${a.range}`).join(', ')}; app ${s.appVersion})`,
      )
      .join(', ')
  );
}

function satisfies(version: string, range: string): boolean {
  try {
    return (
      semver.validRange(range) !== null && semver.satisfies(version, range)
    );
  } catch {
    return false;
  }
}

/**
 * Every package name nested below the top level of `nm` — a registry install's
 * private copy — mapped to one place it sits. Symlinks (localized checkouts,
 * workspaces) are not followed: their trees are not the app's install.
 */
function nestedCopies(nm: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string, depth: number) => {
    for (const name of packageNames(dir)) {
      const pkgDir = path.join(dir, name);
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(pkgDir);
      } catch {
        continue;
      }
      if (stat.isSymbolicLink()) continue;
      if (depth > 0 && !out.has(name))
        out.set(name, path.relative(path.dirname(nm), pkgDir));
      walk(path.join(pkgDir, 'node_modules'), depth + 1);
    }
  };
  walk(nm, 0);
  return out;
}

function packageNames(nm: string): string[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(nm);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    if (entry.startsWith('.')) continue;
    if (entry.startsWith('@')) {
      try {
        for (const sub of fs.readdirSync(path.join(nm, entry)))
          out.push(`${entry}/${sub}`);
      } catch {
        /* not a directory */
      }
    } else {
      out.push(entry);
    }
  }
  return out;
}

function readJson(file: string): any {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}
