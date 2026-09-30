// Vite config helper for linked apps. The one dev + build pipeline.
//
// Apps use this from their own vite.config.ts:
//
//   import {createViteConfig} from '@_linked/cli/vite';
//   export default createViteConfig({port: 4040, cssMode: 'tailwind'});
//
// The helper preserves the dev-mode `generateScopedName` (readable
// `_packageName_filename_className`) so CSS module class names match
// what the previous bundler chain produced for trace/debug. Production
// uses Vite's default scoping (content-hash, equivalent uniqueness).
import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
import fsExtra from 'fs-extra';
import path from 'node:path';
import {generateScopedName} from './utils.js';
import {parseWorkspacePatterns, isWorkspacePathNegated} from './workspace-globs.js';
import {pinCompiledClassNames} from './plugins/pin-compiled-class-names.js';
import {isFrameworkPkg, readInstalledPkg} from './installed-packages.js';
import {linkedClientDepIncludesPlugin} from './client-dep-includes.js';
import type {Plugin, UserConfig} from 'vite';

/** Default dev server port, and Vite's default HMR websocket port. */
const DEFAULT_DEV_PORT = 4040;
const DEFAULT_HMR_PORT = 24678;
/** Vite may not bind below 1024 without privileges; 65535 is the TCP ceiling. */
const MIN_HMR_PORT = 1024;
const MAX_HMR_PORT = 65535;

/**
 * Derive an app's HMR websocket port from its dev port.
 *
 * Every `createViteConfig` app used to fall back to Vite's shared default
 * 24678, so any two dev servers running at once collided ("Port 24678 is
 * already in use") and HMR silently broke for the loser. Offsetting the HMR
 * port by the same amount the dev port is offset from its default keeps the
 * derivation trivial and means apps that already run on distinct dev ports get
 * distinct HMR ports for free.
 *
 * The input is untrusted (`process.env.PORT` is an arbitrary string), so
 * anything that is not a whole port number — `PORT=abc` yielding `NaN`, a
 * negative or out-of-range value — falls back to the dev port default. The
 * result is then clamped into the bindable range, since a far-out dev port
 * would otherwise derive an HMR port past 65535.
 */
/**
 * Which manual chunk a module belongs in.
 *
 * Split large/common deps so route chunks don't all carry their own copy AND
 * the main entry doesn't end up at 5MB+. Each chunk becomes its own
 * `assets/<name>-<hash>.js` the browser caches independently — incremental
 * dev builds and cache wins on prod deploys both improve.
 *
 * Exported so the grouping can be asserted directly: getting it wrong does not
 * fail the build, it produces a bundle that throws on load in the browser.
 */
export const chunkForModuleId = (id: string): string | undefined => {
  if (!id.includes('node_modules')) {
    // Linked workspaces ship as @_linked/* / lincd-* — group all
    // linked-framework code into a single chunk.
    if (
      id.includes('/packages/core/') ||
      id.includes('/packages/react/') ||
      id.includes('/packages/server-utils/') ||
      id.includes('/packages/primitives/') ||
      id.includes('/packages/css/') ||
      /\/packages\/(auth|org|schema|fuseki|owl|xsd|dcat|dcmi|s3|sentry|ui)\//.test(id)
    ) {
      return 'linked';
    }
    return undefined;
  }
  // Framework code installed from the registry rather than resolved to a
  // workspace. An app can hold both at once — a published `@_linked/server`
  // in node_modules next to workspace `@_linked/core` — and the two import
  // each other. Split across `linked` and `vendor` that is a cycle, and
  // Rollup's chosen order left a binding in its temporal dead zone:
  // `Cannot access 'Wo' before initialization` before the app rendered.
  // Same chunk, no cycle.
  if (/[\\/]node_modules[\\/](@_linked[\\/]|lincd-)/.test(id)) {
    return 'linked';
  }
  // React + React-DOM in their own chunk — every route uses them.
  //
  // react-router and @remix-run/router belong here too. Left in `vendor` they
  // made the two chunks import each other: react-router-dom re-exports
  // react-router, so react-vendor imported vendor, while vendor's own
  // top-level `React.createContext(...)` calls imported react-vendor. Rollup
  // has to pick an order for a cycle, and it ran vendor first — every
  // production build died on load with "Cannot read properties of undefined
  // (reading 'createContext')".
  if (
    /[\\/]node_modules[\\/](react|react-dom|react-router-dom|react-router|@remix-run[\\/]router|scheduler)[\\/]/.test(
      id
    )
  ) {
    return 'react-vendor';
  }
  // Heavy editor deps — only loaded on pages that need them, but worth
  // isolating so they don't get pulled into main.
  if (/[\\/]node_modules[\\/]@monaco-editor[\\/]/.test(id)) {
    return 'monaco';
  }
  // Charting/visualization
  if (/[\\/]node_modules[\\/](recharts|react-flow|@xyflow|d3-)[\\/]/.test(id)) {
    return 'viz';
  }
  // Animation
  if (/[\\/]node_modules[\\/]framer-motion[\\/]/.test(id)) {
    return 'motion';
  }
  // Catch-all for other node_modules in a vendor chunk
  return 'vendor';
};

export function hmrPortFor(devPort: unknown): number {
  const parsed = Number(devPort);
  const validDevPort =
    Number.isFinite(parsed) && Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535
      ? parsed
      : DEFAULT_DEV_PORT;
  const derived = DEFAULT_HMR_PORT + (validDevPort - DEFAULT_DEV_PORT);
  return Math.min(MAX_HMR_PORT, Math.max(MIN_HMR_PORT, derived));
}

