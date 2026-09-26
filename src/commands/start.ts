// `linked start --vite` orchestrator.
//
// Follows the existing startServer() flow from cli-methods.ts but injects
// a Vite dev server in middleware mode + overrides loadAppComponent /
// loadRoutes to use vite.ssrLoadModule. This means LinkedServer's existing
// initialization works unchanged; we just route module loading through
// Vite instead of webpack/Node-direct.
//
// What's different vs the legacy startServer():
//   - No webpack-dev-middleware (LinkedServer skips when viteMiddleware set)
//   - Vite handles the client transform + HMR
//   - ssrLoadModule handles the server transform (decorators, jsx, ts)
//   - Server changes still need full process restart for now (server HMR
//     deferred to vite-node migration)
import path from 'node:path';
import fs from 'node:fs/promises';
import {spawn} from 'node:child_process';
import fsExtra from 'fs-extra';
import {parseWorkspacePatterns, isWorkspacePathNegated} from '../workspace-globs.js';

import type {InlineConfig, UserConfigExport, ViteDevServer} from 'vite';

export interface StartOptions {
  env?: string;
  port?: number;
  /**
   * Serve only the backend API (`/call/...`, `/api/...`, provider routes).
   * No `vite.config.*`, `src/App.tsx` or `src/routes.tsx` is needed, and page
   * requests get a 404 instead of server-side rendering.
   */
  apiOnly?: boolean;
}

export const VITE_CONFIG_FILES = ['vite.config.ts', 'vite.config.js', 'vite.config.mjs'];

/**
 * Names for the app's linked config, in priority order. `lincd.config.js` is
 * the legacy name: apps predating the rename still ship it, and dropping it
 * would silently discard their whole `server` config (cachePaths, `apiOnly`, …).
 */
export const LINKED_CONFIG_FILES = ['linked.config.js', 'lincd.config.js'];

/**
 * Absolute path to the app's linked config. Returns the first name that exists;
 * when none does, the current name — the caller still `existsSync`-guards the
 * import, so this is simply the "no config here" path, not a promise of a file.
 */
export function resolveLinkedConfigPath(cwd: string): string {
  return (
    LINKED_CONFIG_FILES.map((name) => path.join(cwd, name)).find((candidate) =>
      fsExtra.existsSync(candidate),
    ) ?? path.join(cwd, LINKED_CONFIG_FILES[0])
  );
}

/**
 * API-only mode is explicit: `linked start --api-only`, or `server.apiOnly: true`
 * in `linked.config.js`. It is never inferred from missing frontend files, so a
 * web app that lost its `vite.config.ts` still fails loudly instead of silently
 * serving no pages.
 */
export function isApiOnly(opts: StartOptions, linkedConfig: any): boolean {
  return opts.apiOnly === true || linkedConfig?.server?.apiOnly === true;
}

/**
 * The Vite dev-server config for `linked start`.
 *
 * With a `vite.config.*` in `cwd`, Vite loads it itself. Without one, API-only
 * mode uses `createViteConfig()`'s defaults inline — Vite is still needed on the
 * backend to transform TypeScript, decorators and extensionless imports of
 * source-only shape packages. Without one in page mode, it is an error.
 */
export async function resolveViteServerConfig(
  cwd: string,
  apiOnly: boolean,
): Promise<InlineConfig> {
  const base: InlineConfig = {
    root: cwd,
    server: {middlewareMode: true},
    appType: 'custom',
  };
  if (VITE_CONFIG_FILES.some((c) => fsExtra.existsSync(path.join(cwd, c)))) {
    return base;
  }
  if (!apiOnly) {
    throw new Error(
      `[linked start] no vite.config.{ts,js,mjs} found in ${cwd}. Add one:\n\n  import {createViteConfig} from '@_linked/cli/vite-config';\n  export default createViteConfig({port: 4040, cssMode: 'tailwind'});\n\nFor a backend without a web frontend, run \`linked start --api-only\` instead.\n`,
    );
  }
  const {createViteConfig} = await import('../vite-config.js');
  const exported: UserConfigExport = createViteConfig();
  const defaults =
    typeof exported === 'function'
      ? await exported({command: 'serve', mode: 'development'})
      : await exported;
  return {
    ...defaults,
    ...base,
    configFile: false,
    server: {...defaults.server, ...base.server},
    // No browser client: skip the client dependency scan, whose entry
    // (`src/index.tsx`) does not exist in a backend.
    optimizeDeps: {...defaults.optimizeDeps, noDiscovery: true},
  };
}

