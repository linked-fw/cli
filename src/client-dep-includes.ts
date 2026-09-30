// `optimizeDeps.include` entries for the third-party client dependencies of
// linked framework packages.
//
// Apps exclude the framework packages (`@_linked/*`, `lincd-*`, anything marked
// `"linkedPackage": true`) from Vite's dependency optimizer, so the browser
// loads exactly one copy of each. The cost of that exclusion: Vite no longer
// crawls into those packages, so it never learns about THEIR dependencies until
// the browser happens to request one. Two things then go wrong:
//
// - a CommonJS dependency (`use-sync-external-store/shim`, `js-cookie`) is
//   served raw, and the browser fails on `require`/`module.exports`;
// - any other dependency is discovered mid-session, and Vite re-optimises and
//   reloads the page — which can mix old and new chunks into two Reacts.
//
// So apps used to list every such dependency in `optimizeDeps.include` by hand,
// including nested installs (`'@_linked/primitives > vaul'`, where npm put vaul
// under primitives because its React peer range excluded the app's React).
//
// Reading `package.json` dependencies would list server-only packages too
// (bcrypt, express, sharp…), which then fail in esbuild. This module reads the
// import graph instead: which bare specifiers the framework packages' client
// entry files actually import, and which of those can run in a browser.
import fs from 'node:fs/promises';
import path from 'node:path';
import {isBuiltin} from 'node:module';
import {init as initLexer, parse as parseImports} from 'es-module-lexer';
import {isFrameworkPkg, readInstalledPkg} from './installed-packages.js';
import type {Plugin} from 'vite';

export interface SourceWorkspace {
  name: string;
  srcDir: string;
}

export interface ClientDepEntry {
  /** The `optimizeDeps.include` entry: `dep/sub` or `from > dep/sub`. */
  entry: string;
  /** The specifier as the framework package imports it. */
  specifier: string;
  /** The framework package the import was found in. */
  from: string;
  /** Package name of the dependency. */
  depName: string;
  /** Real path of the dependency's package root, as resolved from `from`. */
  depRoot: string;
  /** True when the app root does not resolve `depName` to that same copy. */
  nested: boolean;
}

export type SkipReason =
  'unresolved' | 'server-only' | 'server-code' | 'excluded' | 'denied';

export interface SkippedClientDep {
  specifier: string;
  from: string;
  reason: SkipReason;
}

export interface ClientDepScanOptions {
  /** App root. Default `process.cwd()`. */
  cwd?: string;
  /** Framework packages served from source: their `src/` is scanned instead of `lib/`. */
  sourceWorkspaces?: SourceWorkspace[];
  /** Entries never to add, matched against the entry, the specifier and the package name. */
  deny?: (string | RegExp)[];
  /**
   * JSON file remembering what does not change between runs: the module graphs
   * of installed (non-source) framework packages and the server-only verdicts
   * of dependencies, keyed by real path and version. Omit to scan everything.
   */
  cacheFile?: string;
}

export interface ScannedFrameworkPackage {
  name: string;
  root: string;
  json: any;
  source: boolean;
}

export interface ClientDepScan {
  entries: ClientDepEntry[];
  skipped: SkippedClientDep[];
  frameworkPackages: ScannedFrameworkPackage[];
  /** Excluded names that the app root does not resolve at all. */
  unresolvedExcludes: string[];
  filesScanned: number;
}

/** Conditions a browser build resolves, in the order a client resolver prefers them. */
const CLIENT_CONDITIONS = ['browser', 'import', 'module', 'default'];
/** Conditions never taken for a client file. `development` points at `src/`, scanned separately. */
const NON_CLIENT_CONDITIONS = new Set([
  'require',
  'node',
  'types',
  'typings',
  'development',
  'deno',
  'bun',
  'worker',
  'react-native',
]);
/** Specifiers that are assets, not modules the optimizer can pre-bundle. */
const ASSET_SPECIFIER =
  /\.(css|scss|sass|less|styl|pcss|svg|png|jpe?g|gif|webp|avif|ico|bmp|woff2?|ttf|otf|eot|json|wasm|html?|txt|md|glsl)$/i;
