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
 * `node_modules` that is a CANDIDATE in that checkout (below) is removed when
 * the app provides it -- `<appRoot>/node_modules/<name>` exists -- at a
 * version that satisfies every range that resolves to that copy: the
 * checkout's own declaration and that of every installed package that would
 * load it. Node's upward search then finds the app's copy instead. Nothing
 * else in the checkout moves.
 *
 * The candidates start from `providedPackages` (provided.ts) -- the one rule
 * the run-time check and Vite's dedupe use too -- and are taken PER CHECKOUT:
 *
 * - a **localized sibling** -- always counts as provided, whatever the range,
 *   because the live checkout is the point of localizing it. A range it does
 *   not satisfy is said out loud, never acted on;
 * - one of **this checkout's own runtime dependencies** (`dependencies`,
 *   `peerDependencies`, `optionalDependencies`) that the rule provides -- the
 *   app has it at a version satisfying every localized checkout's range;
 * - `react` and `react-dom`.
 *
 * Nothing else is touched -- this checkout's devDependency stays even when
 * another checkout depends on the same package at runtime, so the checkout's
 * tooling does not come to depend on the app's. A runtime dependency the rule
 * leaves out because a localized range misses the app's version is kept and
 * reported, like any other copy kept below.
 *
 * Never removed, candidate or not:
 *
 * - a copy whose ranges the app's version does not satisfy;
 * - a copy whose own dependencies would resolve to something else from the
 *   app's copy than they do from the checkout (`contextChange` below): the
 *   checkout keeps its own copies of whatever failed the guard, and removing
 *   the copy would mix the two -- measured as a checkout's `tsc` seeing two
 *   React type sets;
 * - anything in a checkout that is not under the app root, because then the
 *   upward search never reaches the app's `node_modules` and the removed
 *   package would simply be missing;
 * - anything in a checkout recorded with `prune: false` (localized with
 *   `--no-prune`).
 *
 * Kept copies are reported once per checkout, as a summary; `--list` gives
 * each one's reason. A removal can make another copy removable, so a prune
 * repeats until a pass removes nothing.
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
  /** Only these dependency names (the first pass; later passes take every candidate of `owners`). */
  deps?: string[];
}

/** The rule's names (every localized sibling among them) and what the rule skipped. */
export interface Candidates {
  names: Set<string>;
  skipped: Map<string, ProvidedSkip>;
}

/** The rule (`providedPackages`, provided.ts) over `entries`, plus every entry (sibling). */
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

