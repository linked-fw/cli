/**
 * Pruning -- stop a checkout's own `node_modules` holding a second copy of
 * something the app already provides. On by default after every install in a
 * checkout and on every `--relink`; `--no-prune` (`{prune: false}`) skips it.
 *
 * `shouldPrune(opts)` is the one place that default lives.
 *
 * Why it is needed. `npm install` inside a checkout (localize.ts, step 3)
 * installs what the CHECKOUT's lockfile says: its own copy of every
 * dependency, often older than the app's. Node resolves a module from the
 * importer's REAL path and takes the first `node_modules` it meets going up,
 * so a localized `A` that imports `B` gets `A/node_modules/B` -- a registry
 * copy -- and never the localized `B`; and a framework package that holds a
 * registry of classes (or React) loads once per copy. Measured with three
 * localized `@_linked/*` packages: plain Node and `tsx` loaded three copies of
 * the same core.
 *
 * What it does. For every localized checkout, each package at the top of its
 * `node_modules` that is a CANDIDATE (below) is removed when the app provides
 * it -- `<appRoot>/node_modules/<name>` exists -- at a version that satisfies
 * every range that resolves to that copy: the checkout's own declaration and
 * that of every installed package that would load it. Node's upward search
 * then finds the app's copy instead. Nothing else in the checkout moves.
 *
 * The candidates are `providedPackages` (provided.ts) -- the one rule the
 * run-time check and Vite's dedupe use too -- over the entries being pruned:
 *
 * - a **localized sibling** -- always counts as provided, whatever the range,
 *   because the live checkout is the point of localizing it. A range it does
 *   not satisfy is said out loud, never acted on;
 * - a **runtime dependency** (`dependencies`, `peerDependencies`,
 *   `optionalDependencies`) of any localized checkout that the app has at a
 *   version satisfying every localized checkout's range for it;
 * - `react` and `react-dom`.
 *
 * Nothing else is touched -- a devDependency the app happens to have too
 * stays, so the checkout's tooling does not come to depend on the app's. A
 * runtime dependency the rule leaves out because a localized range misses the
 * app's version is kept and said out loud, like any other copy kept below.
 *
 * Never removed, candidate or not:
 *
 * - a copy whose ranges the app's version does not satisfy -- kept, with a
 *   warning naming the package, the range and the app's version;
 * - anything in a checkout that is not under the app root, because then the
 *   upward search never reaches the app's `node_modules` and the removed
 *   package would simply be missing.
 *
 * A package with a `bin` is NOT exempt. Measured in a checkout under an app
 * root with its own `@_linked/cli` removed: `npx linked build`,
 * `npm exec linked -- --help`, a script running `npm exec linked` and a script
 * running a bare `linked` all resolved `linked` to the app root's copy,
 * because npm puts every ancestor's `node_modules/.bin` on the PATH. The
 * removed package's links in the checkout's `node_modules/.bin` are removed
 * with it, so nothing dangles.
 *
 * It never runs npm and never touches the checkout's `package.json` or
 * `package-lock.json`. `npm install` in the checkout puts the copies back;
 * `ensure` (ensure.ts) is the install-then-prune step every in-checkout
 * install goes through, and the run-time check (`checkOneCopy`) takes them out
 * again before `linked start` and friends.
 */
import fs from 'node:fs';
import path from 'node:path';

import {isInside, isSymlink, readJson} from './fsops.js';
import semver from 'semver';
import {providedPackages} from './provided.js';
import type {ProvidedSkip} from './provided.js';

import type {ManifestEntry} from './manifest.js';
import type {Deps} from './run.js';

/** What pruning reads from a command's options. */
export interface PruneOptions {
  /** On unless explicitly false. */
  prune?: boolean;
}

/** Limit a prune to some checkouts and/or some dependency names. */
export interface PruneScope {
  /** Only these localized packages' checkouts. */
  owners?: string[];
  /** Only these dependency names. */
  deps?: string[];
}