const SOURCE_FILE = /\.(m?[jt]sx?|cjs)$/;
const IGNORED_SOURCE_FILE = /(\.d\.ts|\.(test|spec|stories)\.[mc]?[jt]sx?)$/;
const IGNORED_SOURCE_DIR = new Set([
  'node_modules',
  '__tests__',
  '__mocks__',
  '__fixtures__',
]);
/**
 * Never listed, whoever imports them. `typescript` is a peer of packages that
 * analyse source at build time (translation key sync); it declares a `browser`
 * field, so it passes the server-only test, and pre-bundling it costs seconds.
 */
export const DEFAULT_DENY: (string | RegExp)[] = ['typescript'];
/** A server-only check stops after this many files of one dependency. */
const MAX_DEP_FILES = 400;

/** `@scope/name/sub` → `@scope/name`; `name/sub` → `name`. */
export function packageNameOf(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/** A bare module specifier naming another package (not relative, builtin, virtual, asset or `#import`). */
export function isBarePackageSpecifier(specifier: string): boolean {
  if (!specifier || specifier.startsWith('.') || specifier.startsWith('/'))
    return false;
  if (specifier.startsWith('#') || specifier.startsWith('\0')) return false;
  if (specifier.includes(':') || specifier.includes('?')) return false; // node:, virtual:, http:, ?raw
  if (isBuiltin(specifier)) return false;
  if (ASSET_SPECIFIER.test(specifier)) return false;
  return /^(@[\w.-]+\/)?[\w.-]/.test(specifier);
}

const matchesDeny = (deny: (string | RegExp)[], ...values: string[]): boolean =>
  deny.some((d) =>
    values.some((v) => (typeof d === 'string' ? d === v : d.test(v))),
  );

async function realpath(p: string): Promise<string> {
  try {
    return await fs.realpath(p);
  } catch {
    return path.resolve(p);
  }
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isFile();
  } catch {
    return false;
  }
}

async function listFiles(
  dir: string,
  accept: (file: string) => boolean,
): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string): Promise<void> => {
    let entries;
    try {
      entries = await fs.readdir(d, {withFileTypes: true});
    } catch {
      return;
    }
    await Promise.all(
      entries.map(async (ent) => {
        const full = path.join(d, ent.name);
        if (ent.isDirectory()) {
          if (!IGNORED_SOURCE_DIR.has(ent.name)) await walk(full);
        } else if (accept(full)) {
          out.push(full);
        }
      }),
    );
  };
  await walk(dir);
  return out;
}

/** Pick the target of one export entry for the given conditions (nested condition objects allowed). */
function pickConditional(target: any, conditions: string[]): string | null {
  if (typeof target === 'string') return target;
  if (Array.isArray(target)) {
    for (const t of target) {
      const hit = pickConditional(t, conditions);
      if (hit) return hit;
    }
    return null;
  }
  if (target && typeof target === 'object') {
    for (const [key, value] of Object.entries(target)) {
      if (key === 'default' || conditions.includes(key)) {
        const hit = pickConditional(value, conditions);
        if (hit) return hit;
      }
    }
  }
  return null;
}

/** Normalise `exports` to a subpath map (`{'.': …}`), or null when there is none. */
function exportsMap(exportsField: any): Record<string, any> | null {
  if (exportsField === undefined || exportsField === null) return null;
  if (typeof exportsField === 'string' || Array.isArray(exportsField))
    return {'.': exportsField};
  const keys = Object.keys(exportsField);
  if (keys.length > 0 && keys.every((k) => !k.startsWith('.')))
    return {'.': exportsField};
  return exportsField;
}

/**
 * Resolve a package subpath (`.` or `./shim`) through `exports` for the given
 * conditions, the way Node does (exact key first, then the longest `*` pattern).
 * Returns the relative target, `null` when the subpath is not exported, or
 * `undefined` when the package has no `exports` at all.
 */
export function resolveExportsSubpath(
  json: any,
  subpath: string,
  conditions: string[],
): string | null | undefined {
  const map = exportsMap(json?.exports);
  if (!map) return undefined;
  if (subpath in map) return pickConditional(map[subpath], conditions);
  let best: {key: string; star: string} | null = null;
  for (const key of Object.keys(map)) {
    const star = key.indexOf('*');
    if (star < 0) continue;
    const prefix = key.slice(0, star);
    const suffix = key.slice(star + 1);
    if (
      subpath.startsWith(prefix) &&
      subpath.endsWith(suffix) &&
      subpath.length >= key.length - 1 &&
      (!best || prefix.length > best.key.indexOf('*'))
    ) {
      best = {
        key,
        star: subpath.slice(prefix.length, subpath.length - suffix.length),
      };
    }
  }
  if (!best) return null;
  const target = pickConditional(map[best.key], conditions);
  return target ? target.split('*').join(best.star) : null;
}

