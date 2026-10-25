// Locating installed packages the way Node does, shared by the Vite config
// helper and `linked app-doctor`.
import fsExtra from 'fs-extra';
import {globSync} from 'glob';
import fs from 'node:fs';
import path from 'node:path';

import {
  isWorkspacePathNegated,
  parseWorkspacePatterns,
} from './workspace-globs.js';

/**
 * Framework packages that MUST be single-instance per runtime — they hold
 * module-level state (`@_linked/core`'s shape registry, `LinkedStorage`, the query
 * context) or register shapes into it. Two copies in one runtime split that state
 * and mangle shape identity (`Person`→`Person2`).
 *
 * A NAME check, used only by `client-dep-includes` (alongside the flag). Deciding
 * whether an installed package is linked goes by its `package.json` instead —
 * {@link isLinkedPackageJson} — which is what the source walk and the standalone
 * `optimizeDeps.exclude` use.
 */
export const FRAMEWORK_PKG_PATTERNS: RegExp[] = [/^@_linked\//, /^lincd-/];
export const isFrameworkPkg = (name: string): boolean =>
  FRAMEWORK_PKG_PATTERNS.some((re) => re.test(name));

/**
 * Is `dir` a workspace root, where a `node_modules` walk stops? Only when its
 * `package.json` declares `workspaces` AND at least one of those globs matches
 * a package directory that exists (a directory with a `package.json`, not
 * excluded by a negation).
 *
 * Declaring the globs is not enough. An app made from the app template lists
 * `packages-local/*` so it can localize packages standalone; run inside a
 * parent workspace (CN's `packages-local/<app>`) with no checkouts of its own,
 * it has nothing installed and npm hoisted its dependencies to the parent.
 * Stopping at the app then missed the parent's `node_modules`: no localized
 * package was registered as source, while Node walked up to the parent's
 * symlinks and loaded the checkouts anyway — two copies of `@_linked/core`.
 */
export async function isWorkspaceRoot(dir: string): Promise<boolean> {
  let json: any;
  try {
    json = await fsExtra.readJson(path.join(dir, 'package.json'));
  } catch {
    return false;
  }
  return hasWorkspaceMembers(dir, json?.workspaces);
}

/**
 * Does the `workspaces` value of the `package.json` in `dir` match at least one
 * package directory that exists: one with a `package.json`, not excluded by a
 * negation? A glob whose base folder is missing or empty matches none. See
 * {@link isWorkspaceRoot}.
 */
export function hasWorkspaceMembers(dir: string, workspaces: unknown): boolean {
  const {patterns, negatedPatterns} = parseWorkspacePatterns(workspaces);
  if (patterns.length === 0) return false;
  const manifests = globSync(
    patterns.map((p) => `${p.replace(/\/+$/, '')}/package.json`),
    {cwd: dir, posix: true},
  );
  return manifests.some(
    (manifest) =>
      !isWorkspacePathNegated(path.posix.dirname(manifest), negatedPatterns),
  );
}

// Resolve a dependency name to its installed package.json the way Node does:
// look in `<dir>/node_modules/<name>`, then each parent directory's
// node_modules, starting from the requiring package's directory. This finds
// deps that npm/yarn workspaces HOISTED to the monorepo root (an app under
// `services/api` whose dep lives in `<root>/node_modules`). The walk stops
// after the nearest workspace root ({@link isWorkspaceRoot}), or at the
// filesystem root. Returns null when the package isn't installed (e.g. an
// optional dep) — we skip rather than throw.
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

/**
 * THE definition of a linked package: its own `package.json` says
 * `"linkedPackage": true`. Not its npm scope — a linked package can be
 * published under any scope, and not everything under `@_linked/` is one
 * (a plain tool need not be). The pre-rename `"lincd": true` is not
 * read: the packages that still carry it are the old `lincd-*` framework,
 * which cannot share a runtime with `@_linked/core`. `lifecycle.ts`
 * (`build-all`, `getLincdPackages`) and `linked build-package` use this too.
 */
export const isLinkedPackageJson = (json: any): boolean =>
  json?.linkedPackage === true;

/** An installed linked package, as {@link discoverInstalledLinkedPackages} finds it. */
export interface InstalledLinkedPackage {
  name: string;
  /** The installed directory, realpathed: a localized checkout's own path. */
  realRoot: string;
  json: any;
}

/**
 * Every installed linked package an app depends on: its `dependencies` and
 * `devDependencies`, and recursively the `dependencies` of each linked package
 * found, keeping those {@link isLinkedPackageJson} says are linked.
 *
 * Walked breadth-first and keyed on the installed directory, not the name, so
 * the app's own copy of a package is settled before any copy a dependency
 * installed for itself. A checkout's own `node_modules` can hold a
 * published copy of a sibling it depends on (npm nests one when the sibling's
 * checkout misses its range); keyed on the name and walked depth-first,
 * reaching that copy first hid the app's checkout of it. The same name can
 * therefore appear more than once, once per copy.
 */
export async function discoverInstalledLinkedPackages(
  cwd: string = process.cwd(),
): Promise<InstalledLinkedPackage[]> {
  const pkgPath = path.join(cwd, 'package.json');
  if (!(await fsExtra.pathExists(pkgPath))) return [];
  const appPkg = await fsExtra.readJson(pkgPath);
  const out: InstalledLinkedPackage[] = [];
  const visited = new Set<string>();
  let level: {deps: Record<string, string> | undefined; fromDir: string}[] = [
    {deps: appPkg.dependencies, fromDir: cwd},
    {deps: appPkg.devDependencies, fromDir: cwd},
  ];
  while (level.length > 0) {
    const next: typeof level = [];
    for (const {deps, fromDir} of level) {
      for (const name of Object.keys(deps ?? {})) {
        const resolved = await readInstalledPkg(name, fromDir);
        if (!resolved || !isLinkedPackageJson(resolved.json)) continue;
        let realRoot = resolved.root;
        try {
          realRoot = await fsExtra.realpath(resolved.root);
        } catch {}
        if (visited.has(realRoot)) continue;
        visited.add(realRoot);
        out.push({name, realRoot, json: resolved.json});
        // Recurse from the real location, so a symlinked clone resolves its own
        // dependencies from its source dir.
        next.push({deps: resolved.json.dependencies, fromDir: realRoot});
      }
    }
    level = next;
  }
  return out;
}