/** How far past the derived port `resolveHmrPort` looks for a free one. */
const HMR_PORT_SEARCH_RANGE = 100;

/**
 * Whether `port` can be listened on the way Vite's HMR websocket server
 * listens: every interface, since `createViteConfig` sets no `hmr.host`.
 */
export function isPortFree(port: number, host?: string): Promise<boolean> {
  return import('node:net').then(
    (net) =>
      new Promise<boolean>((resolve) => {
        const probe = net.createServer();
        probe.unref();
        probe.once('error', () => resolve(false));
        probe.listen({port, host, exclusive: true}, () => probe.close(() => resolve(true)));
      }),
  );
}

/**
 * Ports this process already chose, by derived port. Vite re-evaluates the
 * config when it restarts the server (a vite.config edit), and it does so while
 * the old server still holds the port — probing again would see our own socket
 * and move to the next port on every restart.
 */
const chosenHmrPorts: Map<number, number> = ((globalThis as any)[Symbol.for('@_linked/cli.hmrPorts')] ??=
  new Map<number, number>());

export interface ResolveHmrPortOptions {
  /** The dev port the HMR port is derived from (`process.env.PORT ?? opts.port`). */
  devPort: unknown;
  env?: NodeJS.ProcessEnv;
  isFree?: (port: number) => Promise<boolean>;
  log?: (message: string) => void;
}

/**
 * The HMR websocket port for this dev server.
 *
 * `LINKED_HMR_PORT` wins outright. Otherwise the port derived from the dev port
 * (`hmrPortFor`) is used if it is free, and the next free port above it if it
 * is not: the derivation keeps apps on distinct dev ports apart, but not an app
 * from an unrelated process (or a second checkout of the same app) that already
 * holds the derived port. Vite injects the configured `hmr.port` into the
 * client it serves, so the browser connects to whichever port was chosen.
 *
 * If nothing in range is free the derived port is returned and Vite reports the
 * conflict, as it did before.
 */
export async function resolveHmrPort({
  devPort,
  env = process.env,
  isFree = isPortFree,
  log = (m) => console.log(m),
}: ResolveHmrPortOptions): Promise<number> {
  const override = env.LINKED_HMR_PORT;
  if (override !== undefined && override.trim() !== '') {
    const port = Number(override);
    if (Number.isInteger(port) && port >= 1 && port <= MAX_HMR_PORT) return port;
    log(`[linked] ignoring LINKED_HMR_PORT=${override}: not a port number`);
  }
  const derived = hmrPortFor(devPort);
  const remembered = chosenHmrPorts.get(derived);
  if (remembered !== undefined) return remembered;
  for (let port = derived; port <= Math.min(MAX_HMR_PORT, derived + HMR_PORT_SEARCH_RANGE); port++) {
    if (await isFree(port)) {
      chosenHmrPorts.set(derived, port);
      if (port !== derived) {
        log(`[linked] HMR port ${derived} is in use; using ${port} (set LINKED_HMR_PORT to choose one)`);
      }
      return port;
    }
  }
  return derived;
}

export interface LinkedViteConfigOptions {
  /** Dev server port. Default 4040. */
  port?: number;
  /** Output dir for `vite build`. Default `public/bundles`. */
  outDir?: string;
  /** CSS pipeline mode. */
  cssMode?: 'tailwind' | 'css-modules-only';
  /** Entry file for the client bundle. Default `src/index.tsx`. */
  entry?: string;
  /** Extra Vite plugins. */
  plugins?: Plugin[];
  /** Extra PostCSS plugins (e.g. `postcss-media-to-container`). */
  postcssPlugins?: unknown[];
  /**
   * Extra `define` entries for the CLIENT environment only (used to bridge
   * `process.env.X` refs into the browser). Never applied server-side.
   */
  define?: Record<string, string>;
  /**
   * Extra workspace globs (trailing `/*`, or a direct package dir) resolved
   * RELATIVE TO the app's cwd, in ADDITION to the app's own `workspaces` field.
   *
   * For apps whose linked-package sources live OUTSIDE their own workspace tree
   * — e.g. an app consumes `packages/lincd.org/modules/*`, which sit one level
   * up (`../lincd.org/modules/*`) when the app runs inside the CN monorepo, and under
   * `packages/lincd.org/modules/*` when the app runs from its own root. Pass BOTH
   * candidate layouts; only globs whose parent dir actually exists are scanned,
   * so the same config works in either checkout. Each glob's packages are
   * registered as source workspaces (resolved to `src/` for HMR + single-instance),
   * exactly like the app's own `workspaces` field.
   */
  workspaceGlobs?: string[];
  /**
   * Add the third-party client dependencies of the excluded framework packages
   * to `optimizeDeps.include` in dev (see ./client-dep-includes.ts). Default on;
   * `false` (or `LINKED_CLIENT_DEP_INCLUDES=0`) turns it off, and `deny` keeps
   * entries out — matched against the entry (`'@_linked/primitives > vaul'`),
   * the specifier (`'vaul'`) or the package name. Run with `DEBUG=linked` to see
   * what was added.
   */
  clientDepIncludes?: boolean | {deny?: (string | RegExp)[]};
}

interface WorkspaceEntry {
  name: string;
  srcDir: string;
}

