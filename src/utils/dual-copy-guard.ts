// Dev-time guard: warn when Node loads a file of a package the Vite SSR runner
// bundles. Under `linked start` a package in `ssr.noExternal` is evaluated by
// the module runner; if Node also evaluates one of its files (an external
// package importing a bundled one, or a native `import()` in Node-loaded
// code), the app holds two copies of that module: classes fail `instanceof`
// and module state is set on one copy and read on the other (cli backlog 015).
//
// Uses Node's in-thread `module.registerHooks` (Node 22.15+ / 23.5+). The hook
// sees every resolution in the process, so it calls `next` first, skips
// non-`file:` URLs and keeps the per-file work to a cached lookup. It only
// warns; it never fails a boot.
import fs from 'node:fs';
import path from 'node:path';
import nodeModule from 'node:module';
import {fileURLToPath} from 'node:url';
import {isBundled, type SsrMatcher} from './ssrBundled.js';

/** Set to `0` to turn the guard off. */
export const DUAL_COPY_GUARD_ENV = 'LINKED_DUAL_COPY_GUARD';

const CLI_PACKAGE = '@_linked/cli';

type ResolveResult = {url?: string} & Record<string, unknown>;
type ResolveContext = {parentURL?: string} & Record<string, unknown>;
type NextResolve = (
  specifier: string,
  context?: ResolveContext,
) => ResolveResult;
export type RegisterHooks = (hooks: {
  resolve: (
    specifier: string,
    context: ResolveContext,
    next: NextResolve,
  ) => ResolveResult;
}) => unknown;

/** A `@_linked/*` package a file belongs to, and the file's path inside it. */
export type LinkedFile = {name: string; subpath: string};

/** The `name` in `<dir>/package.json`, `null` without one (or without a name). */
export type ReadPackageName = (dir: string) => string | null;

function readPackageNameFromDisk(dir: string): string | null {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(dir, 'package.json'), 'utf8'),
    ) as {name?: unknown};
    return typeof pkg.name === 'string' ? pkg.name : null;
  } catch {
    return null;
  }
}

/**
 * Finds the `@_linked/*` package of a resolved file URL. A file under
 * `/node_modules/@_linked/<name>/` is matched by its path. A file outside
 * `node_modules` (a localized checkout's realpath under `packages-local/`, a
 * source workspace) belongs to the nearest `package.json` above it that has a
 * `name`; lookups are cached per directory.
 */
export function createLinkedFileMatcher(
  readPackageName: ReadPackageName = readPackageNameFromDisk,
): (url: string) => LinkedFile | null {
  // directory -> the package root at or above it, with its name (null: none)
  const roots = new Map<string, {dir: string; name: string} | null>();

  function rootOf(dir: string): {dir: string; name: string} | null {
    const visited: string[] = [];
    let current = dir;
    let found: {dir: string; name: string} | null = null;
    for (;;) {
      const cached = roots.get(current);
      if (cached !== undefined) {
        found = cached;
        break;
      }
      visited.push(current);
      const name = readPackageName(current);
      if (name) {
        found = {dir: current, name};
        break;
      }
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
    for (const d of visited) roots.set(d, found);
    return found;
  }

  return (url: string) => {
    if (!url.startsWith('file:')) return null;
    const file = fileURLToPath(url);
    const posix = file.split(path.sep).join('/');
    const nm = posix.lastIndexOf('/node_modules/');
    if (nm !== -1) {
      const m = /^\/node_modules\/(@_linked\/[^/]+)\/(.+)$/.exec(
        posix.slice(nm),
      );
      return m ? {name: m[1], subpath: m[2]} : null;
    }
    const root = rootOf(path.dirname(file));
    if (!root || !root.name.startsWith('@_linked/')) return null;
    const subpath = path.relative(root.dir, file).split(path.sep).join('/');
    return {name: root.name, subpath};
  };
}

/** The guard's `TWO COPIES` line for one file. */
export function twoCopiesLine(
  file: LinkedFile,
  specifier: string,
  importer: string | undefined,
): string {
  return (
    `[linked] TWO COPIES: Node loaded ${file.name}/${file.subpath} ` +
    `(imported as "${specifier}" from ${importer ?? '?'}), but ${file.name} ` +
    'is bundled for the Vite SSR runner. Classes from it will fail ' +
    '`instanceof` and its module state exists twice.'
  );
}

export type DualCopyGuardOptions = {
  /** The dev server's `ssr.noExternal`; `true` means every package is bundled. */
  noExternal: true | SsrMatcher | readonly SsrMatcher[] | undefined;
  env?: Record<string, string | undefined>;
  /** Defaults to `module.registerHooks` (absent before Node 22.15 / 23.5). */
  registerHooks?: RegisterHooks;
  nodeVersion?: string;
  /** Receives each `TWO COPIES` line. */
  report?: (line: string) => void;
  /** Receives the status line. */
  log?: (line: string) => void;
  readPackageName?: ReadPackageName;
};

export type DualCopyGuardStatus = 'on' | 'off-env' | 'off-node';

/**
 * Installs the guard and prints exactly one status line. Called once per
 * process, before the storage file loads, so it also sees `loadStores`'
 * imports. Each `<package>/<file>` is reported once.
 */
export function installDualCopyGuard(
  options: DualCopyGuardOptions,
): DualCopyGuardStatus {
  const env = options.env ?? process.env;
  const log = options.log ?? ((line: string) => console.log(line));
  const report = options.report ?? ((line: string) => console.warn(line));
  const registerHooks =
    'registerHooks' in options
      ? options.registerHooks
      : (nodeModule as unknown as {registerHooks?: RegisterHooks})
          .registerHooks;

  if (env[DUAL_COPY_GUARD_ENV] === '0') {
    log(`[linked] dual-copy guard: off (${DUAL_COPY_GUARD_ENV}=0)`);
    return 'off-env';
  }
  if (typeof registerHooks !== 'function') {
    log(
      `[linked] dual-copy guard: off (Node ${options.nodeVersion ?? process.version} has no module.registerHooks)`,
    );
    return 'off-node';
  }

  const {noExternal} = options;
  const list: readonly SsrMatcher[] = Array.isArray(noExternal)
    ? noExternal
    : typeof noExternal === 'string' || noExternal instanceof RegExp
      ? [noExternal]
      : [];
  const bundled = (name: string) =>
    noExternal === true ? true : isBundled(name, list);
  const match = createLinkedFileMatcher(options.readPackageName);
  const warned = new Set<string>();

  registerHooks({
    resolve(specifier, context, next) {
      const result = next(specifier, context);
      const url = result?.url;
      if (typeof url !== 'string' || !url.startsWith('file:')) return result;
      const file = match(url);
      // The CLI is the Node process by design; only app-side packages count.
      if (!file || file.name === CLI_PACKAGE || !bundled(file.name)) {
        return result;
      }
      const key = `${file.name}/${file.subpath}`;
      if (!warned.has(key)) {
        warned.add(key);
        report(twoCopiesLine(file, specifier, context?.parentURL));
      }
      return result;
    },
  });
  log('[linked] dual-copy guard: on');
  return 'on';
}