/**
 * Inject Vite into LinkedServer's config:
 *   - vite: handle for ssrLoadModule (used to load app's backend.ts via self-reference)
 * and, unless API-only (where `apiOnly` makes LinkedServer skip page rendering):
 *   - viteMiddleware: mounted instead of webpack-dev-middleware
 *   - loadAppComponent / loadRoutes: route through vite.ssrLoadModule for SSR transform
 *   - viteSsrPreload: page modules to preload for SSR CSS collection
 */
export function configureLinkedServer(
  serverConfig: any,
  vite: Pick<ViteDevServer, 'middlewares' | 'ssrLoadModule'>,
  cwd: string,
  apiOnly: boolean,
): void {
  serverConfig.vite = vite;
  if (apiOnly) {
    serverConfig.apiOnly = true;
    return;
  }
  serverConfig.viteMiddleware = vite.middlewares;
  serverConfig.loadAppComponent = async () => {
    const mod = await vite.ssrLoadModule('/src/App.tsx');
    return mod.default;
  };
  serverConfig.loadRoutes = async () => {
    return await vite.ssrLoadModule('/src/routes.tsx');
  };

  // Vite SSR CSS collection support:
  // List all `src/pages/*.{ts,tsx}` files so LinkedServer can ssrLoadModule
  // each into Vite's moduleGraph BEFORE the first render of a session.
  // React.lazy() doesn't auto-fire — without this, only App's eager
  // imports' CSS is collected; lazy pages' CSS arrives after hydration
  // causing an unstyled flash. After the first preload sweep, all
  // subsequent renders have full CSS available.
  serverConfig.viteSsrPreload = async () => {
    const pagesDir = path.join(cwd, 'src', 'pages');
    if (!fsExtra.existsSync(pagesDir)) return [];
    const files = fsExtra.readdirSync(pagesDir, {withFileTypes: true});
    const paths: string[] = [];
    for (const file of files) {
      // Test files live beside pages but call vi.mock() at module scope,
      // which throws outside Vitest — never load them into the SSR graph.
      // `.d.ts` files are types only: they have no runtime module to load.
      if (
        file.isFile() &&
        /\.(tsx|ts)$/.test(file.name) &&
        !/\.(test|spec)\.(tsx|ts)$/.test(file.name) &&
        !file.name.endsWith('.d.ts')
      ) {
        paths.push(`/src/pages/${file.name}`);
      }
    }
    return paths;
  };
}

interface WorkspacePackage {
  name: string;
  root: string;
  srcDir: string;
}

/**
 * Discover the packages whose sources `linked start` watches for HMR, from two
 * sources. No hand-maintained list anywhere.
 *
 * 1. The app's `package.json` `workspaces` field — adding a new linked package
 *    = appearing in the right glob.
 * 2. The app's linked dependencies that are installed as SOURCE — the same rule
 *    the Vite resolver table uses (`discoverLinkedSourceDependencies`), so the
 *    two lists cannot disagree about what is source. This covers a LOCALIZED
 *    checkout (`packages-local/<pkg>`), which is deliberately in no workspace
 *    glob and reachable only through its `node_modules` symlink. Without it
 *    `workspacePackageForPath` returns null for the checkout, so a saved backend
 *    edit is reloaded by Vite and then never re-indexed: the registered provider
 *    instance is never replaced.
 *
 * Returns each package's npm `name` (so we can call `onSourceChange(name)`), its
 * absolute root, and its `src/` directory for fast prefix matching. Dependency
 * roots are realpathed by the shared discovery, matching the ids Vite reports.
 */
