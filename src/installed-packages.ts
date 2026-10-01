// Locating installed packages the way Node does, shared by the Vite config
// helper and `linked doctor`.
import fsExtra from 'fs-extra';
import path from 'node:path';

/**
 * Framework packages that MUST be single-instance per runtime — they hold
 * module-level state (`@_linked/core`'s shape registry, `LinkedStorage`, the query
 * context) or register shapes into it. Two copies in one runtime split that state
 * and mangle shape identity (`Person`→`Person2`). This ONE list is the single source
 * of truth for the standalone `optimizeDeps.exclude` (`linkedDeps`). In workspace mode
 * `ssr.noExternal` is keyed on the discovered source workspaces instead (see
 * `ssrNoExternal`), so published framework packages stay external and single-instance
 * under Node.
 */
export const FRAMEWORK_PKG_PATTERNS: RegExp[] = [/^@_linked\//, /^lincd-/];
export const isFrameworkPkg = (name: string): boolean =>
  FRAMEWORK_PKG_PATTERNS.some((re) => re.test(name));

// Resolve a dependency name to its installed package.json the way Node does:
// look in `<dir>/node_modules/<name>`, then each parent directory's
// node_modules, starting from the requiring package's directory. This finds
// deps that npm/yarn workspaces HOISTED to the monorepo root (an app under
// `services/api` whose dep lives in `<root>/node_modules`). The walk stops
// after the nearest directory whose package.json declares `workspaces` (the
// workspace root), or at the filesystem root. Returns null when the package
// isn't installed (e.g. an optional dep) — we skip rather than throw.
export async function isWorkspaceRoot(dir: string): Promise<boolean> {
  try {
    const json = await fsExtra.readJson(path.join(dir, 'package.json'));
    return !!json.workspaces;
  } catch {
    return false;
  }
}

export async function readInstalledPkg(
  name: string,
  fromDir: string,
): Promise<{root: string; json: any} | null> {
  let dir = path.resolve(fromDir);
  while (true) {
    const root = path.join(dir, 'node_modules', name);
    const pkgJson = path.join(root, 'package.json');
    if (await fsExtra.pathExists(pkgJson)) {
      try {
        return {root, json: await fsExtra.readJson(pkgJson)};
      } catch {
        return null;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir || (await isWorkspaceRoot(dir))) return null;
    dir = parent;
  }
}
