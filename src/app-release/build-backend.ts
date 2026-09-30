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
 * Every module specifier a compiled file imports: static `from "…"`, side-effect
 * `import "…"`, dynamic `import("…")`, and `require("…")`.
 *
 * Deliberately loose — it can match text inside a string or a comment. That is
 * harmless: only specifiers that resolve to a file on disk are acted on, and
 * only when that file turns out to be a copy of a package.
 */
export const findImportSpecifiers = (source: string): string[] => {
  const matches = source.matchAll(
    /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["']([^"'\n]+)["']/g
  );
  return [...new Set([...matches].map((m) => m[1]))].sort();
};

/** One import in `lib/` that reaches a compiled-in copy of a package. */
export interface InlinedPackageImport {
  /** The importing file, relative to the app root (`lib/…/PageView.js`). */
  file: string;
  /** The specifier exactly as it appears in that file. */
  specifier: string;
  /** Real path of the package source the imported module was compiled from. */
  origin: string;
  /** Name of the package that source belongs to, when it is known. */
  packageName?: string;
}

/**
 * A directory whose real path is package code the backend must import rather
 * than compile: a workspace package, a localized checkout, an installed
 * framework package.
 */
export interface PackageRoot {
  root: string;
  name?: string;
}

/**
 * Top-level directories of `lib/` that only exist when code from outside
 * `src/` was compiled in.
 *
 * `preserveModules` lays `lib/` out relative to the common ancestor of every
 * module in the build. With `preserveModulesRoot: src` the app's own files lose
 * their `src/` prefix, and anything else keeps its path from the app root — so
 * a compiled-in workspace package lands at `lib/packages/…`, an installed one at
 * `lib/node_modules/…`. Only when the app has no `src/` directory of that name,
 * since an app is free to have its own `src/packages/`.
 */
const STRAY_OUTPUT_DIRS = ['packages', 'packages-local', 'node_modules'];

const realpathOr = (p: string): string => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};