/** Is pruning on for this recorded checkout? `--no-prune` at localize/adopt records `prune: false`. */
export function prunesEntry(entry: Pick<ManifestEntry, 'prune'>): boolean {
  return entry.prune !== false;
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
/** Candidates in every checkout, declared or not: a second React breaks hooks whoever loads it. */
const ALWAYS_CANDIDATES = new Set(['react', 'react-dom']);
/** prune repeats until a pass removes nothing, at most this many passes. */
export const MAX_PRUNE_PASSES = 5;

/** A range that resolves to a copy: who asks, and what. */
interface Ask {
  from: string;
  range: string;
}

/** One copy in a checkout's `node_modules`, and what pruning decides about it. */
export interface PruneDecision {
  /** The localized package whose checkout holds the copy. */
  ownerName: string;
  /** Its checkout, relative to the app root. */
  owner: string;
  dep: string;
  /** `<nm>/<dep>`, absolute. */
  dir: string;
  /** `dir` relative to the app root. */
  where: string;
  nm: string;
  version: string;
  /** The app's version. */
  app: string;
  sibling: boolean;
  action: 'remove' | 'keep';
  /**
   * Why a copy stays: `range` -- a range that loads it is one the app's
   * version misses (or one that cannot be read); `context` -- removing it
   * would change what its own dependencies resolve to.
   */
  reason?: 'range' | 'context';
  /** The ranges the app's version does not satisfy (`range`), or a sibling's drift (`remove`). */
  unmet: Ask[];
  /** `context`: the dependency that would resolve elsewhere, and both versions. */
  context?: {dep: string; here: string; app: string | null};
}

/** What a plan found, without touching anything. */
export interface PrunePlan {
  remove: PruneDecision[];
  keep: PruneDecision[];
  /** Checkouts left alone because they are not under the app root. */
  outside: {name: string; path: string}[];
}

/**
 * Per-call caches: a requirement index per `node_modules` (built once, see
 * `RequirementIndex`) and the package.json files read along the way.
 */
export interface PruneCache {
  indexes: Map<string, RequirementIndex>;
  /** How many indexes were built -- each is one read of a whole tree. */
  builds: number;
}

export function newPruneCache(): PruneCache {
  return {indexes: new Map(), builds: 0};
}

/**
 * Decide, for every recorded checkout and every candidate copy in its
 * `node_modules`, whether pruning removes it -- without removing anything.
 * `pruneProvided` applies it; the run-time check (`checkOneCopy`) and
 * `--list` call it on its own, which is why it has to be cheap: a copy whose
 * checkout's own range rules it out is decided from that `package.json`
 * alone, and every other range comes from one requirement index per
 * `node_modules`, built at most once per call.
 *
 * Candidates are PER OWNER: a copy is a candidate in checkout O when the rule
 * provides it AND it is a localized sibling, `react`/`react-dom`, or one of
 * O's own runtime dependencies (`dependencies`, `peerDependencies`,
 * `optionalDependencies`). O's devDependencies are O's tooling, whatever
 * another checkout declares at runtime.
 */
export function planPrune(
  entries: Record<string, ManifestEntry>,
  deps: Pick<Deps, 'appRoot'>,
  scope: PruneScope = {},
  cache: PruneCache = newPruneCache(),
  candidates: Candidates = candidatesFor(entries, deps),
): PrunePlan {
  const plan: PrunePlan = {remove: [], keep: [], outside: []};
  const appRoot = realOrSelf(deps.appRoot);
  const only = scope.deps ? new Set(scope.deps) : null;

  for (const [name, entry] of Object.entries(entries)) {
    if (scope.owners && !scope.owners.includes(name)) continue;
    if (!prunesEntry(entry)) continue;
    const pkgDir = path.join(deps.appRoot, entry.path);
    if (!fs.existsSync(path.join(pkgDir, 'package.json'))) continue;
    if (!isInside(realOrSelf(pkgDir), appRoot)) {
      plan.outside.push({name, path: entry.path});
      continue;
    }
    const pkg = readJson(path.join(pkgDir, 'package.json')) ?? {};
    const runtime = new Set(
      REQUIRE_FIELDS.flatMap((f) => Object.keys(pkg[f] ?? {})),
    );
    // The names that can be a decision here, looked up directly rather than
    // by listing node_modules (thousands of entries per checkout): this
    // checkout's candidates, and what the rule skipped that it declares.
    const names = new Set<string>();
    for (const n of candidates.names) {
      if (entries[n] || ALWAYS_CANDIDATES.has(n) || runtime.has(n))
        names.add(n);
    }
    for (const n of candidates.skipped.keys()) {
      if (declared(pkg, DECLARE_FIELDS, n) !== undefined) names.add(n);
    }
    names.delete(name);
    const ctx = {name, entry, pkg, names, entries, candidates, only, deps};
    for (const nm of nodeModulesRoots(pkgDir, entry)) {
      for (const d of decideIn(nm, ctx, cache)) {
        (d.action === 'remove' ? plan.remove : plan.keep).push(d);
      }
    }
  }
  return plan;
}

/**
 * @param entries  the localized packages: every one counts as a sibling
 * @param opts  unused beyond `prune`, which callers check with `shouldPrune`
 * @param deps  `{appRoot, log, warn}`
 * @param scope  prune only some checkouts / names (the run-time check)
 *
 * A removal can make another copy removable -- the copy that went was the one
 * asking a range the app misses, or the one a sibling copy's dependency
 * resolved to -- so it plans and removes again until a pass removes nothing
 * (at most `MAX_PRUNE_PASSES`): one call converges. A checkout recorded with
 * `prune: false` is never touched.
 */
export function pruneProvided(
  entries: Record<string, ManifestEntry>,
  opts: PruneOptions,
  deps: Pick<Deps, 'appRoot' | 'log' | 'warn'>,
  scope: PruneScope = {},
  cache: PruneCache = newPruneCache(),
): {removed: PruneDecision[]; kept: PruneDecision[]} {
  const removed: PruneDecision[] = [];
  let kept: PruneDecision[] = [];
  const candidates = candidatesFor(entries, deps);

  for (let pass = 0; pass < MAX_PRUNE_PASSES; pass++) {
    const passScope = pass === 0 ? scope : {owners: scope.owners};
    const plan = planPrune(entries, deps, passScope, cache, candidates);
    if (pass === 0) {
      for (const o of plan.outside) {
        deps.log(
          `[localize] ${o.name}: ${o.path} is outside the app root, so Node cannot reach the app's ` +
            `node_modules from it — its own dependencies are left as they are.`,
        );
      }
    }
    for (const d of plan.remove) {
      fs.rmSync(d.dir, {recursive: true, force: true});
      removeEmptyScope(d.nm, d.dep);
      removeBinLinksInto(d.nm, d.dir);
      removed.push(d);
    }
    kept = plan.keep;
    if (!plan.remove.length) break;
  }

  report(removed, kept, deps);
  return {removed, kept};
}

/**
 * Is `dep` -- declared by a checkout at `range` -- something the app provides,
 * so that its absence from the checkout's own `node_modules` is not a
 * dependency gone missing? `--relink` asks this before reinstalling a
 * checkout, so a copy pruned on purpose does not trigger a reinstall on every
 * postinstall. `pkg` is the checkout's `package.json`: only what would be a
 * candidate in THAT checkout counts.
 */
export function isProvidedByApp(
  dep: string,
  range: string | undefined,
  entries: Record<string, ManifestEntry>,
  candidates: Candidates,
  deps: Pick<Deps, 'appRoot'>,
  pkg?: any,
): boolean {
  const app = appCopy(dep, deps);
  if (!app) return false;
  if (entries[dep]) return true;
  if (!candidates.names.has(dep)) return false;
  if (
    pkg &&
    !ALWAYS_CANDIDATES.has(dep) &&
    declared(pkg, REQUIRE_FIELDS, dep) === undefined
  )
    return false;
  return range === undefined || satisfies(app.version, range) === true;
}

function decideIn(nm: string, ctx, cache: PruneCache): PruneDecision[] {
  const out: PruneDecision[] = [];
  const {name: owner, entry, pkg, names, entries, candidates, only, deps} = ctx;

  for (const dep of [...names].sort()) {
    if (only && !only.has(dep)) continue;
    const skip = candidates.skipped.get(dep);
    const inRule = candidates.names.has(dep);
    const sibling = Boolean(entries[dep]);
    const dir = path.join(nm, dep);
    const nested = readJson(path.join(dir, 'package.json'));
    if (!nested) continue;
    const app = appCopy(dep, deps);
    if (!app) continue; // the app does not provide it, so this copy is the only one
    if (realOrSelf(dir) === app.real) continue; // already the app's copy

    const base = {
      ownerName: owner,
      owner: entry.path,
      dep,
      dir,
      where: path.relative(deps.appRoot, dir),
      nm,
      version: nested.version,
      app: app.version,
      sibling,
    };

    if (!inRule) {
      // The rule leaves it out: a localized checkout asks a range the app
      // misses. Said for a checkout that declares it; a copy it only has
      // transitively is none of its business.
      if (declared(pkg, DECLARE_FIELDS, dep) === undefined) continue;
      out.push({...base, action: 'keep', reason: 'range', unmet: skip!.asks});
      continue;
    }

    const own = declared(pkg, DECLARE_FIELDS, dep);
    const ownAsk = own === undefined ? [] : [{from: owner, range: own}];
    if (sibling) {
      // Always removed: the live checkout is the point of localizing it. A
      // range it misses is drift, said out loud and never acted on.
      const ranges = [...ownAsk, ...requirementIndex(nm, cache).asks(dep)];
      out.push({
        ...base,
        action: 'remove',
        unmet: ranges.filter((r) => satisfies(app.version, r.range) === false),
      });
      continue;
    }

    // The checkout's own range first: when it rules the copy out, no index is needed.
    if (own !== undefined && satisfies(app.version, own) !== true) {
      out.push({...base, action: 'keep', reason: 'range', unmet: ownAsk});
      continue;
    }
    const unmet = requirementIndex(nm, cache)
      .asks(dep)
      .filter((r) => satisfies(app.version, r.range) !== true);
    if (unmet.length) {
      out.push({...base, action: 'keep', reason: 'range', unmet});
      continue;
    }
    const context = contextChange(dir, app.real, nested);
    if (context) {
      out.push({
        ...base,
        action: 'keep',
        reason: 'context',
        unmet: [],
        context,
      });
      continue;
    }
    out.push({...base, action: 'remove', unmet: []});
  }
  return out;
}

/**
 * Would removing the copy at `copyDir` change what ITS OWN dependencies
 * resolve to? Removing it hands its importers the app's copy, which resolves
 * its dependencies from the app root -- while the checkout keeps its own copy
 * of everything that failed the guard. Measured: a checkout kept its
 * `react`/`@types/react` 18 (its range), lost `prism-react-renderer` (in
 * range), and the app's copy of that resolved `react` -- and with it the
 * types -- to the app's 19: the checkout's own `tsc` saw both React type sets
 * and failed. So the copy stays when any of its `dependencies`,
 * `peerDependencies` or `optionalDependencies` (and the `@types/` package
 * TypeScript would take for it) resolves, from the copy's place in the
 * checkout, to a different package than from the app's copy: a different real
 * path that is not the same `name@version`, or nothing at all from the app's.
 * The same version at another path is the same code, so it does not count; a
 * dependency the checkout cannot resolve either is no change.
 */
function contextChange(
  copyDir: string,
  appReal: string,
  pkg: any,
): PruneDecision['context'] | undefined {
  const names = new Set<string>();
  for (const f of REQUIRE_FIELDS) {
    for (const d of Object.keys(pkg[f] ?? {})) {
      names.add(d);
      names.add(typesPackageFor(d));
    }
  }
  for (const d of names) {
    const here = resolveFrom(copyDir, d);
    if (!here) continue;
    const there = resolveFrom(appReal, d);
    if (!there) return {dep: d, here: here.version, app: null};
    if (here.real !== there.real && here.version !== there.version)
      return {dep: d, here: here.version, app: there.version};
  }
  return undefined;
}

/** `react` → `@types/react`; `@scope/name` → `@types/scope__name`; an `@types/` name is itself. */
function typesPackageFor(name: string): string {
  if (name.startsWith('@types/')) return name;
  return `@types/${name.startsWith('@') ? name.slice(1).replace('/', '__') : name}`;
}

/** Node's upward search for `name` from the directory `from`: the first `node_modules/<name>`. */
function resolveFrom(
  from: string,
  name: string,
): {real: string; version: string} | null {
  for (let dir = from; ;) {
    if (path.basename(dir) !== 'node_modules') {
      const candidate = path.join(dir, 'node_modules', name);
      const pkg = readJson(path.join(candidate, 'package.json'));
      if (pkg)
        return {real: realOrSelf(candidate), version: String(pkg.version)};
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Every range that would load a copy at the top of one `node_modules`: the
 * requirements (`dependencies`, `peerDependencies`, `optionalDependencies`) of
 * every installed package under it, read ONCE per `node_modules`, then asked
 * per name. A package counts for `<nm>/<dep>` when nothing between it and
 * `nm` holds its own `dep` -- Node would load the top-level copy.
 *
 * Read from npm's hidden lockfile (`node_modules/.package-lock.json`, which
 * npm rewrites on every install in that tree) when there is one: measured
 * over 21 checkouts, parsing all of them took ~45 ms where walking the same
 * 16,800 package.json files took 0.8 s warm and 3.4 s cold. Without one (a
 * tree npm did not write) the tree is walked, once. Either way a requirer is
 * checked against the disk when asked about -- what an earlier prune removed
 * asks nothing, and a copy is shadowed only by a directory that exists.
 */
export interface RequirementIndex {
  asks(dep: string): Ask[];
}

/** An installed package under a `node_modules`, located only when asked about. */
interface Installed {
  name: string;
  version: string;
  /** Its path below `nm`, `/`-separated: `a/node_modules/@s/b`. */
  rel: string;
  located?: {dir: string; between: string[]};
}

interface Requirer {
  installed: Installed;
  range: string;
}

/** The package's directory, and the `node_modules` directories between `nm` and it (its own included). */
function locate(nm: string, i: Installed): {dir: string; between: string[]} {
  if (!i.located) {
    const segs = i.rel.split('/');
    const dir = path.join(nm, ...segs);
    const between = [path.join(dir, 'node_modules')];
    for (let k = 0; k < segs.length; k++) {
      if (segs[k] === 'node_modules')
        between.push(path.join(nm, ...segs.slice(0, k + 1)));
    }
    i.located = {dir, between};
  }
  return i.located;
}

function requirementIndex(nm: string, cache: PruneCache): RequirementIndex {
  let index = cache.indexes.get(nm);
  if (!index) {
    cache.builds++;
    const byDep = fromHiddenLockfile(nm) ?? fromWalk(nm);
    index = {
      asks(dep) {
        const out: Ask[] = [];
        for (const {installed, range} of byDep.get(dep) ?? []) {
          if (installed.name === dep) continue;
          const {dir, between} = locate(nm, installed);
          if (!fs.existsSync(path.join(dir, 'package.json'))) continue;
          if (between.some((d) => fs.existsSync(path.join(d, dep)))) continue;
          out.push({from: `${installed.name}@${installed.version}`, range});
        }
        return out;
      },
    };
    cache.indexes.set(nm, index);
  }
  return index;
}

/** Record what the package at `rel` (below `nm`) requires. */
function addRequirer(
  byDep: Map<string, Requirer[]>,
  rel: string,
  pkg: any,
): void {
  const at = rel.lastIndexOf('/node_modules/');
  const installed: Installed = {
    name: at === -1 ? rel : rel.slice(at + '/node_modules/'.length),
    version: pkg.version,
    rel,
  };
  const seen = new Set<string>();
  for (const f of REQUIRE_FIELDS) {
    for (const [dep, range] of Object.entries<any>(pkg[f] ?? {})) {
      if (typeof range !== 'string' || seen.has(dep)) continue;
      seen.add(dep);
      let list = byDep.get(dep);
      if (!list) byDep.set(dep, (list = []));
      list.push({installed, range});
    }
  }
}

const NODE_MODULES_PREFIX = 'node_modules/';

function fromHiddenLockfile(nm: string): Map<string, Requirer[]> | null {
  const lock = readJson(path.join(nm, '.package-lock.json'));
  if (!lock?.packages || typeof lock.packages !== 'object') return null;
  const byDep = new Map<string, Requirer[]>();
  for (const [key, meta] of Object.entries<any>(lock.packages)) {
    if (!key.startsWith(NODE_MODULES_PREFIX) || !meta || meta.link) continue;
    addRequirer(byDep, key.slice(NODE_MODULES_PREFIX.length), meta);
  }
  return byDep;
}

function fromWalk(nm: string): Map<string, Requirer[]> {
  const byDep = new Map<string, Requirer[]>();
  const walk = (dir: string, prefix: string) => {
    for (const name of topLevelPackages(dir)) {
      const pkgDir = path.join(dir, name);
      if (isSymlink(pkgDir)) continue; // resolves from its real path, which is not here
      const rel = prefix + name;
      const pkg = readJson(path.join(pkgDir, 'package.json'));
      if (pkg) addRequirer(byDep, rel, pkg);
      const inner = path.join(pkgDir, 'node_modules');
      if (fs.existsSync(inner)) walk(inner, `${rel}/node_modules/`);
    }
  };
  walk(nm, '');
  return byDep;
}

function report(removed: PruneDecision[], kept: PruneDecision[], deps) {
  const byOwner = new Map<string, PruneDecision[]>();
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
      for (const d of r.unmet) {
        deps.warn(
          `[localize] ${owner}: ${d.from} asks ${r.dep}@${d.range}; the localized checkout is ${r.app}. ` +
            `It is used anyway — that is what localizing it means — but the range is now fiction.`,
        );
      }
    }
  }
  const keptBy = new Map<string, PruneDecision[]>();
  for (const k of kept)
    keptBy.set(k.owner, [...(keptBy.get(k.owner) ?? []), k]);
  for (const [owner, list] of keptBy) {
    const one = list.length === 1;
    deps.warn(
      `[localize] ${owner}: kept ${list.length} own ${one ? 'copy' : 'copies'} the app's cannot ` +
        `replace: ${summarizeKept(list)} — so the app loads ${one ? 'it' : 'them'} twice. ` +
        `\`linked localize --list\` says why.`,
    );
  }
}

const SUMMARY_LIMIT = 8;

/** `react@18.3.1 (app 19.2.0), prism-react-renderer@2.4.1 (its react would change), … and 4 more` */
export function summarizeKept(list: PruneDecision[]): string {
  const shown = list.slice(0, SUMMARY_LIMIT).map(keptShort);
  const more = list.length - shown.length;
  return shown.join(', ') + (more > 0 ? `, … and ${more} more` : '');
}

function keptShort(k: PruneDecision): string {
  return k.reason === 'context'
    ? `${k.dep}@${k.version} (its ${k.context!.dep} would change)`
    : `${k.dep}@${k.version} (app ${k.app})`;
}

/** The full reason a copy stays, for `--list`. */
export function explainKept(k: PruneDecision): string {
  if (k.reason === 'context') {
    const c = k.context!;
    return (
      `${k.where}@${k.version}: from the checkout its ${c.dep} is ${c.here}, from the app's copy ` +
      `${c.app === null ? 'nothing' : c.app} — removing it would change what it loads`
    );
  }
  return (
    `${k.where}@${k.version}: ` +
    k.unmet.map((u) => `${u.from} asks ${k.dep}@${u.range}`).join(', ') +
    `, and the app has ${k.dep}@${k.app}` +
    (k.unmet.some((u) => satisfies(k.app, u.range) === null)
      ? ' (or the range is one localize cannot read)'
      : '')
  );
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