export async function discoverWorkspacePackages(cwd: string): Promise<WorkspacePackage[]> {
  const pkgJsonPath = path.join(cwd, 'package.json');
  if (!(await fsExtra.pathExists(pkgJsonPath))) return [];
  const pkgJson = await fsExtra.readJson(pkgJsonPath);
  const {patterns, negatedPatterns} = parseWorkspacePatterns(pkgJson.workspaces);
  const out: WorkspacePackage[] = [];

  // Include the root app itself so edits to <cwd>/src/* trigger HMR for
  // the app's own providers (e.g. CN's src/backend.ts which registers ~25
  // Express routes).
  if (pkgJson.name && (await fsExtra.pathExists(path.join(cwd, 'src')))) {
    out.push({name: pkgJson.name, root: cwd, srcDir: path.join(cwd, 'src')});
  }
  for (const glob of patterns) {
    // Positive patterns are expanded by directory listing rather than with a
    // full glob library, so only a trailing /* is honoured. Negated entries
    // ("!packages/core") are honoured in full — watching an excluded directory
    // would trigger HMR for a package the app does not actually resolve.
    const m = glob.match(/^(.+?)\/\*$/);
    const candidates: string[] = [];
    if (m) {
      const parent = path.join(cwd, m[1]);
      if (await fsExtra.pathExists(parent)) {
        const entries = await fs.readdir(parent, {withFileTypes: true});
        for (const dirent of entries) {
          if (dirent.isDirectory() || dirent.isSymbolicLink()) {
            candidates.push(path.join(parent, dirent.name));
          }
        }
      }
    } else {
      candidates.push(path.join(cwd, glob));
    }
    for (const root of candidates) {
      const rel = path.relative(cwd, root).split(path.sep).join('/');
      if (isWorkspacePathNegated(rel, negatedPatterns)) continue;
      const pkgPath = path.join(root, 'package.json');
      if (!(await fsExtra.pathExists(pkgPath))) continue;
      try {
        const sub = await fsExtra.readJson(pkgPath);
        if (sub.name) {
          out.push({name: sub.name, root, srcDir: path.join(root, 'src')});
        }
      } catch {
        // ignore broken package.json
      }
    }
  }

  // Linked deps installed as source, realpathed — a localized checkout is here
  // and nowhere else. Imported lazily because vite-config pulls in Vite itself.
  const {discoverLinkedSourceDependencies} = await import('../vite-config.js');
  const names = new Set(out.map((p) => p.name));
  for (const entry of await discoverLinkedSourceDependencies(cwd)) {
    if (names.has(entry.name)) continue;
    // Only working copies. Some PUBLISHED packages ship `src/` in their tarball,
    // so the resolver registers them (it serves that source) — but they stay
    // inside `node_modules`, which Vite's watcher ignores, so no change event
    // can ever match them. Listing them would inflate the count printed at boot
    // with packages nothing watches. A localized checkout, a workspace clone and
    // an `npm link` all realpath to a directory outside `node_modules`.
    if (isInsideNodeModules(entry.srcDir)) continue;
    names.add(entry.name);
    out.push({name: entry.name, root: path.dirname(entry.srcDir), srcDir: entry.srcDir});
  }
  return out;
}

function isInsideNodeModules(p: string): boolean {
  return p.split(path.sep).includes('node_modules');
}

function workspacePackageForPath(
  filepath: string,
  pkgs: WorkspacePackage[],
): string | null {
  for (const p of pkgs) {
    if (filepath.startsWith(p.srcDir + path.sep) || filepath === p.srcDir) {
      return p.name;
    }
  }
  return null;
}