const isInside = (child: string, parent: string): boolean => {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

const listJsFiles = async (dir: string): Promise<string[]> => {
  const out: string[] = [];
  const walk = async (current: string) => {
    const entries = await fs.promises.readdir(current, {withFileTypes: true});
    await Promise.all(
      entries.map(async (entry) => {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (/\.(?:m|c)?js$/.test(entry.name)) out.push(full);
      })
    );
  };
  await walk(dir);
  return out.sort();
};

/**
 * The package roots an app's compiled backend must never contain a copy of,
 * as real paths: every discovered workspace package, everything under
 * `packages-local/`, and every installed `@_linked/*` package (whose real path
 * is a localized checkout when it has been localized).
 */
export const packageRootsForApp = async (
  appRoot: string,
  discover: (
    globs: string[],
    cwd: string
  ) => Promise<{name: string; srcDir: string}[]> = async (globs, cwd) => {
    const {discoverWorkspaces} = await import('../vite-config.js');
    return discoverWorkspaces(globs, cwd);
  }
): Promise<PackageRoot[]> => {
  const roots: PackageRoot[] = [];
  for (const ws of await discover([], appRoot)) {
    roots.push({root: realpathOr(path.dirname(ws.srcDir)), name: ws.name});
  }
  const packagesLocal = path.join(appRoot, 'packages-local');
  if (fs.existsSync(packagesLocal)) {
    for (const entry of await fs.readdir(packagesLocal)) {
      roots.push({root: realpathOr(path.join(packagesLocal, entry))});
    }
    roots.push({root: realpathOr(packagesLocal)});
  }
  const linkedScope = path.join(appRoot, 'node_modules', '@_linked');
  if (fs.existsSync(linkedScope)) {
    for (const entry of await fs.readdir(linkedScope)) {
      roots.push({
        root: realpathOr(path.join(linkedScope, entry)),
        name: `@_linked/${entry}`,
      });
    }
    roots.push({root: realpathOr(linkedScope)});
  }
  // The app itself can be discovered as a workspace; its own source is not a
  // second copy of anything.
  const appSrc = realpathOr(path.join(appRoot, 'src'));
  return roots.filter(({root}) => !isInside(appSrc, root));
};

/**
 * Find every import in the compiled backend that reaches a compiled-in copy of
 * a package.
 *
 * Each relative specifier is resolved against its file, and the module it
 * lands on is traced back to the source it was compiled from through that
 * module's sourcemap. The source's REAL path is then compared with the
 * package roots — so it does not matter what the copy's directory in `lib/` is
 * called, or whether the package was reached through a symlink. An import that
 * leaves `lib/` altogether is judged by its own real path.
 *
 * Only imports from the app's own modules are reported: they are the ones to
 * change, and every compiled-in copy is reached through one of them.
 */
export const findInlinedPackageImports = async (
  appRoot: string,
  packageRoots: PackageRoot[]
): Promise<{imports: InlinedPackageImport[]; strayDirs: string[]}> => {
  const libDir = path.join(appRoot, 'lib');
  const strayDirs = STRAY_OUTPUT_DIRS.filter(
    (name) =>
      fs.existsSync(path.join(libDir, name)) &&
      !fs.existsSync(path.join(appRoot, 'src', name))
  ).map((name) => `lib/${name}/`);
  if (!fs.existsSync(libDir)) return {imports: [], strayDirs};

  const ownerOf = (real: string): PackageRoot | undefined =>
    packageRoots
      .filter(({root}) => isInside(real, root))
      // The most specific root names the package; a named one wins a tie.
      .sort(
        (a, b) =>
          b.root.length - a.root.length || Number(!!b.name) - Number(!!a.name)
      )[0];

  // Where a module in lib/ was compiled from, via its sourcemap.
  const originCache = new Map<string, string[]>();
  const originsOf = async (moduleFile: string): Promise<string[]> => {
    const cached = originCache.get(moduleFile);
    if (cached) return cached;
    let origins: string[] = [];
    try {
      const map = JSON.parse(await fs.readFile(`${moduleFile}.map`, 'utf8'));
      const base = path.resolve(path.dirname(moduleFile), map.sourceRoot || '');
      origins = (map.sources || [])
        .filter((s: unknown) => typeof s === 'string' && !s.startsWith('\0'))
        .map((s: string) => realpathOr(path.resolve(base, s.replace(/^file:\/\//, ''))));
    } catch {
      // No sourcemap: nothing to trace. The stray-directory check still
      // catches the usual layout of a compiled-in package.
    }
    originCache.set(moduleFile, origins);
    return origins;
  };
  const packageSourceOf = async (moduleFile: string) => {
    for (const origin of await originsOf(moduleFile)) {
      const owner = ownerOf(origin);
      if (owner) return {origin, owner};
    }
    return undefined;
  };

  const imports: InlinedPackageImport[] = [];
  for (const file of await listJsFiles(libDir)) {
    // A compiled-in copy importing its own siblings is noise; report where the
    // app reaches into it.
    if (await packageSourceOf(file)) continue;
    const source = await fs.readFile(file, 'utf8');
    for (const specifier of findImportSpecifiers(source)) {
      const isPath =
        specifier.startsWith('./') ||
        specifier.startsWith('../') ||
        specifier.startsWith('/') ||
        specifier.startsWith('file://');
      if (!isPath) continue;
      const target = specifier.startsWith('file://')
        ? specifier.slice('file://'.length)
        : path.resolve(path.dirname(file), specifier);

      let found: {origin: string; owner: PackageRoot} | undefined;
      if (isInside(target, libDir)) {
        found = await packageSourceOf(target);
      } else {
        const real = realpathOr(target);
        const owner = ownerOf(real);
        if (owner) found = {origin: real, owner};
      }
      if (!found) continue;
      imports.push({
        file: path.relative(appRoot, file),
        specifier,
        origin: found.origin,
        packageName: found.owner.name,
      });
    }
  }
  return {imports, strayDirs};
};

/**
 * Fail the build when the compiled backend contains a copy of a package.
 *
 * A copy compiles and runs — and then fails somewhere else entirely: a second
 * `@_linked/core` splits `LinkedStorage`'s routing state from the one the
 * storage config configures, and a second `@_linked/server-utils` is a second
 * `ShapeProvider` class, so the server's `instanceof` check rejects every
 * provider the app exports. Neither message points anywhere near here.
 *
 * Every file in `lib/` is checked, not only the entries: a copy reached from
 * a feature folder three imports deep is just as much a second copy.
 */
export const assertNoInlinedWorkspaces = async (
  appRoot: string,
  packageRoots?: PackageRoot[]
): Promise<void> => {
  const roots = packageRoots || (await packageRootsForApp(appRoot));
  const {imports, strayDirs} = await findInlinedPackageImports(appRoot, roots);
  if (imports.length === 0 && strayDirs.length === 0) return;

  const lines = imports.slice(0, 8).map(
    (found) =>
      `  ${found.file} imports "${found.specifier}"\n` +
      `    — a compiled-in copy of ${found.origin}` +
      (found.packageName ? ` (${found.packageName})` : '')
  );
  if (imports.length > 8) lines.push(`  …and ${imports.length - 8} more`);
  const names = [
    ...new Set(imports.map((i) => i.packageName).filter(Boolean)),
  ] as string[];
  throw new Error(
    'The compiled backend contains a copy of package code instead of importing it:\n' +
      (lines.length ? lines.join('\n') + '\n' : '') +
      (strayDirs.length
        ? `  ${strayDirs.join(', ')} exists — only code compiled from outside src/ lands there\n`
        : '') +
      'Each copy is a second instance of that package: its classes fail `instanceof` ' +
      'and its registries are empty. Import the package through its public export ' +
      (names.length ? `(${names.map((n) => `"${n}" or "${n}/…"`).join(', ')}) ` : '') +
      'rather than a path into its files, and check that nothing — a resolve.alias, ' +
      'a `development` export condition — maps that import to its source. A ' +
      'workspace package must also be discoverable, so it can be named in ssr.external.'
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