/** What pruning may remove: the rule's names plus every localized sibling, and what the rule skipped. */
export interface Candidates {
  names: Set<string>;
  skipped: Map<string, ProvidedSkip>;
}

/** The candidates for `entries`, by `providedPackages` (provided.ts). */
export function candidatesFor(
  entries: Record<string, ManifestEntry>,
  deps: Pick<Deps, 'appRoot'>,
): Candidates {
  const rule = providedPackages(deps.appRoot, Object.keys(entries));
  return {
    names: new Set([...rule.names, ...Object.keys(entries)]),
    skipped: new Map(rule.skipped.map((s) => [s.name, s])),
  };
}

/**
 * Does the app's installed `version` satisfy `range`? `null` means "cannot
 * tell" -- a dist-tag, `file:`, `npm:`, `workspace:`, a git URL, or a version
 * that is not one -- and every caller then keeps the copy. The failure mode is
 * therefore always the safe one: a copy kept that could have gone, never a
 * copy removed that was needed.
 *
 * npm's own `semver` decides, so prereleases follow npm's rule: `1.3.0-beta.1`
 * satisfies a range only when one of its comparators names a prerelease on
 * the same `major.minor.patch`.
 */
export function satisfies(version: string, range: string): boolean | null {
  if (typeof version !== 'string' || typeof range !== 'string') return null;
  if (semver.valid(version) === null) return null;
  if (semver.validRange(range) === null) return null;
  return semver.satisfies(version, range);
}

/** Pruning is on unless a caller says `{prune: false}`. */
export function shouldPrune(opts: PruneOptions = {}): boolean {
  return opts.prune !== false;
}

const REQUIRE_FIELDS = [
  'dependencies',
  'peerDependencies',
  'optionalDependencies',
];
const DECLARE_FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
];

/**
 * @param entries  the localized packages: every one counts as a sibling
 * @param opts  unused beyond `prune`, which callers check with `shouldPrune`
 * @param deps  `{appRoot, log, warn}`
 * @param scope  prune only some checkouts / names (the run-time check)
 */
export function pruneProvided(
  entries: Record<string, ManifestEntry>,
  opts: PruneOptions,
  deps: Pick<Deps, 'appRoot' | 'log' | 'warn'>,
  scope: PruneScope = {},
): {removed: any[]; kept: any[]} {
  const removed: any[] = [];
  const kept: any[] = [];
  const appRoot = realOrSelf(deps.appRoot);
  const candidates = candidatesFor(entries, deps);
  const only = scope.deps ? new Set(scope.deps) : null;

  for (const [name, entry] of Object.entries(entries)) {
    if (scope.owners && !scope.owners.includes(name)) continue;
    const pkgDir = path.join(deps.appRoot, entry.path);
    if (!fs.existsSync(path.join(pkgDir, 'package.json'))) continue;
    if (!isInside(realOrSelf(pkgDir), appRoot)) {
      deps.log(
        `[localize] ${name}: ${entry.path} is outside the app root, so Node cannot reach the app's ` +
          `node_modules from it — its own dependencies are left as they are.`,
      );
      continue;
    }
    const ctx = {
      name,
      entry,
      pkgDir,
      pkg: readJson(path.join(pkgDir, 'package.json')) ?? {},
      entries,
      candidates,
      only,
      deps,
    };
    for (const nm of nodeModulesRoots(pkgDir, entry)) {
      const result = pruneOne(nm, ctx);
      removed.push(...result.removed);
      kept.push(...result.kept);
    }
  }

  report(removed, kept, deps);
  return {removed, kept};
}

/**
 * Is `dep` -- declared by a checkout at `range` -- something the app provides,
 * so that its absence from the checkout's own `node_modules` is not a
 * dependency gone missing? `--relink` asks this before reinstalling a
 * checkout, so a copy pruned on purpose does not trigger a reinstall on every
 * postinstall.
 */