/**
 * Names of installed packages that depend, directly or transitively (via
 * `dependencies` / `peerDependencies`), on a discovered source workspace. Such a
 * package must also go through Vite SSR: if Node loaded it natively, it would
 * import its own Node-loaded copy of the workspace (e.g. published
 * `@_linked/fuseki` importing a workspace `@_linked/core`), splitting module
 * state. Vite rewrites the dynamic `import()` in code it transforms, so bundling
 * the dependents keeps one instance.
 *
 * Only the dependency closure of the app's `package.json` (dependencies +
 * devDependencies) and of the workspaces themselves is scanned. Packages are
 * resolved Node-style, keyed by real path, and unresolvable ones are ignored.
 * Workspace names are not included in the result.
 */
export async function workspaceDependents(
  workspaces: {name: string; srcDir?: string}[],
  cwd: string = process.cwd(),
): Promise<string[]> {
  if (workspaces.length === 0) return [];
  const fs = await import('node:fs/promises');
  const wsNames = new Set(workspaces.map((w) => w.name));
  // realRoot -> {name, deps (realRoots)}
  const nodes = new Map<string, {name: string; deps: Set<string>}>();
  const realpath = async (p: string): Promise<string> => {
    try {
      return await fs.realpath(p);
    } catch {
      return path.resolve(p);
    }
  };

  const visit = async (root: string, json: any): Promise<string> => {
    const real = await realpath(root);
    if (nodes.has(real)) return real;
    const node = {name: json.name as string, deps: new Set<string>()};
    nodes.set(real, node);
    const names = new Set([
      ...Object.keys(json.dependencies ?? {}),
      ...Object.keys(json.peerDependencies ?? {}),
    ]);
    for (const dep of names) {
      const resolved = await readInstalledPkg(dep, real);
      if (resolved) node.deps.add(await visit(resolved.root, resolved.json));
    }
    return real;
  };

  // Seed: the app's direct deps, plus each workspace package's own deps.
  try {
    const appPkg = await fsExtra.readJson(path.join(cwd, 'package.json'));
    for (const dep of Object.keys({...appPkg.dependencies, ...appPkg.devDependencies})) {
      const resolved = await readInstalledPkg(dep, cwd);
      if (resolved) await visit(resolved.root, resolved.json);
    }
  } catch {}
  for (const ws of workspaces) {
    if (!ws.srcDir) continue;
    const root = path.dirname(ws.srcDir);
    try {
      await visit(root, await fsExtra.readJson(path.join(root, 'package.json')));
    } catch {}
  }

  // Walk reverse edges from every workspace node: everything reached depends on one.
  const dependentsOf = new Map<string, string[]>();
  for (const [key, node] of nodes) {
    for (const dep of node.deps) {
      if (!dependentsOf.has(dep)) dependentsOf.set(dep, []);
      dependentsOf.get(dep)!.push(key);
    }
  }
  const queue = [...nodes].filter(([, n]) => wsNames.has(n.name)).map(([k]) => k);
  const marked = new Set(queue);
  while (queue.length) {
    for (const parent of dependentsOf.get(queue.pop()!) ?? []) {
      if (!marked.has(parent)) {
        marked.add(parent);
        queue.push(parent);
      }
    }
  }
  const out = new Set<string>();
  for (const key of marked) {
    const name = nodes.get(key)!.name;
    if (name && !wsNames.has(name)) out.add(name);
  }
  return [...out].sort();
}

/**
 * Read a package root as a SOURCE install: `{name, srcDir}` iff it has a
 * package.json with a name and ships a `src/` dir. Published packages have only
 * `lib/` and are skipped — they resolve via their exports.
 */
async function readSourcePackage(root: string): Promise<WorkspaceEntry | null> {
  const pkgPath = path.join(root, 'package.json');
  if (!(await fsExtra.pathExists(pkgPath))) return null;
  const srcDir = path.join(root, 'src');
  if (!(await fsExtra.pathExists(srcDir))) return null;
  try {
    const json = await fsExtra.readJson(pkgPath);
    return json.name ? {name: json.name, srcDir} : null;
  } catch {
    return null;
  }
}

/**
 * Linked packages installed as SOURCE, found by walking the app's
 * `dependencies` + `devDependencies` (and recursing through the `dependencies`
 * of each linked package found), keeping those marked `"linkedPackage": true`
 * — the same marker the CLI keys on (see cli-methods.ts) — and registering the
 * ones that ship `src/`.
 *
 * A dep ships `src/` when it is a symlinked workspace clone, a `link:`/`portal:`
 * dev install, or a LOCALIZED checkout (`packages-local/<pkg>`, in no workspace
 * glob). That's what lets a STANDALONE app (not itself a workspace root — e.g. a
 * per-branch clone under /apps) resolve a linked package's `.tsx` sources with
 * extension probing, instead of falling through to the package's
 * `development → ./src/*.ts` export (which misses `.tsx` like LinkedServer). A
 * prod/ejected app installs PUBLISHED packages (no `src/`) → not registered,
 * resolved via each package's `lib`.
 *
 * The marker — NOT the npm scope — drives discovery, so a user's own
 * custom-scope published linked package (e.g. `@acme/foo` with
 * `linkedPackage:true`) is picked up too, and linked packages present in
 * node_modules but not depended upon are ignored.
 *
 * Every root is REALPATHED before it is registered: `readInstalledPkg` returns
 * the `node_modules/<name>` symlink spelling, and Vite's resolver realpaths
 * every id it produces, so registering the symlink would give one file two
 * module ids — two instances of the same module.
 *
 * Shared by the Vite resolver table (`discoverWorkspaces`) and the `linked start`
 * HMR watch set, so the two cannot disagree about what is source.
 */