/** Probe a file path the way a CommonJS/ESM loader would (extension, then directory index). */
async function probeFile(base: string): Promise<string | null> {
  for (const candidate of [
    base,
    `${base}.js`,
    `${base}.mjs`,
    `${base}.cjs`,
    path.join(base, 'index.js'),
    path.join(base, 'index.mjs'),
  ]) {
    if (await isFile(candidate)) return candidate;
  }
  return null;
}

/** The file a package subpath resolves to for a browser-or-anything lookup; null when none exists. */
export async function resolvePackageFile(
  root: string,
  json: any,
  subpath: string,
  conditions: string[] = [
    'browser',
    'import',
    'module',
    'default',
    'require',
    'node',
  ],
): Promise<string | null> {
  const viaExports = resolveExportsSubpath(json, subpath, conditions);
  if (viaExports !== undefined) {
    return viaExports ? probeFile(path.join(root, viaExports)) : null;
  }
  if (subpath === '.') {
    const browser =
      conditions.includes('browser') &&
      typeof json.browser === 'string' &&
      json.browser;
    const main = browser || json.module || json.main || 'index.js';
    return probeFile(path.join(root, main));
  }
  return probeFile(path.join(root, subpath));
}

/** Every string target under client conditions, anywhere in `exports`. */
function clientExportTargets(json: any): string[] {
  const map = exportsMap(json?.exports);
  if (!map) {
    const main =
      (typeof json?.browser === 'string' && json.browser) ||
      json?.module ||
      json?.main ||
      'index.js';
    return [main];
  }
  const out: string[] = [];
  const visit = (target: any): void => {
    if (typeof target === 'string') out.push(target);
    else if (Array.isArray(target)) target.forEach(visit);
    else if (target && typeof target === 'object') {
      for (const [key, value] of Object.entries(target)) {
        if (!NON_CLIENT_CONDITIONS.has(key)) visit(value);
      }
    }
  };
  Object.values(map).forEach(visit);
  return out;
}

/** Expand one export target (possibly a `*` pattern) to the files it can reach. */
async function expandTarget(root: string, target: string): Promise<string[]> {
  const abs = path.join(root, target);
  const star = abs.indexOf('*');
  if (star < 0) {
    const file = await probeFile(abs);
    return file ? [file] : [];
  }
  const prefix = abs.slice(0, star);
  const suffix = abs.slice(star + 1);
  const dir = prefix.endsWith(path.sep) ? prefix : path.dirname(prefix);
  return listFiles(
    dir,
    (f) => f.startsWith(prefix) && f.endsWith(suffix) && !f.endsWith('.d.ts'),
  );
}

let lexerReady: Promise<void> | null = null;
let esbuildTransform:
  ((code: string, opts: any) => Promise<{code: string}>) | null = null;

