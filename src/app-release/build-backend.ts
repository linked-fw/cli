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
 * anyway. Dependencies stay external (Vite's SSR default), so the backend
 * still resolves a single `@_linked/core` instance at runtime rather than
 * bundling a second copy of it.
 *
 * Node's built-ins are listed as external by hand. Vite externalises them for
 * SSR only when it recognises the specifier, and a bare `crypto` — which a
 * backend written for Node may perfectly well import — instead resolved to the
 * abandoned `crypto` shim package sitting in node_modules and failed the build.
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

  await viteBuild({
    root: appRoot,
    mode: 'production',
    // The client build sets `base` to the release URL. The backend emits no
    // asset URLs of its own, so it must not inherit one.
    base: '/',
    plugins: [dropManualChunks()],
    build: {
      ssr: true,
      outDir: 'lib',
      emptyOutDir: true,
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