export async function discoverLinkedSourceDependencies(
  cwd: string = process.cwd(),
): Promise<WorkspaceEntry[]> {
  const pkgPath = path.join(cwd, 'package.json');
  if (!(await fsExtra.pathExists(pkgPath))) return [];
  const fs = await import('node:fs/promises');
  const out: WorkspaceEntry[] = [];
  const seen = new Set<string>();
  const visited = new Set<string>();
  const walk = async (
    deps: Record<string, string> | undefined,
    fromDir: string,
  ): Promise<void> => {
    for (const name of Object.keys(deps ?? {})) {
      if (visited.has(name)) continue;
      visited.add(name);
      const resolved = await readInstalledPkg(name, fromDir);
      if (!resolved) continue;
      if (resolved.json.linkedPackage !== true) continue;
      let realRoot = resolved.root;
      try {
        realRoot = await fs.realpath(resolved.root);
      } catch {}
      const entry = await readSourcePackage(realRoot);
      if (entry && !seen.has(entry.name)) {
        seen.add(entry.name);
        out.push(entry);
      }
      // Recurse from the real location, so a symlinked clone resolves its own
      // dependencies from its source dir.
      await walk(resolved.json.dependencies, realRoot);
    }
  };
  const appPkg = await fsExtra.readJson(pkgPath);
  await walk(appPkg.dependencies, cwd);
  await walk(appPkg.devDependencies, cwd);
  return out;
}

/**
 * Walk the app's package.json `workspaces` field to build a lookup table
 * from npm name → absolute src/ directory. Used by the resolver plugin
 * to map bare specifiers like `@_linked/foo/bar` directly to source.
 *
 * Positive patterns are expanded by directory listing, so only a trailing `/*`
 * is honoured. NEGATED patterns (`"!packages/core"`) are honoured in full, with
 * npm's semantics — see ./workspace-globs.js. Skipping them would resolve a
 * package to an excluded directory that the package manager never installed
 * dependencies for.
 */
export async function discoverWorkspaces(
  extraGlobs: string[] = [],
  cwd: string = process.cwd(),
): Promise<WorkspaceEntry[]> {
  const fs = await import('node:fs/promises');
  const out: WorkspaceEntry[] = [];
  const seen = new Set<string>();
  // Register a package root iff it ships a `src/` dir (source install).
  const addFromRoot = async (root: string): Promise<void> => {
    const entry = await readSourcePackage(root);
    if (!entry || seen.has(entry.name)) return;
    seen.add(entry.name);
    out.push(entry);
  };

  // 1. The app's own `workspaces` globs — the monorepo-root case (CN, or any app
  //    that is itself a workspace root). Only trailing `/*` patterns.
  const pkgPath = path.join(cwd, 'package.json');
  if (await fsExtra.pathExists(pkgPath)) {
    const pkg = await fsExtra.readJson(pkgPath);
    // Merge the app's own `workspaces` globs with any caller-supplied
    // `workspaceGlobs` (e.g. `../lincd.org/modules/*`). Non-existent parents
    // are skipped below, so passing both nested + standalone layouts is safe.
    // Either list may carry negations, so they are parsed together.
    const {patterns, negatedPatterns} = parseWorkspacePatterns([
      ...(Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces?.packages ?? []),
      ...extraGlobs,
    ]);
    const addUnlessNegated = async (root: string): Promise<void> => {
      const rel = path.relative(cwd, root).split(path.sep).join('/');
      if (isWorkspacePathNegated(rel, negatedPatterns)) return;
      await addFromRoot(root);
    };
    for (const pattern of patterns) {
      const m = pattern.match(/^(.+?)\/\*$/);
      if (m) {
        const parent = path.join(cwd, m[1]);
        if (await fsExtra.pathExists(parent)) {
          for (const ent of await fs.readdir(parent, {withFileTypes: true})) {
            if (ent.isDirectory() || ent.isSymbolicLink()) {
              await addUnlessNegated(path.join(parent, ent.name));
            }
          }
        }
      } else {
        await addUnlessNegated(path.join(cwd, pattern));
      }
    }
  }

  // 2. Linked deps installed as source — including a localized checkout that is
  //    in no workspace glob. Shared with the `linked start` watch set; see
  //    discoverLinkedSourceDependencies above. Glob entries win on a name clash.
  for (const entry of await discoverLinkedSourceDependencies(cwd)) {
    if (seen.has(entry.name)) continue;
    seen.add(entry.name);
    out.push(entry);
  }

  return out;
}

/**
 * Resolve a bare specifier like `@_linked/foo/bar`, `lincd-rdfs/Foo`, or
 * `pkg/utils/Bar.js` against the workspace lookup. Tries extensions in
 * order: .ts, .tsx, then the literal id (for files that already include
 * an extension or for non-TS assets). Returns null when the specifier
 * doesn't match any workspace package or no candidate exists on disk.
 */
async function resolveWorkspaceSpecifier(
  specifier: string,
  workspaces: WorkspaceEntry[],
): Promise<string | null> {
  for (const ws of workspaces) {
    if (specifier === ws.name) {
      for (const ext of ['index.ts', 'index.tsx']) {
        const p = path.join(ws.srcDir, ext);
        if (await fsExtra.pathExists(p)) return p;
      }
      return null;
    }
    if (specifier.startsWith(ws.name + '/')) {
      const subpath = specifier.slice(ws.name.length + 1);
      // Strip .js/.jsx suffix — workspace src uses TS published-output
      // convention (./Sibling.js) but we want the TS source.
      const base = subpath.replace(/\.jsx?$/, '');
      for (const ext of ['.tsx', '.ts']) {
        const p = path.join(ws.srcDir, base + ext);
        if (await fsExtra.pathExists(p)) return p;
      }
      // Files that already include an extension Vite handles (.css, .json,
      // .svg, etc.) — return the literal path under src.
      const literal = path.join(ws.srcDir, subpath);
      if (await fsExtra.pathExists(literal)) return literal;
      return null;
    }
  }
  return null;
}