export function isProvidedByApp(
  dep: string,
  range: string | undefined,
  entries: Record<string, ManifestEntry>,
  candidates: Candidates,
  deps: Pick<Deps, 'appRoot'>,
): boolean {
  const app = appCopy(dep, deps);
  if (!app) return false;
  if (entries[dep]) return true;
  if (!candidates.names.has(dep)) return false;
  return range === undefined || satisfies(app.version, range) === true;
}

function pruneOne(nm, ctx) {
  const removed = [];
  const kept = [];
  const {name: owner, entry, pkg, entries, candidates, only, deps} = ctx;

  for (const dep of topLevelPackages(nm)) {
    if (dep === owner) continue;
    if (only && !only.has(dep)) continue;
    const skip = candidates.skipped.get(dep);
    if (!candidates.names.has(dep) && !skip) continue;
    const dir = path.join(nm, dep);
    const nested = readJson(path.join(dir, 'package.json'));
    if (!nested) continue;
    const app = appCopy(dep, deps);
    if (!app) continue; // the app does not provide it, so this copy is the only one
    if (realOrSelf(dir) === app.real) continue; // already the app's copy

    const where = path.relative(deps.appRoot, dir);
    if (!candidates.names.has(dep)) {
      // The rule leaves it out: a localized checkout asks a range the app
      // misses. Said for a checkout that declares it; a copy it only has
      // transitively is none of its business.
      if (declared(pkg, DECLARE_FIELDS, dep) === undefined) continue;
      kept.push({
        where,
        dep,
        version: nested.version,
        app: app.version,
        unmet: skip!.asks,
        owner: entry.path,
      });
      continue;
    }
    const sibling = Boolean(entries[dep]);
    const ranges = rangesResolvingTo(nm, dep, pkg, owner);

    if (!sibling) {
      const unmet = ranges.filter(
        (r) => satisfies(app.version, r.range) !== true,
      );
      if (unmet.length) {
        kept.push({
          where,
          dep,
          version: nested.version,
          app: app.version,
          unmet,
          owner: entry.path,
        });
        continue;
      }
    }

    fs.rmSync(dir, {recursive: true, force: true});
    removeEmptyScope(nm, dep);
    removeBinLinksInto(nm, dir);
    removed.push({
      owner: entry.path,
      dep,
      version: nested.version,
      app: app.version,
      sibling,
      drift: sibling
        ? ranges.filter((r) => satisfies(app.version, r.range) === false)
        : [],
    });
  }
  return {removed, kept};
}

function report(removed, kept, deps) {
  const byOwner = new Map();
  for (const r of removed)
    byOwner.set(r.owner, [...(byOwner.get(r.owner) ?? []), r]);
  for (const [owner, list] of byOwner) {
    deps.log(
      `[localize] ${owner}: removed its own copies of what the app provides — ` +
        list
          .map(
            (r) =>
              `${r.dep}@${r.version} (app: ${r.sibling ? `localized, ${r.app}` : r.app})`,
          )
          .join(', '),
    );
    for (const r of list) {
      for (const d of r.drift) {
        deps.warn(
          `[localize] ${owner}: ${d.from} asks ${r.dep}@${d.range}; the localized checkout is ${r.app}. ` +
            `It is used anyway — that is what localizing it means — but the range is now fiction.`,
        );
      }
    }
  }
  for (const k of kept) {
    deps.warn(
      `[localize] kept ${k.where}@${k.version}: ` +
        k.unmet.map((u) => `${u.from} asks ${k.dep}@${u.range}`).join(', ') +
        `, and the app has ${k.dep}@${k.app}${
          k.unmet.some((u) => satisfies(k.app, u.range) === null)
            ? ' (or the range is one localize cannot read)'
            : ''
        }. ` +
        `${k.owner} loads its own copy, so the app loads two. Align the ranges, or update the app's ${k.dep}.`,
    );
  }
}