function openBrowser(url: string): void {
  const cmd =
    process.platform === 'darwin'
      ? 'open'
      : process.platform === 'win32'
        ? 'start'
        : 'xdg-open';
  spawn(cmd, [url], {detached: true, stdio: 'ignore'}).unref();
}

function installShortcuts(opts: {url: string; onRestart: () => void}): void {
  if (!process.stdin.isTTY) return;
  let buf = '';
  try {
    process.stdin.setRawMode(true);
  } catch {
    return;
  }
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  const cleanup = () => {
    try {
      process.stdin.setRawMode(false);
    } catch {}
  };
  process.on('exit', cleanup);
  process.stdin.on('data', (chunk: string) => {
    for (const ch of chunk) {
      // Ctrl-C → graceful exit, restore terminal first.
      if (ch === '') {
        cleanup();
        process.exit(0);
      }
      if (ch === '\r' || ch === '\n') {
        const cmd = buf.trim();
        buf = '';
        if (cmd === 'r') {
          console.log('[linked] restarting…');
          opts.onRestart();
        } else if (cmd === 'o') {
          console.log(`[linked] opening ${opts.url}`);
          openBrowser(opts.url);
        }
      } else {
        buf += ch;
      }
    }
  });
  console.log(
    `[linked] press r<enter> to restart · o<enter> to open ${opts.url}`,
  );
}

function restartProcess(): void {
  // nodemon-style respawn: launch a fresh process from the same argv,
  // then exit. The new process inherits stdio so the dev experience is
  // continuous.
  const [node, ...argv] = process.argv;
  const child = spawn(node, argv, {
    stdio: 'inherit',
    detached: true,
    env: process.env,
  });
  child.unref();
  process.exit(0);
}