/**
 * Packages whose entry `linked start` hands to `vite.ssrLoadModule` by name
 * (`@_linked/server/shapes/LinkedServer`, see `commands/start.ts`).
 *
 * Vite transforms an explicitly requested entry, and every file it reaches by
 * RELATIVE import, whether or not the package is external. The same package's
 * bare-specifier imports from anywhere else (the app's `src`, the storage
 * config) are externalized to Node. Left external, the package is split across
 * two loaders, and which copy a file ends up in depends on import order: a file
 * the module runner has already evaluated is reused, one it has not is loaded
 * by Node, and Node then loads that file's relative imports itself. Measured in
 * CN: `package.js` and `ontologies/lincd-server.js` evaluated once by each
 * loader, and `LocalFileStore.js` too once the package's `backend` was loaded.
 * Bundling the package makes Vite the only loader for it.
 */
export const SSR_ENTRY_PACKAGES = ['@_linked/server'];

/**
 * `ssr.noExternal` for the dev SSR runner. With source workspaces, only those
 * package names are bundled by Vite; everything else in node_modules (including
 * published `@_linked/*`) is externalized to Node. Vite matches these entries
 * against the bare package name, so subpath imports (`pkg/shapes/Foo`) match too.
 * Installed packages that depend on a workspace (`dependents`, from
 * `workspaceDependents`) are bundled too, so they share the Vite-loaded workspace.
 * Standalone (no workspaces): the context-holding framework packages are bundled.
 * In both modes, `SSR_ENTRY_PACKAGES` are bundled.
 */
export function ssrNoExternal(
  workspaces: {name: string}[],
  dependents: string[] = [],
): (string | RegExp)[] {
  if (workspaces.length === 0) {
    return [/^@_linked\/server-utils$/, /^@_linked\/react$/, ...SSR_ENTRY_PACKAGES];
  }
  return [...new Set([...workspaces.map((w) => w.name), ...dependents, ...SSR_ENTRY_PACKAGES])];
}

/**
 * The `process.env.*` values inlined into the browser bundle — and only there.
 * See the `environments.client.define` note in `createViteConfig` for why the
 * server environment must not receive them.
 */
export function clientDefine(
  opts: Pick<LinkedViteConfigOptions, 'define' | 'port'> = {},
): Record<string, string> {
  return {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'process.env.SITE_ROOT': JSON.stringify(
      process.env.SITE_ROOT ?? `http://localhost:${process.env.PORT ?? opts.port ?? 4040}`,
    ),
    // The app's display name, so client components (e.g. the header) can read it
    // like the SSR <title> does (server-utils Html reads process.env.APP_NAME). The
    // browser has no `process`, so inline it; falls back to a generic label when
    // unset so a bare checkout never renders `undefined`.
    'process.env.APP_NAME': JSON.stringify(process.env.APP_NAME ?? 'Linked App'),
    ...(opts.define ?? {}),
  };
}

