import {builtinModules} from 'module';
import fs from 'fs-extra';
import path from 'path';

/**
 * The backend entry points a compiled app is started from.
 *
 * `serve-app` requires all three on disk and `startServer` imports `lib/App.js`
 * and `lib/routes.js` by those exact paths, so the names are a contract, not a
 * convention.
 */
const BACKEND_ENTRIES: Record<string, string[]> = {
  backend: ['src/backend.ts', 'src/backend.tsx'],
  App: ['src/App.tsx', 'src/App.ts'],
  routes: ['src/routes.tsx', 'src/routes.ts'],
};

/**
 * Vite's default server conditions minus the `development|production` token.
 *
 * See the note at the `resolve` option below: dropping the token is what stops
 * a workspace package resolving to its TypeScript source.
 */
const SERVER_CONDITIONS = ['module', 'node'];

/** Both spellings, because a backend may use either. */
const NODE_BUILTINS = [
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
];

export const resolveBackendEntries = (
  appRoot: string,
  exists: (p: string) => boolean = fs.existsSync
): Record<string, string> => {
  const entries: Record<string, string> = {};
  for (const [name, candidates] of Object.entries(BACKEND_ENTRIES)) {
    const found = candidates.find((candidate) =>
      exists(path.join(appRoot, candidate))
    );
    if (found) {
      entries[name] = path.join(appRoot, found);
    }
  }
  return entries;
};

/**
 * Workspace package names to list as `ssr.external`.
 *
 * Vite will not externalise these on its own, and the reason is worth
 * recording because it is entirely non-obvious. `node_modules/@_linked/core`
 * is a symlink into `packages/core`; Vite resolves package data with
 * `preserveSymlinks: false`, so the resolved id realpaths *out* of
 * `node_modules`; and Vite refuses to externalise anything that does not look
 * like it lives there:
 *
 *     if (!configuredAsExternal && !isInNodeModules(resolved.id)) return false;
 *
 * So every workspace package got compiled into `lib/`. That is not merely
 * wasteful — `linked.backend.storage.js` is loaded from the APP ROOT by a raw
 * Node `import()` and resolves `@_linked/core` through node_modules, so the
 * storage config configured one copy of `LinkedStorage` while the compiled
 * backend queried another. `LinkedStorage`'s routing state is a per-copy
 * static, so the app's single-instance guard refuses to boot. The old `tsc`
 * build never hit this: it emitted bare specifiers and Node converged on one
 * copy. Naming the packages here restores that.
 *
 * `configuredAsExternal` is the one thing that overrides the symlink rule, and
 * it is keyed on exact package names — no regexes.
 */
export const workspacePackagesToExternalize = async (
  appRoot: string,
  discover: (
    globs: string[],
    cwd: string
  ) => Promise<{name: string}[]> = async (globs, cwd) => {
    const {discoverWorkspaces} = await import('../vite-config.js');
    return discoverWorkspaces(globs, cwd);
  }
): Promise<string[]> => {
  const workspaces = await discover([], appRoot);
  return [...new Set(workspaces.map((w) => w.name))].sort();
};

/**
 * A relative import from `lib/` into `packages/` means a workspace package was
 * compiled in after all.
 *
 * Worth failing the build over rather than leaving to be discovered: the
 * output is perfectly valid JavaScript, and the symptom is the app refusing to
 * boot with a message about storage routing that points nowhere near here.
 */
export const findInlinedWorkspaceImports = (source: string): string[] => {
  const matches = source.matchAll(
    /from\s*["'](\.[^"']*\/packages\/[^"']+)["']/g
  );
  return [...new Set([...matches].map((m) => m[1]))];
};

export const assertNoInlinedWorkspaces = async (
  appRoot: string,
  readFile: (p: string) => Promise<string> = (p) => fs.readFile(p, 'utf8')
): Promise<void> => {
  const entryPath = path.join(appRoot, 'lib', 'backend.js');
  if (!fs.existsSync(entryPath)) return;
  const inlined = findInlinedWorkspaceImports(await readFile(entryPath));
  if (inlined.length === 0) return;
  throw new Error(
    'The compiled backend inlined workspace packages instead of importing ' +
      'them: ' +
      inlined.slice(0, 3).join(', ') +
      (inlined.length > 3 ? `, and ${inlined.length - 3} more` : '') +
      '. Each one is a second copy of that package, and a second copy of ' +
      '@_linked/core splits LinkedStorage\'s routing state from the one the ' +
      'storage config configures. Check that the package is discoverable as a ' +
      'workspace, so it can be named in ssr.external.'
  );
};

/**
 * Turn Rollup's unresolved-import error into one that names the actual cause.
 *
 * Externalizing a workspace package means the build now resolves it through
 * its published `exports` — its `lib/`, not its `src/`. A package whose `lib/`
 * is stale therefore fails here, on a file that plainly exists in source.
 * Rollup's own message ("failed to resolve import X") sends you looking at the
 * import, which is fine.
 */
export const explainUnresolvedWorkspaceImport = (
  message: string,
  externalWorkspaces: string[]
): string | null => {
  const match = message.match(/failed to resolve import "([^"]+)"/i);
  if (!match) return null;
  const specifier = match[1];
  const pkg = externalWorkspaces.find(
    (name) => specifier === name || specifier.startsWith(`${name}/`)
  );
  if (!pkg) return null;
  return (
    `${message}\n\n` +
    `"${pkg}" is a workspace package, so a release build resolves it through its ` +
    `published exports — its lib/, not its src/. If this file exists in ` +
    `${pkg}/src but not in its build output, that package's lib/ is stale. ` +
    `Build it first (\`linked build\` in the package, or \`linked build-workspace\`) ` +
    `and run build-app again.`
  );
};