/** The static and literal-dynamic import specifiers of a module, plus `require('x')` calls. */
export async function importSpecifiers(
  code: string,
  file: string,
): Promise<string[]> {
  lexerReady ??= initLexer;
  await lexerReady;
  let js = code;
  if (/\.[mc]?tsx?$/.test(file) || /\.jsx$/.test(file)) {
    esbuildTransform ??= (await import('esbuild')).transform as any;
    try {
      js = (
        await esbuildTransform!(code, {
          loader: file.endsWith('x')
            ? /\.tsx$/.test(file)
              ? 'tsx'
              : 'jsx'
            : 'ts',
          format: 'esm',
          jsx: 'automatic',
          tsconfigRaw: {compilerOptions: {experimentalDecorators: true}},
          logLevel: 'silent',
        })
      ).code;
    } catch {
      return [];
    }
  }
  const out = new Set<string>();
  try {
    const [imports] = parseImports(js);
    for (const imp of imports) if (imp.n) out.add(imp.n);
  } catch {
    // Not parseable as a module (JSX in a .js file, say): fall back to the textual forms.
    for (const m of js.matchAll(
      /(?:\bfrom\s*|\bimport\s*\(?\s*)['"]([^'"\n]+)['"]/g,
    ))
      out.add(m[1]);
  }
  for (const m of js.matchAll(/\brequire\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g))
    out.add(m[1]);
  return [...out];
}

interface ScanCacheData {
  version: number;
  graphs: Record<string, Record<string, {bare: string[]; rel: string[]}>>;
  serverOnly: Record<string, boolean>;
}
const CACHE_VERSION = 1;

async function loadCache(
  file: string | undefined,
): Promise<{data: ScanCacheData; dirty: boolean}> {
  const empty = {
    data: {version: CACHE_VERSION, graphs: {}, serverOnly: {}},
    dirty: false,
  };
  if (!file) return empty;
  try {
    const data = JSON.parse(await fs.readFile(file, 'utf8'));
    return data?.version === CACHE_VERSION && data.graphs && data.serverOnly
      ? {data, dirty: false}
      : empty;
  } catch {
    return empty;
  }
}

async function saveCache(
  file: string | undefined,
  cache: {data: ScanCacheData; dirty: boolean},
): Promise<void> {
  if (!file || !cache.dirty) return;
  try {
    await fs.mkdir(path.dirname(file), {recursive: true});
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(cache.data));
    await fs.rename(tmp, file);
  } catch {
    // A cache is an optimisation: an unwritable node_modules just means a full scan next time.
  }
}