/**
 * Every range that resolves to `<nm>/<dep>`: the checkout's own declaration,
 * plus each installed package under `nm` that requires `dep` and has no copy
 * of its own between itself and `nm`.
 */
function rangesResolvingTo(nm, dep, checkoutPkg, owner) {
  const out = [];
  const own = declared(checkoutPkg, DECLARE_FIELDS, dep);
  if (own !== undefined) out.push({from: owner, range: own});

  const walk = (dir, chain) => {
    for (const name of topLevelPackages(dir)) {
      const pkgDir = path.join(dir, name);
      if (isSymlink(pkgDir)) continue; // resolves from its real path, which is not here
      const pkg = readJson(path.join(pkgDir, 'package.json'));
      const range =
        pkg && name !== dep ? declared(pkg, REQUIRE_FIELDS, dep) : undefined;
      const inner = path.join(pkgDir, 'node_modules');
      const shadowed = [...chain, inner].some((d) =>
        fs.existsSync(path.join(d, dep)),
      );
      if (range !== undefined && !shadowed)
        out.push({from: `${name}@${pkg.version}`, range});
      if (fs.existsSync(inner)) walk(inner, [...chain, inner]);
    }
  };
  walk(nm, []);
  return out;
}

function declared(pkg, fields, dep) {
  for (const f of fields) if (pkg[f]?.[dep] !== undefined) return pkg[f][dep];
  return undefined;
}

/** The app's own copy of `dep`: `<appRoot>/node_modules/<dep>`, followed through a link. */
function appCopy(dep, deps) {
  const dir = path.join(deps.appRoot, 'node_modules', dep);
  const pkg = readJson(path.join(dir, 'package.json'));
  if (!pkg?.version) return null;
  return {version: pkg.version, real: realOrSelf(dir)};
}

/** The package dir's `node_modules`, and the clone root's when the package is a monorepo subdir. */
export function nodeModulesRoots(pkgDir, entry) {
  const roots = [path.join(pkgDir, 'node_modules')];
  if (entry.subdir) {
    const rel = path.normalize(entry.subdir);
    if (pkgDir.endsWith(path.sep + rel))
      roots.push(path.join(pkgDir.slice(0, -(rel.length + 1)), 'node_modules'));
  }
  return roots.filter((d) => fs.existsSync(d));
}

/** Package names directly under a `node_modules`, scoped ones as `@scope/name`. */
function topLevelPackages(nm) {
  const out = [];
  let items;
  try {
    items = fs.readdirSync(nm, {withFileTypes: true});
  } catch {
    return out;
  }
  for (const item of items) {
    if (item.name.startsWith('.')) continue;
    if (item.name.startsWith('@')) {
      let inner = [];
      try {
        inner = fs.readdirSync(path.join(nm, item.name));
      } catch {
        /* not a directory */
      }
      for (const sub of inner)
        if (!sub.startsWith('.')) out.push(`${item.name}/${sub}`);
    } else {
      out.push(item.name);
    }
  }
  return out;
}

/** Links in `<nm>/.bin` that pointed into a package just removed: dangling now. */
function removeBinLinksInto(nm, removedDir) {
  const bin = path.join(nm, '.bin');
  let names;
  try {
    names = fs.readdirSync(bin);
  } catch {
    return;
  }
  for (const name of names) {
    const link = path.join(bin, name);
    if (!isSymlink(link)) continue;
    const target = path.resolve(bin, fs.readlinkSync(link));
    if (isInside(target, removedDir)) fs.unlinkSync(link);
  }
}

function removeEmptyScope(nm, dep) {
  if (!dep.startsWith('@')) return;
  const scope = path.join(nm, dep.split('/')[0]);
  try {
    if (!fs.readdirSync(scope).length) fs.rmdirSync(scope);
  } catch {
    /* already gone */
  }
}

export function realOrSelf(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}