/**
 * Strip the client build's `manualChunks` from the SSR output options.
 *
 * Rollup refuses `manualChunks` together with `preserveModules`, and passing
 * `undefined` in the inline config does not remove it — Vite's config merge
 * keeps the app's value. So it is cleared in the output hook instead, after
 * the merge. Chunk grouping is a client concern; the backend wants one output
 * file per source file.
 */
const dropManualChunks = () => ({
  name: 'linked:backend-no-manual-chunks',
  enforce: 'post' as const,
  outputOptions(options: Record<string, unknown>) {
    if (!options.manualChunks) return null;
    const {manualChunks: _dropped, ...rest} = options;
    return rest;
  },
});

/**
 * Compile the app's backend to `lib/`.
 *
 * This runs Vite in SSR mode against the app's own `vite.config`, which is the
 * point: `linked start` already loads `src/backend.ts`, `src/App.tsx` and
 * `src/routes.tsx` through `vite.ssrLoadModule`, so a production build that
 * used anything else was resolving the same source differently from dev. The
 * workspace resolver, the decorator transform and extensionless relative
 * imports all come along for free.
 *
 * `preserveModules` keeps `src/`'s file layout in `lib/`, so the entry paths
 * stay where `serve-app` and `startServer` look for them and lazily imported
 * pages keep their own files. `manualChunks` is cleared because Rollup refuses
 * to run it alongside `preserveModules` — and it is a client-side concern
 * anyway.
 *
 * Workspace packages are named as `ssr.external` explicitly; see
 * `workspacePackagesToExternalize` for why Vite does not do it on its own.
 * Node's built-ins are listed by hand for a related reason: Vite externalises
 * them for SSR only when it recognises the specifier, and a bare `crypto` —
 * which a backend written for Node may perfectly well import — resolved
 * instead to the abandoned `crypto` shim package sitting in node_modules, and
 * failed the build.
 *
 * `copyPublicDir` is off because `public/` is the client build's output, not
 * the backend's. Left on, it copied 38MB of already-built bundles into `lib/`.
 */
export const buildBackendWithVite = async (
  options: {appRoot?: string} = {},
  dependencies: {viteBuild?: (config: any) => Promise<unknown>} = {}
): Promise<void> => {
  const appRoot = options.appRoot || process.cwd();
  const entries = resolveBackendEntries(appRoot);

  if (!entries.backend) {
    throw new Error(
      'No backend entry found: expected src/backend.ts in ' + appRoot
    );
  }

  const viteBuild =
    dependencies.viteBuild ||
    (async (config: any) => {
      const {build} = await import('vite');
      return build(config);
    });

  const externalWorkspaces = await workspacePackagesToExternalize(appRoot);

  try {
    await viteBuild({
      root: appRoot,
      mode: 'production',
      isProduction: true,
      // The client build sets `base` to the release URL. The backend emits no
      // asset URLs of its own, so it must not inherit one.
      base: '/',
      // Never resolve a `development` export condition in a release build.
      //
      // The workspace-source convention is
      //   "development": "./src/*.ts",  "import": "./lib/esm/*.js"
      // and Vite expands its `development|production` token from NODE_ENV —
      // which during a release build is whatever the app's `.env` says,
      // routinely `development`. The package then resolves to TypeScript, which
      // cannot be externalised because Node could not load it, so it is
      // compiled in regardless of what `ssr.external` says.
      //
      // Dropping the token (rather than pinning it to `production`) leaves
      // `import` — which Vite always appends last — to win. Same treatment
      // `createViteConfig` already applies to a standalone install, for the
      // mirror-image reason.
      //
      // All three lists have to say it: `ssr.resolve.conditions` does not
      // inherit from `resolve.conditions` here, and `externalConditions`
      // governs the packages that end up external.
      resolve: {conditions: SERVER_CONDITIONS},
      ssr: {
        // Merged with the app's own ssr.external rather than replacing it.
        external: externalWorkspaces,
        resolve: {
          conditions: SERVER_CONDITIONS,
          externalConditions: SERVER_CONDITIONS,
        },
      },
      plugins: [dropManualChunks()],
      build: {
        ssr: true,
        outDir: 'lib',
        emptyOutDir: true,
        copyPublicDir: false,
        manifest: false,
        sourcemap: true,
        rollupOptions: {
          input: entries,
          external: NODE_BUILTINS,
          output: {
            format: 'es',
            preserveModules: true,
            preserveModulesRoot: path.join(appRoot, 'src'),
            entryFileNames: '[name].js',
            chunkFileNames: '[name].js',
          },
        },
      },
    });
  } catch (err) {
    const explained = explainUnresolvedWorkspaceImport(
      err instanceof Error ? err.message : String(err),
      externalWorkspaces
    );
    if (!explained) throw err;
    throw new Error(explained);
  }

  await assertNoInlinedWorkspaces(appRoot);
};

/**
 * Copy `src`'s CSS next to the compiled backend.
 *
 * The server reads stylesheets like `lib/css/theme.css` off disk by path, so
 * they have to exist as files whether or not any module imported them.
 */
export const copyBackendStylesheets = async (
  appRoot: string,
  listCssFiles: (dir: string) => Promise<string[]>
): Promise<number> => {
  const sourceFolder = path.join(appRoot, 'src');
  const targetFolder = path.join(appRoot, 'lib');
  const cssFiles = await listCssFiles(sourceFolder);
  await Promise.all(
    cssFiles.map((file) => {
      const targetFile = file.replace(sourceFolder, targetFolder);
      fs.mkdirpSync(path.dirname(targetFile));
      return fs.copyFile(file, targetFile);
    })
  );
  return cssFiles.length;
};