/** Limit concurrent file reads: a few hundred open at once can exceed the fd limit. */
function semaphore(limit: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async (fn) => {
    if (active >= limit) await new Promise<void>((r) => waiting.push(r));
    active++;
    try {
      return await fn();
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
}

/** Resolve a relative import to a module file, including the TS-source `./Sibling.js` → `.ts(x)` convention. */
async function resolveRelative(
  importer: string,
  specifier: string,
): Promise<string | null> {
  if (ASSET_SPECIFIER.test(specifier)) return null;
  const base = path.resolve(path.dirname(importer), specifier);
  const candidates: string[] = [];
  if (/\.[mc]?tsx?$/.test(importer) && /\.jsx?$/.test(base)) {
    candidates.push(
      base.replace(/\.jsx?$/, '.ts'),
      base.replace(/\.jsx?$/, '.tsx'),
    );
  }
  candidates.push(base);
  for (const ext of ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx'])
    candidates.push(base + ext);
  for (const ext of ['.js', '.mjs', '.ts', '.tsx'])
    candidates.push(path.join(base, 'index' + ext));
  for (const c of candidates) {
    if (SOURCE_FILE.test(c) && (await isFile(c))) return c;
  }
  return null;
}

export interface ModuleNode {
  file: string;
  /** Bare specifiers the module imports (packages and builtins). */
  bare: string[];
  /** Module files it imports relatively. */
  rel: string[];
}

interface ReadGraphOptions {
  maxFiles?: number;
  /** Also follow a bare import: return the file it resolves to, or null to not follow it. */
  followBare?: (specifier: string, importer: string) => Promise<string | null>;
  /** Stop reading once this returns true for a node. */
  stopWhen?: (node: ModuleNode) => boolean;
}

const readLimit = semaphore(64);

/** Read the module graph reachable from `entries` through relative imports (and `followBare`). */
async function readGraph(
  entries: string[],
  opts: ReadGraphOptions = {},
): Promise<Map<string, ModuleNode>> {
  const nodes = new Map<string, ModuleNode>();
  const maxFiles = opts.maxFiles ?? Infinity;
  let stopped = false;
  const visit = async (file: string): Promise<void> => {
    if (stopped || nodes.has(file) || nodes.size >= maxFiles) return;
    const node: ModuleNode = {file, bare: [], rel: []};
    nodes.set(file, node);
    const specs = await readLimit(async () => {
      try {
        return await importSpecifiers(await fs.readFile(file, 'utf8'), file);
      } catch {
        return [];
      }
    });
    const children: (string | null)[] = await Promise.all(
      specs.map(async (spec) => {
        if (spec.startsWith('.') || spec.startsWith('/')) {
          const resolved = await resolveRelative(file, spec);
          if (resolved) node.rel.push(resolved);
          return resolved;
        }
        node.bare.push(spec);
        return opts.followBare ? opts.followBare(spec, file) : null;
      }),
    );
    if (opts.stopWhen?.(node)) {
      stopped = true;
      return;
    }
    await Promise.all(children.filter((c): c is string => !!c).map(visit));
  };
  await Promise.all(entries.map(visit));
  return nodes;
}

/** True when the package declares a browser entry anywhere (`browser` field or condition). */
function hasBrowserEntry(json: any): boolean {
  if (json?.browser) return true;
  let found = false;
  const visit = (v: any): void => {
    if (found || !v || typeof v !== 'object') return;
    for (const [key, value] of Object.entries(v)) {
      if (key === 'browser') found = true;
      else visit(value);
    }
  };
  visit(json?.exports);
  return found;
}

const isBuiltinSpecifier = (spec: string): boolean =>
  spec.startsWith('node:') || isBuiltin(spec);
const subpathOf = (specifier: string): string => {
  const name = packageNameOf(specifier);
  return specifier === name ? '.' : `.${specifier.slice(name.length)}`;
};
const NODE_CONDITIONS = ['import', 'module', 'default', 'require', 'node'];

type InstalledLookup = (
  name: string,
  fromDir: string,
) => Promise<{root: string; json: any} | null>;

/** `readInstalledPkg`, memoised for one scan. */
function memoInstalled(): InstalledLookup {
  const cache = new Map<string, Promise<{root: string; json: any} | null>>();
  return (name, fromDir) => {
    const key = `${name}\0${fromDir}`;
    if (!cache.has(key)) cache.set(key, readInstalledPkg(name, fromDir));
    return cache.get(key)!;
  };
}

/**
 * Server-only: no browser entry, and the module graph behind the imported
 * subpath — followed through its own dependencies, as long as those have no
 * browser entry either — reaches a Node builtin. Such a package (express,
 * sharp, bcrypt, jsonwebtoken, cookie-parser) serves a framework package's
 * server code; listing it would make esbuild bundle it for the browser.
 */
export async function isServerOnlyDependency(
  root: string,
  json: any,
  subpath: string,
  lookup: InstalledLookup = readInstalledPkg,
): Promise<boolean> {
  if (hasBrowserEntry(json)) return false;
  const entry = await resolvePackageFile(root, json, subpath, NODE_CONDITIONS);
  if (!entry) return false;
  let builtin = false;
  await readGraph([entry], {
    maxFiles: MAX_DEP_FILES,
    followBare: async (spec, importer) => {
      if (!isBarePackageSpecifier(spec)) return null;
      const dep = await lookup(packageNameOf(spec), path.dirname(importer));
      if (!dep || hasBrowserEntry(dep.json)) return null;
      return resolvePackageFile(
        dep.root,
        dep.json,
        subpathOf(spec),
        NODE_CONDITIONS,
      );
    },
    stopWhen: (node) =>
      (builtin = builtin || node.bare.some(isBuiltinSpecifier)),
  });
  return builtin;
}

/** The files a framework package's client code can start from. */
async function clientEntryFiles(
  pkg: ScannedFrameworkPackage,
): Promise<string[]> {
  if (pkg.source) {
    return listFiles(
      path.join(pkg.root, 'src'),
      (f) => SOURCE_FILE.test(f) && !IGNORED_SOURCE_FILE.test(f),
    );
  }
  return (
    await Promise.all(
      clientExportTargets(pkg.json).map((t) => expandTarget(pkg.root, t)),
    )
  ).flat();
}

interface DepVerdict {
  reason?: 'unresolved' | 'server-only';
  depName: string;
  depRoot?: string;
}

/**
 * Scan the framework packages among `excluded` for the third-party
 * dependencies their client code imports, and work out the
 * `optimizeDeps.include` entry for each.
 *
 * Framework packages export whole directories (`"./*": "./lib/esm/*.js"`), so
 * "reachable from the client exports" is every file — server code included. A
 * file is therefore treated as SERVER code when it imports a Node builtin or a
 * server-only dependency, or relatively imports a file that does; only the
 * imports of the remaining files are listed.
 */
export async function scanLinkedClientDeps(
  excluded: string[],
  opts: ClientDepScanOptions = {},
): Promise<ClientDepScan> {
  const cwd = path.resolve(opts.cwd ?? process.cwd());
  const deny = [...DEFAULT_DENY, ...(opts.deny ?? [])];
  const excludedSet = new Set(excluded);
  const sourceByName = new Map(
    (opts.sourceWorkspaces ?? []).map((w) => [w.name, w]),
  );
  const lookup = memoInstalled();
  const cache = await loadCache(opts.cacheFile);
  const unresolvedExcludes: string[] = [];

  // 1. The excluded packages to scan: every source workspace (Vite does not crawl
  //    an excluded package, whatever it is), and the installed framework packages.
  //    A package with a `bin` is a command-line tool (`@_linked/cli`), whose code
  //    no browser loads; scanning it would only list build tooling.
  const frameworkPackages = (
    await Promise.all(
      [...excludedSet].map(
        async (name): Promise<ScannedFrameworkPackage | null> => {
          const ws = sourceByName.get(name);
          if (ws) {
            const root = await realpath(path.dirname(ws.srcDir));
            let json: any = {};
            try {
              json = JSON.parse(
                await fs.readFile(path.join(root, 'package.json'), 'utf8'),
              );
            } catch {}
            return {name, root, json, source: true};
          }
          const installed = await lookup(name, cwd);
          if (!installed) {
            unresolvedExcludes.push(name);
            return null;
          }
          if (!isFrameworkPkg(name) && installed.json.linkedPackage !== true)
            return null;
          return {
            name,
            root: await realpath(installed.root),
            json: installed.json,
            source: false,
          };
        },
      ),
    )
  ).filter((p): p is ScannedFrameworkPackage => !!p && !p.json?.bin);

  // 2. Each package's module graph.
  const owner = new Map<string, ScannedFrameworkPackage>();
  const nodes = new Map<string, ModuleNode>();
  await Promise.all(
    frameworkPackages.map(async (pkg) => {
      const cacheKey = pkg.source ? null : `${pkg.root}\0${pkg.json.version}`;
      let graph: Map<string, ModuleNode>;
      if (cacheKey && cache.data.graphs[cacheKey]) {
        graph = new Map(
          Object.entries(cache.data.graphs[cacheKey]).map(([file, n]) => [
            file,
            {file, ...n},
          ]),
        );
      } else {
        graph = await readGraph(await clientEntryFiles(pkg));
        if (cacheKey) {
          cache.data.graphs[cacheKey] = Object.fromEntries(
            [...graph].map(([file, n]) => [file, {bare: n.bare, rel: n.rel}]),
          );
          cache.dirty = true;
        }
      }
      for (const [file, node] of graph) {
        if (nodes.has(file)) continue;
        nodes.set(file, node);
        owner.set(file, pkg);
      }
    }),
  );

  // 3. A verdict for every (package, dependency specifier) pair.
  const verdicts = new Map<string, Promise<DepVerdict | null>>();
  const serverOnly = new Map<string, Promise<boolean>>();
  const pairKey = (pkg: ScannedFrameworkPackage, spec: string): string =>
    `${pkg.name}\0${spec}`;
  const verdictFor = (
    pkg: ScannedFrameworkPackage,
    spec: string,
  ): Promise<DepVerdict | null> => {
    const key = pairKey(pkg, spec);
    if (!verdicts.has(key)) {
      verdicts.set(
        key,
        (async (): Promise<DepVerdict | null> => {
          if (!isBarePackageSpecifier(spec)) return null;
          const depName = packageNameOf(spec);
          if (depName === pkg.name || isFrameworkPkg(depName)) return null;
          const installed = await lookup(depName, pkg.root);
          if (!installed) return {reason: 'unresolved', depName};
          if (installed.json.linkedPackage === true) return null;
          const depRoot = await realpath(installed.root);
          const cacheKey = `${depRoot}\0${subpathOf(spec)}`;
          if (!serverOnly.has(cacheKey)) {
            const persisted = `${cacheKey}\0${installed.json.version}`;
            serverOnly.set(
              cacheKey,
              persisted in cache.data.serverOnly
                ? Promise.resolve(cache.data.serverOnly[persisted])
                : isServerOnlyDependency(
                    depRoot,
                    installed.json,
                    subpathOf(spec),
                    lookup,
                  ).then((v) => {
                    cache.data.serverOnly[persisted] = v;
                    cache.dirty = true;
                    return v;
                  }),
            );
          }
          return {
            reason: (await serverOnly.get(cacheKey))
              ? 'server-only'
              : undefined,
            depName,
            depRoot,
          };
        })(),
      );
    }
    return verdicts.get(key)!;
  };
  await Promise.all(
    [...nodes.values()].flatMap((n) =>
      n.bare.map((spec) => verdictFor(owner.get(n.file)!, spec)),
    ),
  );

  // 4. Server code: files importing a builtin or a server-only dependency, and
  //    every file that relatively imports one of those.
  const server = new Set<string>();
  const importers = new Map<string, string[]>();
  for (const node of nodes.values()) {
    for (const dep of node.rel) {
      if (!importers.has(dep)) importers.set(dep, []);
      importers.get(dep)!.push(node.file);
    }
  }
  const queue: string[] = [];
  for (const node of nodes.values()) {
    const pkg = owner.get(node.file)!;
    for (const spec of node.bare) {
      if (
        isBuiltinSpecifier(spec) ||
        (await verdicts.get(pairKey(pkg, spec)))?.reason === 'server-only'
      ) {
        server.add(node.file);
        queue.push(node.file);
        break;
      }
    }
  }
  while (queue.length) {
    for (const parent of importers.get(queue.pop()!) ?? []) {
      if (!server.has(parent)) {
        server.add(parent);
        queue.push(parent);
      }
    }
  }

  // 5. Entries from client files; everything else is reported as skipped.
  const rootCopy = new Map<string, Promise<string | null>>();
  const rootResolution = (depName: string): Promise<string | null> => {
    if (!rootCopy.has(depName)) {
      rootCopy.set(
        depName,
        lookup(depName, cwd).then((r) => (r ? realpath(r.root) : null)),
      );
    }
    return rootCopy.get(depName)!;
  };
  const entries = new Map<string, ClientDepEntry>();
  const clientPairs = new Set<string>();
  const skipped = new Map<string, SkippedClientDep>();
  const skip = (specifier: string, from: string, reason: SkipReason): void => {
    skipped.set(`${specifier}\0${from}`, {specifier, from, reason});
  };
  for (const node of nodes.values()) {
    if (server.has(node.file)) continue;
    const pkg = owner.get(node.file)!;
    for (const spec of node.bare) clientPairs.add(pairKey(pkg, spec));
  }
  for (const node of nodes.values()) {
    const pkg = owner.get(node.file)!;
    for (const spec of node.bare) {
      const key = pairKey(pkg, spec);
      const verdict = await verdicts.get(key);
      if (!verdict) continue;
      if (verdict.reason) {
        skip(spec, pkg.name, verdict.reason);
        continue;
      }
      if (!clientPairs.has(key)) {
        if (!skipped.has(`${spec}\0${pkg.name}`))
          skip(spec, pkg.name, 'server-code');
        continue;
      }
      if (excludedSet.has(verdict.depName) || excludedSet.has(spec)) {
        skip(spec, pkg.name, 'excluded');
        continue;
      }
      const nested =
        (await rootResolution(verdict.depName)) !== verdict.depRoot;
      const entry = nested ? `${pkg.name} > ${spec}` : spec;
      if (matchesDeny(deny, entry, spec, verdict.depName)) {
        skip(spec, pkg.name, 'denied');
        continue;
      }
      if (!entries.has(entry)) {
        entries.set(entry, {
          entry,
          specifier: spec,
          from: pkg.name,
          depName: verdict.depName,
          depRoot: verdict.depRoot!,
          nested,
        });
      }
    }
  }
  for (const {specifier, from} of entries.values())
    skipped.delete(`${specifier}\0${from}`);
  await saveCache(opts.cacheFile, cache);

  return {
    entries: [...entries.values()].sort((a, b) =>
      a.entry.localeCompare(b.entry),
    ),
    skipped: [...skipped.values()].sort(
      (a, b) =>
        a.specifier.localeCompare(b.specifier) || a.from.localeCompare(b.from),
    ),
    frameworkPackages,
    unresolvedExcludes,
    filesScanned: nodes.size,
  };
}

/** Just the entries, for `optimizeDeps.include`. */
export async function linkedClientDepIncludes(
  excluded: string[],
  opts: ClientDepScanOptions = {},
): Promise<string[]> {
  return (await scanLinkedClientDeps(excluded, opts)).entries.map(
    (e) => e.entry,
  );
}

export interface RecordedClientDepScan {
  cwd: string;
  scan: ClientDepScan;
  /** The app's own `optimizeDeps.include`, before anything was added. */
  appInclude: string[];
  exclude: string[];
}

/**
 * The most recent scan the plugin ran in this process, with the app's own
 * include list — `linked doctor` loads the app's config and reads this, so it
 * checks exactly what the dev server would use.
 */
export const lastClientDepScan: {current: RecordedClientDepScan | null} = ((
  globalThis as any
)[Symbol.for('@_linked/cli.lastClientDepScan')] ??= {current: null});

export interface ClientDepIncludesPluginOptions {
  /** Framework packages served from source (the discovered workspaces). */
  sourceWorkspaces?: SourceWorkspace[];
  /** Entries never to add. See `ClientDepScanOptions.deny`. */
  deny?: (string | RegExp)[];
  /** Override the scan cache location; `false` disables the cache. */
  cacheFile?: string | false;
}

/** Where the scan cache lives: beside Vite's own cache, inside the app's node_modules. */
export const defaultClientDepCacheFile = (cwd: string): string =>
  path.join(cwd, 'node_modules', '.cache', 'linked', 'client-deps.json');

const debugEnabled = (): boolean =>
  /(^|[\s,])(linked(:[\w*]+)?|\*)($|[\s,])/.test(process.env.DEBUG ?? '');

/**
 * Adds the scan's entries to `optimizeDeps.include` in dev.
 *
 * It is a `config` hook ordered `post` rather than a value computed inside
 * `createViteConfig`, because the exclude list it reads is only final once the
 * app has merged its own config on top — an app that excludes every installed
 * `@_linked/*` package does that in its own `vite.config.ts`. Vite concatenates
 * the returned array onto the app's own `include`, which is never replaced.
 */
export function linkedClientDepIncludesPlugin(
  opts: ClientDepIncludesPluginOptions = {},
): Plugin[] {
  // What the app itself lists, before other plugins add theirs
  // (@vitejs/plugin-react adds `react`, `react/jsx-runtime`…): `linked doctor`
  // must not tell anyone to delete an entry they never wrote.
  let appInclude: string[] = [];
  const snapshot: Plugin = {
    name: 'linked:client-dep-includes:app-include',
    apply: 'serve',
    config: {
      order: 'pre',
      handler(userConfig) {
        appInclude = [...(userConfig.optimizeDeps?.include ?? [])];
      },
    },
  };
  return [
    snapshot,
    {
      name: 'linked:client-dep-includes',
      apply: 'serve',
      config: {
        order: 'post',
        async handler(userConfig) {
          const optimizeDeps = userConfig.optimizeDeps ?? {};
          // `linked start --api-only` has no browser client to optimise for.
          if (optimizeDeps.noDiscovery) return;
          const cwd = path.resolve(userConfig.root ?? process.cwd());
          const started = performance.now();
          const scan = await scanLinkedClientDeps(optimizeDeps.exclude ?? [], {
            cwd,
            sourceWorkspaces: opts.sourceWorkspaces,
            deny: opts.deny,
            cacheFile:
              opts.cacheFile === false
                ? undefined
                : (opts.cacheFile ?? defaultClientDepCacheFile(cwd)),
          });
          const existing = new Set(optimizeDeps.include ?? []);
          const added = scan.entries
            .map((e) => e.entry)
            .filter((e) => !existing.has(e));
          lastClientDepScan.current = {
            cwd,
            scan,
            appInclude,
            exclude: optimizeDeps.exclude ?? [],
          };
          if (debugEnabled()) {
            console.log(
              `[linked] optimizeDeps.include: ${added.length} entries for linked packages' client dependencies ` +
                `(${Math.round(performance.now() - started)}ms, ${scan.filesScanned} files)` +
                added.map((e) => `\n  ${e}`).join(''),
            );
          }
          return added.length ? {optimizeDeps: {include: added}} : undefined;
        },
      },
    },
  ];
}