export async function startWithVite(opts: StartOptions = {}): Promise<void> {
  const cwd = process.cwd();

  // Load the app's own `.env` (Node 20.12+ `process.loadEnvFile`) if present — the
  // standard, dependency-free env source for a linked app. Node does NOT override
  // vars already set in the environment, so CN's injected per-(project,branch) vars
  // (PORT, FUSEKI_DATASET, CN_APP_ADMIN_SECRET, …) take precedence over the file.
  try {
    const envPath = path.join(cwd, '.env');
    if (
      (await fsExtra.pathExists(envPath)) &&
      typeof (process as {loadEnvFile?: (p: string) => void}).loadEnvFile === 'function'
    ) {
      (process as {loadEnvFile: (p: string) => void}).loadEnvFile(envPath);
    }
  } catch {
    // best-effort — a missing/invalid .env never blocks start
  }

  // `--env` still loads env-cmd (`.env-cmdrc.json`) for CN's own start:local flow.
  const {ensureEnvironmentLoaded} = await import('../lifecycle.js');
  await ensureEnvironmentLoaded();

  // Load user's linked.config.js (legacy hook). It still drives things
  // like server.cachePaths and the rest of LinkedServer's options.
  const linkedConfigPath = resolveLinkedConfigPath(cwd);
  let linkedConfig: any = {};
  if (fsExtra.existsSync(linkedConfigPath)) {
    linkedConfig = (await import(linkedConfigPath)).default ?? {};
  }
  linkedConfig.server = linkedConfig.server || {};
  const apiOnly = isApiOnly(opts, linkedConfig);

  const {createServer: createViteServer} = await import('vite');
  const vite = await createViteServer(await resolveViteServerConfig(cwd, apiOnly));
  configureLinkedServer(linkedConfig.server, vite, cwd, apiOnly);

  // Load the storage config through Vite SSR so it
  // configures the SAME LinkedStorage instance the rest of the SSR graph
  // (LinkedServer, CN providers) uses. Replaces the former Node-direct
  // `loadBackendStorageConfig()` (which resolved @_linked/core via the
  // `default`→lib condition, a SEPARATE instance). Safe now that core's lib
  // `initTree` is idempotent. `loadBackendStorageConfig` stays in
  // lifecycle.ts for the Node-only CLI commands (`script`/`call`) that have no
  // Vite server (contract C5).
  // The first two names are current; the rest are legacy filenames kept so
  // older apps that never renamed their storage config still start.
  for (const rel of [
    '/linked.backend.storage.ts',
    '/linked.backend.storage.js',
    '/backend-storage-config.ts',
    '/backend-storage-config.js',
    '/scripts/backend-storage-config.ts',
    '/scripts/backend-storage-config.js',
    '/scripts/storage-config.js',
  ]) {
    if (fsExtra.existsSync(path.join(cwd, rel.slice(1)))) {
      await vite.ssrLoadModule(rel);
      break;
    }
  }

  // Load LinkedServer through Vite SSR so it shares the SAME
  // module instances as everything else in the SSR call graph. Without
  // this, LinkedServer is loaded by Node (→ lib/esm) while CN's App.tsx +
  // its transitive imports are loaded by Vite (→ src/). React contexts
  // created in one tree don't reach consumers in the other, causing
  // "Cannot destructure property 'isNativeApp' of useAppContext()" type
  // errors on every SSR render.
  const ServerClass = (
    await vite.ssrLoadModule('@_linked/server/shapes/LinkedServer')
  ).LinkedServer;

  const server = new (ServerClass as any)(linkedConfig);

  // Surface stack traces from Vite ssrLoadModule failures cleanly.
  process.on('unhandledRejection', (err: any) => {
    if (err && err.stack) {
      try {
        vite.ssrFixStacktrace(err);
      } catch {
        // ignore
      }
    }
    console.error(err);
  });

  await server.start();

  // Watcher → onSourceChange wiring.
  //
  // Discover workspace packages once at boot. On each change, look up
  // which workspace package the file belongs to and call onSourceChange
  // with that package's npm name. LinkedServer disposes the old providers,
  // re-imports via vite.ssrLoadModule (transparent because Vite invalidated
  // the module already), and re-instantiates. No process restart.
  const workspacePackages = await discoverWorkspacePackages(cwd);
  if (workspacePackages.length > 0) {
    console.log(
      `[linked] watching ${workspacePackages.length} workspace packages for HMR`,
    );
  }
  // Reloads are DEBOUNCED and SERIALISED. `onSourceChange` disposes a
  // package's providers and re-registers their express routes, i.e. it mutates
  // the shared router stack. Firing it per file change (a multi-file save, a
  // format-on-save, a branch switch) ran overlapping dispose/re-register
  // cycles against that same stack with nothing ordering them. Collect the
  // affected packages over a short window, then run the cycles one at a time.
  const RELOAD_DEBOUNCE_MS = 150;
  const pendingReloads = new Set<string>();
  let reloadTimer: NodeJS.Timeout | undefined;
  // Tail of the reload chain — each flush appends, so cycles never interleave.
  let reloadChain: Promise<void> = Promise.resolve();

  const flushReloads = () => {
    const pkgs = [...pendingReloads];
    pendingReloads.clear();
    reloadChain = reloadChain.then(async () => {
      for (const pkg of pkgs) {
        try {
          await (server as any).onSourceChange(pkg);
        } catch (err: any) {
          console.warn(
            `[linked] reload of ${pkg} failed: ${err?.message ?? err}`,
          );
        }
      }
    });
  };

  vite.watcher.on('change', (filepath: string) => {
    if (!/\.(tsx?|jsx?)$/.test(filepath)) return;
    const pkg = workspacePackageForPath(filepath, workspacePackages);
    if (!pkg) return;
    if (typeof (server as any).onSourceChange !== 'function') return;
    pendingReloads.add(pkg);
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(flushReloads, RELOAD_DEBOUNCE_MS);
  });

  // r/o keyboard shortcuts.
  const port = (linkedConfig.server as any).port ?? opts.port ?? 4040;
  installShortcuts({
    url: `http://localhost:${port}/`,
    onRestart: restartProcess,
  });
}