export function createViteConfig(opts: LinkedViteConfigOptions = {}): ReturnType<typeof defineConfig> {
  return defineConfig(async ({mode}) => {
    const isDev = mode === 'development';
    const workspaces = isDev ? await discoverWorkspaces(opts.workspaceGlobs) : [];
    // STANDALONE = dev mode with no source-shipping workspaces discovered
    // (an app installed from npm outside the monorepo — its `@_linked/*` /
    // `lincd-*` deps are lib-only). discoverWorkspaces() only registers
    // packages that ship `src/` on disk, so `length === 0` is the exact
    // standalone signal used elsewhere in this file. In WORKSPACE mode
    // (CN monorepo or its workspace-member clones) this is false and none
    // of the standalone-gated branches below apply.
    const isStandalone = isDev && workspaces.length === 0;

    // The app's published framework deps — excluded from Vite's dep-optimizer below
    // (`optimizeDeps.exclude`) so the browser's native ESM graph loads ONE copy of each.
    // Without the exclude, esbuild inlines a duplicate `@_linked/core` into each
    // per-subpath chunk (`@_linked_schema_shapes_Person.js`,
    // `@_linked_core_utils_LinkedStorage.js`, …), duplicating framework classes
    // (`Person` → `Person2`/`3`), so their shapes register under mangled URIs that no
    // longer match the backend's (one clean copy via Node). These packages are ESM with
    // no bare CJS runtime deps (e.g. `classnames` is inlined in `@_linked/react`), so
    // native-ESM serving needs no interop shim.
    const linkedDeps: string[] = [];
    if (isStandalone) {
      try {
        const appPkg = await fsExtra.readJson(path.join(process.cwd(), 'package.json'));
        const allDeps = {...appPkg.dependencies, ...appPkg.devDependencies};
        for (const name of Object.keys(allDeps)) {
          if (isFrameworkPkg(name)) linkedDeps.push(name);
        }
      } catch {
        /* best-effort — no package.json is fine */
      }
    }
    const devPort = process.env.PORT ?? opts.port;
    const clientDepIncludes =
      isDev && opts.clientDepIncludes !== false && process.env.LINKED_CLIENT_DEP_INCLUDES !== '0';
    const config: UserConfig = {
      server: {
        port: opts.port ?? 4040,
        middlewareMode: true,
        // Unique HMR websocket port per app/worktree, derived from the dev port
        // and moved to a free one when taken — see `resolveHmrPort`. Apps can
        // still override this with their own `server.hmr` in mergeConfig.
        hmr: {port: isDev ? await resolveHmrPort({devPort}) : hmrPortFor(devPort)},
      },
      build: {
        outDir: opts.outDir ?? 'public/bundles',
        manifest: true,
        // Bump chunk-size warning so it doesn't fire on every build for
        // the linked vendor bundle. Real chunking happens via
        // manualChunks below.
        chunkSizeWarningLimit: 1000,
        rollupOptions: {
          input: opts.entry ?? 'src/index.tsx',
          output: {
            entryFileNames: 'assets/[name]-[hash].js',
            chunkFileNames: 'assets/[name]-[hash].js',
            assetFileNames: 'assets/[name]-[hash][extname]',
            manualChunks: chunkForModuleId,
          },
        },
        sourcemap: true,
      },
      plugins: [
        // Direct workspace specifier resolver.
        //
        // The package.json `"./*": { "development": "./src/*.ts" }` wildcard
        // can't express "try .ts, fall back to .tsx" (Node's exports spec
        // resolves to a single literal path). For React-heavy packages like
        // @_linked/primitives, @_linked/server-utils, and @_linked/auth,
        // most files are .tsx — the wildcard fails before any Vite plugin
        // gets a chance to fix it up.
        //
        // This plugin intercepts BARE workspace specifiers like
        // `@_linked/foo/bar` and `pkg-name/utils/Baz.js` BEFORE Vite's
        // package.json resolver runs, mapping them straight to source with
        // proper extension fallback (.tsx → .ts → literal). It also covers
        // the `./Sibling.js` published-output convention for imports made
        // from within workspace `src/` trees.
        isDev
          ? ({
              name: 'linked:resolve-workspace-ts',
              enforce: 'pre',
              async resolveId(id, importer) {
                if (id.startsWith('\0')) return null;

                // Workspace-internal `./Sibling.js` → `.tsx` / `.ts` rewrite.
                if (
                  importer &&
                  importer.includes(`${path.sep}packages${path.sep}`) &&
                  /\.(jsx?)$/.test(id) &&
                  (id.startsWith('.') || id.startsWith('/'))
                ) {
                  const importerDir = path.dirname(importer);
                  const base = path.resolve(importerDir, id);
                  for (const ext of ['.tsx', '.ts']) {
                    const candidate = base.replace(/\.jsx?$/, ext);
                    if (await fsExtra.pathExists(candidate)) return candidate;
                  }
                }

                // Bare workspace specifier — resolve directly to src/.
                if (
                  !id.startsWith('.') &&
                  !id.startsWith('/') &&
                  workspaces.length > 0
                ) {
                  const resolved = await resolveWorkspaceSpecifier(id, workspaces);
                  if (resolved) return resolved;
                }

                // STANDALONE (no workspaces): the linked packages are installed
                // from npm as lib-only (no `src`). We DON'T intercept them here —
                // instead the standalone `resolve.conditions` / `ssr.resolve.conditions`
                // (set on the config below, dropping Vite's `development` token)
                // let Vite's normal resolver pick each package's `import → lib/esm`
                // export. Bundling those lib files through the SSR runner works
                // (they're plain ESM); marking them external instead would leave a
                // bare specifier that `vite.ssrLoadModule` can't load
                // ("Failed to load url @_linked/server/shapes/LinkedServer").

                return null;
              },
            } as Plugin)
          : null,
        // Published lib JS: keep decorated shape classes named `Foo`, not the
        // `Foo2` Vite's esbuild re-prints would give them — see the plugin.
        pinCompiledClassNames(),
        react({
          babel: {
            parserOpts: {
              plugins: ['decorators-legacy', 'classProperties'],
            },
          },
        }),
        // Dev-only: log every file the watcher sees change. Without this,
        // backend edits look silent (no JS rebuild step, no Node restart)
        // and it's hard to tell whether
        // Vite picked up the change at all.
        isDev
          ? ({
              name: 'linked:reload-log',
              configureServer(server) {
                server.watcher.on('change', (file) => {
                  const rel = file.replace(process.cwd() + '/', '');
                  console.log(`[linked] reloaded ${rel}`);
                });
              },
            } as Plugin)
          : null,
        clientDepIncludes
          ? linkedClientDepIncludesPlugin({
              sourceWorkspaces: workspaces,
              deny: typeof opts.clientDepIncludes === 'object' ? opts.clientDepIncludes.deny : undefined,
            })
          : null,
        ...(opts.plugins ?? []),
      ].filter(Boolean) as Plugin[],
      css: {
        modules: {
          generateScopedName: isDev ? generateScopedName : undefined,
        },
        postcss: opts.postcssPlugins
          ? {plugins: opts.postcssPlugins as any}
          : undefined,
      },
      esbuild: {
        tsconfigRaw: {
          compilerOptions: {
            experimentalDecorators: true,
          },
        },
        jsx: 'automatic',
        // A shape's IRI is built from its class name —
        // `getNodeShapeUri(packageName, constructor.name)` — so a minifier that
        // renames the class changes the shape's identity. In a production build
        // the client would ask the server for
        // `https://linked.cm/shape/server/za` while the server had registered
        // `.../BackendAPIStore`, and every Server.call on that shape 501'd.
        // The same mangling made registration report `Shape undefined does not
        // extend base class`.
        //
        // Vite honours this in the minifier only: its per-file TypeScript
        // transform and its define pass both run esbuild with keepNames off.
        // `pinCompiledClassNames` above covers what those passes rename.
        keepNames: true,
      },
      // STANDALONE resolve conditions.
      //
      // The published `@_linked/*` / `lincd-*` packages export
      //   "development": "./src/*.ts",  "import": "./lib/esm/*.js"
      // In dev, Vite expands its special `development|production` condition
      // token to `development`, so it resolves these to `./src/*.ts` — which
      // doesn't exist in a lib-only npm install → boot crash
      // ("Failed to load @_linked/server/shapes/LinkedServer").
      //
      // Dropping the dev/prod token from the condition list means Vite never
      // adds `development`; `import` (always appended last by Vite) wins, so
      // these packages resolve to `./lib/esm/*.js`. We start from Vite's
      // default SERVER conditions (`module`, `node`, `development|production`)
      // minus the dev/prod token. This governs BOTH the plugin pipeline
      // (`resolve.conditions`) and the SSR module runner used by
      // `ssrLoadModule('@_linked/server/shapes/LinkedServer')` in
      // commands/start.ts (`ssr.resolve.conditions`).
      //
      // WORKSPACE-GATED: only applied standalone. In monorepo dev the packages
      // ship `src`, and we WANT `development → src` for HMR — so we leave
      // conditions at Vite's defaults there (undefined = untouched), keeping
      // CN dev byte-for-byte unchanged.
      ...(isStandalone
        ? {
            resolve: {
              conditions: ['module', 'node'],
              // Dedupe the context-holding packages so the two `ssrLoadModule` loads
              // (LinkedServer + the app graph) resolve to ONE `server-utils`/`react`
              // instance — otherwise their `AppContext` objects differ and
              // `useAppContext()` returns null. Pairs with `ssr.noExternal` below.
              dedupe: ['@_linked/server-utils', '@_linked/react'],
            },
          }
        : {}),
      // `ssr.external` is a minimal allowlist of
      // npm deps that genuinely can't (or shouldn't) go through Vite's
      // SSR transform. Workspace packages (`@_linked/*`, `lincd-*`) are
      // DELIBERATELY removed so Vite resolves them via each package's
      // `development → ./src/*.ts` conditional export and HMR works on
      // source changes.
      //
      // "Multiple LINCD" warnings may resurface during the interim until
      // LINCD eradication completes (accepted).
      ssr: {
        // NOTE: Vite's `ssr.external` only accepts exact package-name strings
        // (not regex). Standalone `@_linked/*` / `lincd-*` are NOT force-listed
        // here — they auto-externalize (or bundle) and resolve via the
        // standalone `import → lib/esm` conditions set below.
        external: [
          'react',
          'react-dom',
          'react-dom/server',
          'react-router-dom',
          'scheduler',
          'express',
        ],
        // Vite 7 auto-externalizes node_modules packages for SSR (loading them
        // via Node → the `import`→`lib/esm` condition), which would bypass the
        // `linked:resolve-workspace-ts` resolver and create a SECOND module
        // instance of each workspace package (breaking the single-`src`-instance
        // invariant — `LinkedStorage` state set on one instance, read on the
        // other → "No query dispatch configured"). Force the workspace packages
        // to be BUNDLED so they resolve via each package's `development → src`.
        //
        // WORKSPACE-GATED: only force-bundle when workspaces are actually
        // present (the monorepo / CN + CN's workspace-member clones, where the
        // `@_linked/*` packages have `src` on disk). A STANDALONE app (CLI-
        // created, no workspaces) installs `@_linked/*` from npm as lib-only —
        // those have NO `src`, so bundling them via the `development → src`
        // condition fails ("Failed to load @_linked/server/shapes/LinkedServer").
        // Leaving them EXTERNAL lets Node resolve `import → lib/esm`. Single-
        // instance is not a concern standalone (one node_modules copy each) and
        // core's query dispatch is global-backed regardless.
        // STANDALONE: force-bundle the framework packages that hold React context /
        // shared singletons the SSR tree must agree on — `server-utils` (`AppContext`,
        // read by `AppRoot`) and `react`. If left external, LinkedServer's
        // `AppContextProvider` and the app's `AppRoot` (`useAppContext`) can resolve to
        // DIFFERENT module instances → two `AppContext` objects → `useAppContext()` sees
        // no provider (null) → "Cannot destructure 'isNativeApp'" and a blank "SSR timed
        // out". Bundling makes them one instance in Vite's SSR module graph (matching how
        // workspace mode bundles everything). `fuseki` stays external; `server` is bundled
        // because `start` loads its entry through Vite (`SSR_ENTRY_PACKAGES`). Their native
        // dependencies (e.g. `sharp`) are separate packages and stay external either way.
        //
        // WORKSPACE: bundle ONLY the discovered source workspaces (they resolve to `src/`
        // for HMR). Published framework packages installed under node_modules (lib-only)
        // stay EXTERNAL, so Vite-loaded source and Node-native `import()` share Node's
        // single instance of them. Force-bundling every `@_linked/*` here made Vite
        // evaluate its own `@_linked/core` while `loadStores` (core) loaded a store such
        // as `@_linked/fuseki/shapes/FusekiStore` through native `import()`, which pulled
        // a SECOND Node-loaded core and split the shape registry. Installed packages
        // that depend on a workspace (e.g. published fuseki when core itself is a
        // workspace) are bundled too, so they import the Vite-loaded workspace. The one
        // published exception is `SSR_ENTRY_PACKAGES`, which Vite loads regardless.
        //
        // NOT DEV (a release build of the backend): nothing is force-bundled. The
        // compiled backend is loaded by Node next to the installed
        // `@_linked/server`, so every framework package has to stay a bare import
        // that resolves to that same node_modules copy. `workspaces` is always
        // empty here, and handing that to `ssrNoExternal` used to select the
        // standalone list — which compiled a private `server-utils` into `lib/`,
        // so no app provider was `instanceof` the server's `ShapeProvider` and
        // `LinkedServer` dropped them all ("exports two generic backend providers").
        noExternal: isDev ? ssrNoExternal(workspaces, await workspaceDependents(workspaces)) : [],
        // STANDALONE: the SSR module runner (`vite.ssrLoadModule`, used to
        // load LinkedServer + the app graph in commands/start.ts) has its OWN
        // condition list, defaulting to `resolve.conditions`. Set it
        // explicitly so `development` is excluded there too and the lib-only
        // packages resolve via `import → lib/esm`. Omitted (defaults kept) in
        // workspace mode so monorepo SSR still resolves `development → src`.
        ...(isStandalone
          ? {resolve: {conditions: ['module', 'node']}}
          : {}),
      },
      // Client-only, deliberately: these go on the `client` environment, not the
      // top-level `define`, because a top-level `define` is inherited by the SSR
      // environment too.
      //
      // The browser needs them. `@_linked/server-utils`'s `Server.ts` reads
      // `process.env.SITE_ROOT` to target the backend; the browser has no
      // `process`, and Vite (unlike a bundler's EnvironmentPlugin) doesn't
      // auto-inline `process.env.X`, so SITE_ROOT is defined here — always the
      // app's own origin, defaulted to `http://localhost:<port>` (an explicit
      // `SITE_ROOT` env, e.g. from `.env-cmdrc`, still wins). NODE_ENV is a
      // common client guard, so it is defined too.
      //
      // The server must NOT get them, for two reasons:
      // - it reads `process.env` at runtime, so an inlined build-time value is
      //   wrong there (a release backend would carry the build machine's
      //   SITE_ROOT rather than the deployment's);
      // - worse, every `define` key is a trigger. Vite's `vite:define` plugin
      //   runs `esbuild.transform` — without `keepNames` — over any SSR module
      //   whose text contains a key. esbuild renames the inner binding of a
      //   tsc-emitted decorated class (`let LinkedServer = class LinkedServer`
      //   becomes `class LinkedServer2`), and a shape's IRI is built from its
      //   class name, so `@_linked/server`'s `LinkedServer` and `LincdAPI`
      //   registered as `LinkedServer2` / `LincdAPI2` in dev. Without user keys
      //   the SSR environment has none of its own (`keepProcessEnv` is on for
      //   it), so nothing server-side is rewritten.
      //
      // Only these SPECIFIC tokens, never a whole-object `process.env`
      // replacement: in a client build Vite already maps any other
      // `process.env.X` to `{}.X` (undefined), which is what client code expects.
      //
      // Apps expose their OWN frontend env vars through the `define` option,
      // which lands here too:
      //   createViteConfig({ define: {
      //     'process.env.MY_PUBLIC_KEY': JSON.stringify(process.env.MY_PUBLIC_KEY),
      //   }})
      // (only reference PUBLIC vars in client code — a defined secret would be
      // inlined into the browser bundle). An app that puts a top-level `define`
      // in its own config reintroduces both problems for the server; use
      // `environments.client.define` there as well.
      environments: {
        client: {
          define: clientDefine(opts),
        },
      },
      // WORKSPACE mode: exclude the source-shipping workspace packages (@_linked/*,
      // lincd-*) from esbuild's dep pre-bundler. They resolve to `src/` via the
      // `linked:resolve-workspace-ts` plugin; in a workspace-member CLONE they'd
      // otherwise resolve via `node_modules` SYMLINKS and esbuild fails on their
      // subpath `exports` ("No known conditions for ./shapes/SHACL …").
      // STANDALONE mode: exclude the published `@_linked/*` / `lincd-*` deps from
      // esbuild's pre-bundler so the browser's native ESM graph loads ONE copy of
      // `@_linked/core` (no per-subpath duplication → stable class names → shape URIs
      // match the backend — see `linkedDeps` above). These packages are ESM with no
      // bare CJS runtime deps (e.g. `classnames` is inlined in `@_linked/react`), so
      // serving them as native ESM needs no interop shim.
      // An excluded package is not crawled, so its OWN third-party imports (Radix,
      // vaul, js-cookie…) are listed in `optimizeDeps.include` by the
      // `linked:client-dep-includes` plugin above, once the app's excludes are final.
      ...(workspaces.length > 0
        ? {optimizeDeps: {exclude: workspaces.map((w) => w.name)}}
        : isStandalone && linkedDeps.length > 0
          ? {optimizeDeps: {exclude: linkedDeps}}
          : {}),
    };

    // Tailwind plugin (only if explicitly enabled — adds a heavy plugin).
    if (opts.cssMode === 'tailwind') {
      // Try ESM dynamic import first (works when @tailwindcss/vite is
      // installed in the app or hoisted). Surface a CLEAR warning when
      // it's not — the app needs the dep for theme variables to load.
      try {
        const tailwind: any = await import('@tailwindcss/vite' as any);
        const tailwindPlugin = tailwind.default ?? tailwind;
        (config.plugins as Plugin[]).push(tailwindPlugin());
      } catch (err) {
        console.warn(
          '[createViteConfig] cssMode=tailwind but @tailwindcss/vite ' +
            'could not be loaded. Theme variables won\'t apply at runtime. ' +
            'Add `@tailwindcss/vite` to your app\'s package.json.',
        );
      }
    }

    return config;
  });
}
