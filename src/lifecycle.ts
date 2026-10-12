// Lifecycle helpers shared by the Vite-based dev orchestrator.
//
// Extracted from cli-methods.ts so the SSR module graph (started from
// `commands/start.ts`) doesn't have to walk the rest of that file. The
// the older helpers in cli-methods.ts contain many dynamic
// `import(<variable>)` calls Vite can't analyze statically and would
// emit warnings about — even though startWithVite never calls them.

import fs from 'fs-extra';
import path from 'path';
import chalk from 'chalk';
import {getPackageJSON} from './utils.js';
import {isLinkedPackageJson} from './installed-packages.js';
import {LOCAL_DIR, localMembers} from './localize/members.js';
import {
  parseWorkspacePatterns,
  isWorkspacePathNegated,
} from './workspace-globs.js';
// Shared with the CSS loader's mode resolution, which must pick the same profiles.
import {readEnvNamesFromArgv} from './loader-mode.js';
import type {PackageDetails} from './interfaces.js';
import {importFile} from './utils/platform.js';

/**
 * Load the app's environment into `process.env`, then re-apply the original
 * shell env so it always wins on conflict. Idempotent — runs at most once.
 *
 * Two sources, tried in this order:
 *   1. `.env` (Node-native `process.loadEnvFile`, no dependency) — a flat file.
 *      This is what the app template ships and the only form that will survive.
 *      `--env` is not consulted here: a flat `.env` has no profiles, so
 *      NODE_ENV comes from the file or the shell.
 *   2. `.env-cmdrc.json` (DEPRECATED, via `env-cmd`) — profile-based; honours
 *      `--env a,b` and merges `_main` + the named profiles. Still read when it
 *      is the only file present, so no existing app breaks, but it warns.
 *
 * `.env` going first is what makes migrating a one-step job: add the flat file
 * and it takes over. The profile file can then be deleted whenever convenient.
 *
 * If neither file exists we skip silently — CN-hosted apps have their env
 * injected into the child process at spawn time, so there's nothing to read
 * from disk.
 */
export const ensureEnvironmentLoaded = async (
  environmentNames?: string[],
): Promise<void> => {
  if (process.env.ENV_VARS_LOADED) return;
  const cwd = process.cwd();
  const envCmdrcPath = path.join(cwd, '.env-cmdrc.json');
  const dotEnvPath = path.join(cwd, '.env');

  // Snapshot the original shell env — it should always take priority over
  // whatever a file sets (so injected/production env wins over dev defaults).
  const shellEnv = {...process.env};

  const hasDotEnv = fs.existsSync(dotEnvPath);
  const hasEnvCmdrc = fs.existsSync(envCmdrcPath);

  for (const notice of envDeprecationNotices({hasEnvCmdrc, hasDotEnv})) {
    console.warn(chalk.yellow(notice));
  }

  if (hasDotEnv) {
    // Native flat-file loader (Node 20.12+). Populates process.env from `.env`.
    process.loadEnvFile(dotEnvPath);
  } else if (hasEnvCmdrc) {
    await loadEnvCmdrc(envCmdrcPath, environmentNames);
  } else {
    console.warn(
      'No .env or .env-cmdrc.json found in this folder — relying on the ambient environment.',
    );
  }

  // Re-apply shell env so it always wins over file values.
  process.env = {...process.env, ...shellEnv};
  process.env.ENV_VARS_LOADED = 'true';
};

/**
 * What to tell an app about where its environment came from.
 *
 * `.env-cmdrc.json` is still read when it is the only file present, so no app
 * breaks today. But it is the only reason `--env` exists, and both are going
 * away.
 *
 * The case worth shouting about is an app holding both files: `.env` wins, so
 * the profile file and every `--env` name passed with it do nothing. That is
 * the intended migration path, but it is invisible from the outside — values
 * an app still believes it is getting from a profile are simply absent.
 *
 * Pure and exported so the messages can be asserted without a chdir.
 */
export const envDeprecationNotices = (sources: {
  hasEnvCmdrc: boolean;
  hasDotEnv: boolean;
}): string[] => {
  if (!sources.hasEnvCmdrc) return [];
  const notices = [
    '.env-cmdrc.json is deprecated and will be removed in a future major release.',
    '  Move its values into a flat `.env`, and supply anything that differs per ' +
      'deployment from the environment itself. `--env` goes away with it.',
  ];
  if (sources.hasDotEnv) {
    notices.push(
      '  This app has BOTH files. `.env` wins, so `.env-cmdrc.json` — and any ' +
        '`--env` profile named with it — is being ignored entirely. Delete it once ' +
        'the flat file is complete.',
    );
  }
  return notices;
};

/**
 * Legacy loader: reads `.env-cmdrc.json`, merges `_main` plus the profile(s)
 * named by `--env a,b` (default `development`). Kept for CN and existing apps
 * until they migrate to a flat `.env`.
 */
const loadEnvCmdrc = async (
  envCmdrcPath: string,
  environmentNames?: string[],
): Promise<void> => {
  // env-cmd ships ESM; literal specifier is fine for Vite's analyzer.
  const {GetEnvVars} = await import('env-cmd');
  const vars = await GetEnvVars({envFile: {filePath: envCmdrcPath}});
  const environments = Object.keys(vars);

  if (environments.includes('_main')) {
    process.env = {...process.env, ...vars._main};
  }
  // Callers that parsed `--env` themselves pass the names in. Commands that
  // have not been converted yet still have their names scraped off argv.
  const requested = environmentNames?.length
    ? environmentNames
    : readEnvNamesFromArgv();
  if (requested.length) {
    requested.forEach((name) => {
      if (environments.includes(name)) {
        console.log('Environment: ' + name);
        process.env = {...process.env, ...vars[name]};
      } else {
        console.warn(
          `Environment ${name} not found in .env-cmdrc.json. Available: ${environments.join(', ')}`,
        );
      }
    });
  } else {
    process.env = {...process.env, ...vars.development};
    console.log('No environment specified, using development');
  }
};

/**
 * Discover and load the app's storage-config bootstrap file. Tries the
 * canonical `linked.backend.storage.{ts,js}` first, then legacy paths.
 * Returns whatever the file's default export evaluates to, or undefined
 * if no candidate exists.
 */
export async function loadBackendStorageConfig(): Promise<any> {
  const cwd = process.cwd();
  const candidates = [
    path.join(cwd, 'linked.backend.storage.ts'),
    path.join(cwd, 'linked.backend.storage.js'),
    path.join(cwd, 'backend-storage-config.ts'),
    path.join(cwd, 'backend-storage-config.js'),
    path.join(cwd, 'scripts', 'backend-storage-config.js'),
    path.join(cwd, 'scripts', 'backend-storage-config.ts'),
    path.join(cwd, 'scripts', 'storage-config.js'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      // Variable specifier is intentional — we discover the path at
      // runtime by probing the candidate list, so static analysis is
      // impossible.
      return importFile(candidate);
    }
  }
  console.warn(
    chalk.yellow(
      '[linked.backend.storage] no linked.backend.storage.{ts,js} found at app root.',
    ),
  );
  return undefined;
}

/**
 * A local package directory found by {@link discoverLocalPackages}, together
 * with the facts that decide what can be done with it.
 *
 * The facts are recorded rather than filtered on, because the bug this type
 * exists to fix was a SILENT filter: `build-all` discovered only packages
 * carrying `linkedPackage: true` and printed nothing about the rest, so
 * `@_linked/maps` — a shipped dependency that simply never got the flag — was
 * dropped from a green build for as long as nobody counted the names.
 */
export interface LocalPackage extends PackageDetails {
  /** Where the walk found it. */
  source: 'workspace' | 'local-packages-dir';
  /** `linkedPackage: true` — see `isLinkedPackageJson`. */
  isLinkedPackage: boolean;
  /** `linkedApp: true` — built by `linked build-app`, not `linked build`. */
  isApp: boolean;
  /** Has a `build` script of its own, which is what `build-all` invokes. */
  hasBuildScript: boolean;
}

/**
 * Directory holding localized checkouts (`linked localize`). An app set up by
 * `linked localize` lists `packages-local/*` in its `workspaces`, so a walk of
 * the globs finds them as workspace members; it is still walked on its own for
 * an app that has not been set up yet (no glob, or no `workspaces` at all).
 */
export const LOCAL_PACKAGES_DIR = LOCAL_DIR;

/**
 * Walk the app's `package.json` `workspaces` field and return every
 * workspace package that declares `"linkedPackage": true`.
 *
 * Lives here (not in cli-methods.ts) so consumers like LinkedServer can
 * import it without dragging the rest of the legacy cli-methods flow into
 * Vite's SSR module graph.
 *
 * Kept deliberately narrow: this is the set the dev resolver and the runtime
 * treat as linked packages. Commands that want every *buildable* local
 * package — flag or no flag, workspace or localized checkout — want
 * {@link discoverLocalPackages} instead.
 */
export function getLincdPackages(rootPath = process.cwd()): PackageDetails[] {
  return discoverLocalPackages(rootPath, {includeLocalPackagesDir: false})
    .filter((pkg) => pkg.isLinkedPackage)
    .map(({path: packagePath, packageName}) => ({
      path: packagePath,
      packageName,
    }));
}

/**
 * Every local package directory this app can see, whether or not it declares
 * `linkedPackage: true`.
 *
 * Two sources, because the workspace globs are not the whole picture any more:
 *
 *   1. the `workspaces` field (negations honoured — see ./workspace-globs.js),
 *      which includes `packages-local/*` in an app set up for localizing;
 *   2. `packages-local/`, the localized checkouts, for an app whose globs do
 *      not reach it. A checkout a glob already found is not added twice.
 *
 * Nothing is filtered out here. Callers decide what they can act on and are
 * expected to SAY what they skipped and why.
 */
export function discoverLocalPackages(
  rootPath = process.cwd(),
  options: {includeLocalPackagesDir?: boolean; localPackagesDir?: string} = {},
): LocalPackage[] {
  const {
    includeLocalPackagesDir = true,
    localPackagesDir = LOCAL_PACKAGES_DIR,
  } = options;

  let pack = getPackageJSON(rootPath);
  if (!pack || !pack.workspaces) {
    const originalRoot = rootPath;
    for (let i = 0; i <= 3; i++) {
      rootPath = path.join(originalRoot, ...Array(i).fill('..'));
      pack = getPackageJSON(rootPath);
      if (pack && pack.workspaces) break;
    }
    if (!pack || !pack.workspaces) {
      // Standalone apps (scaffolded with `linked create-app`) don't have
      // workspaces — expected. Fall back to the original root so a
      // `packages-local/` beside it is still found.
      rootPath = originalRoot;
    }
  }

  const res: LocalPackage[] = [];
  if (pack && pack.workspaces) {
    checkWorkspaces(rootPath, pack.workspaces, res);
  }
  if (includeLocalPackagesDir) {
    checkLocalPackagesDir(rootPath, localPackagesDir, res);
  }
  return res;
}

/**
 * Add every immediate subdirectory of `packages-local/` that holds a
 * `package.json`. No glob, no negations: the directory has no `workspaces`
 * entry to interpret, its contents are there because a developer localized
 * them on purpose, and each one is a plain checkout.
 */
function checkLocalPackagesDir(
  rootPath: string,
  localPackagesDir: string,
  res: LocalPackage[],
) {
  const dir = path.join(rootPath, localPackagesDir);
  if (!fs.existsSync(dir)) return;
  const already = new Set(res.map((pkg) => path.resolve(pkg.path)));
  for (const entry of fs.readdirSync(dir)) {
    if (entry.startsWith('.')) continue;
    const packagePath = path.join(dir, entry);
    if (!fs.statSync(packagePath).isDirectory()) continue;
    // A checkout a glob already picked up (`packages-local/*`) must not
    // appear twice — duplicates would be built twice and counted twice.
    if (already.has(path.resolve(packagePath))) continue;
    addPackage(packagePath, 'local-packages-dir', res);
  }
}

function checkWorkspaces(
  rootPath: string,
  workspaces: any,
  res: LocalPackage[],
) {
  // Negated entries ("!packages/core") are excluded the way npm excludes them
  // — including from the exact-path branch below, which npm also subjects to
  // them. See ./workspace-globs.js.
  const {patterns, negatedPatterns} = parseWorkspacePatterns(workspaces);
  const checkUnlessNegated = (packagePath: string) => {
    const rel = path.relative(rootPath, packagePath).split(path.sep).join('/');
    if (isWorkspacePathNegated(rel, negatedPatterns)) return;
    checkPackagePath(rootPath, packagePath, res);
  };
  patterns.forEach((workspace: string) => {
    const workspacePath = path.join(rootPath, workspace.replace('/*', ''));
    if (workspace.indexOf('/*') !== -1) {
      if (fs.existsSync(workspacePath)) {
        const folders = fs.readdirSync(workspacePath);
        folders.forEach((folder: string) => {
          if (folder !== './' && folder !== '../') {
            checkUnlessNegated(path.join(workspacePath, folder));
          }
        });
      }
    } else {
      checkUnlessNegated(workspacePath);
    }
  });
}

function checkPackagePath(
  rootPath: string,
  packagePath: string,
  res: LocalPackage[],
) {
  const packageJsonPath = path.join(packagePath, 'package.json');
  if (!fs.existsSync(packageJsonPath)) return;
  const pack = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  if (pack && pack.workspaces) {
    checkWorkspaces(packagePath, pack.workspaces, res);
  } else if (pack) {
    addPackage(packagePath, 'workspace', res, pack);
  }
}

function addPackage(
  packagePath: string,
  source: LocalPackage['source'],
  res: LocalPackage[],
  packageJson?: any,
) {
  const pack = packageJson ?? getPackageJSON(packagePath);
  if (!pack || !pack.name) return;
  res.push({
    path: packagePath,
    packageName: pack.name,
    source,
    // The one definition, shared with `linked build-package`.
    isLinkedPackage: isLinkedPackageJson(pack),
    isApp: pack.linkedApp === true,
    hasBuildScript: !!pack.scripts?.build,
  });
}

/**
 * Filters packages to only include those in the dependency tree of the app root
 */
function filterPackagesByDependencyTree(
  allPackages: Map<string, PackageDetails>,
  appRootPath: string,
): Map<string, PackageDetails> {
  const appPackageJson = getPackageJSON(appRootPath);
  if (!appPackageJson) {
    return allPackages;
  }

  const relevantPackages = new Map<string, PackageDetails>();
  const packagesToCheck = new Set<string>();

  // Start with direct dependencies from app root, plus everything localized:
  // a package created locally is linked but cannot be declared until it is
  // published (an unpublished range fails `npm install`), and being localized
  // already says this app is developed against it.
  [
    ...Object.keys(appPackageJson.dependencies || {}),
    ...localizedPackageNames(appRootPath),
  ].forEach((dep) => {
    if (allPackages.has(dep)) {
      packagesToCheck.add(dep);
    }
  });

  // Recursively add dependencies
  const processedPackages = new Set<string>();

  while (packagesToCheck.size > 0) {
    const packageName = Array.from(packagesToCheck)[0];
    packagesToCheck.delete(packageName);

    if (processedPackages.has(packageName)) {
      continue;
    }

    processedPackages.add(packageName);
    const packageDetails = allPackages.get(packageName);

    if (packageDetails) {
      relevantPackages.set(packageName, packageDetails);

      // Get this package's dependencies
      const packageJson = getPackageJSON(packageDetails.path);
      if (packageJson && packageJson.dependencies) {
        Object.keys(packageJson.dependencies).forEach((dep) => {
          if (allPackages.has(dep) && !processedPackages.has(dep)) {
            packagesToCheck.add(dep);
          }
        });
      }
    }
  }

  return relevantPackages;
}

/**
 * The names of the app's localized checkouts — every directory in
 * `packages-local/` with a named `package.json` (localize/members.ts). Nothing
 * there is simply "nothing localized".
 */
export function localizedPackageNames(appRootPath: string): string[] {
  return localMembers(appRootPath).map((member) => member.name);
}

/** A package `build-all` found but will not build, and why not. */
export interface SkippedPackage {
  packageName: string;
  path: string;
  reason: string;
}

/** What `build-all` found, and what it decided to do with each package. */
export interface BuildAllPlan {
  build: Map<string, PackageDetails>;
  skipped: SkippedPackage[];
}

/** The package whose `linked` bin the other packages' build scripts run. */
export const BUILD_TOOL_PACKAGE = '@_linked/cli';

/** Where `build-all` starts: everything in the groups before it is passed over. */
export type BuildToolStart = 'pre' | 'tool' | 'rest';

/** How `build-all` orders the build tool against everything else. */
export interface BuildToolOrder {
  /**
   * What the build tool depends on, transitively, among the packages to build
   * (a localized `@_linked/core`), in dependency order. Built before it.
   */
  pre: Map<string, PackageDetails>;
  /** The build tool, when it is among the packages to build. */
  tool?: PackageDetails;
  /** Everything else, built afterwards in dependency order. */
  rest: Map<string, PackageDetails>;
  /** The first group to build; the groups before it are passed over (`--from`). */
  start: BuildToolStart;
  /** The `--from` to apply inside `start` (`pre` or `rest`); unset when the build starts at its top. */
  from?: string;
}

/** The package names a package's `dependencies` field lists. */
function declaredDependencies(pkg: PackageDetails): string[] {
  return Object.keys(getPackageJSON(pkg.path, false)?.dependencies || {});
}

/**
 * Split the build around the build tool (`@_linked/cli`).
 *
 * Every other package's `build` script runs `linked build`, which is THIS
 * package's `lib/`. Built in parallel with them, its `rimraf ./lib` pulled that
 * `lib/` out from under their builds (`ENOENT …/lib/esm/installed-packages.js`),
 * and whatever was built before it ran a stale cli. So when it is in the set it
 * is built alone, and the rest only once it has succeeded.
 *
 * It cannot be built FIRST, though: a localized `@_linked/core` it depends on
 * must have its `lib/` before the tool's `tsc` runs. So the tool's own
 * dependencies among the packages to build (`pre`, the transitive closure of
 * `dependencies`) go before it, in dependency order. They build with the tool
 * as it was before this run, which is what a fresh checkout's `npm run build`
 * does too.
 *
 * `--from` reads the order as `pre`, then the tool, then `rest`: it resumes
 * inside whichever group holds the package and passes over the groups before
 * it. A name in none of them goes to `rest`, which reports it.
 */
export function orderBuildToolFirst(
  packages: Map<string, PackageDetails>,
  from?: string,
  dependenciesOf: (pkg: PackageDetails) => string[] = declaredDependencies,
): BuildToolOrder {
  const tool = packages.get(BUILD_TOOL_PACKAGE);
  if (!tool) {
    return {pre: new Map(), rest: packages, start: from ? 'rest' : 'pre', from};
  }

  // Depth-first, dependencies before dependents, so `pre` is in build order.
  // A cycle back to the tool (or within `pre`) is cut where it closes.
  const pre = new Map<string, PackageDetails>();
  const visiting = new Set<string>([BUILD_TOOL_PACKAGE]);
  const visit = (pkg: PackageDetails) => {
    for (const dep of dependenciesOf(pkg)) {
      const depPkg = packages.get(dep);
      if (!depPkg || visiting.has(dep) || pre.has(dep)) continue;
      visiting.add(dep);
      visit(depPkg);
      pre.set(dep, depPkg);
    }
  };
  visit(tool);

  const rest = new Map(packages);
  rest.delete(BUILD_TOOL_PACKAGE);
  for (const name of pre.keys()) rest.delete(name);

  if (!from) return {pre, tool, rest, start: 'pre'};
  if (pre.has(from)) return {pre, tool, rest, start: 'pre', from};
  if (from === BUILD_TOOL_PACKAGE) return {pre, tool, rest, start: 'tool'};
  return {pre, tool, rest, start: 'rest', from};
}

/**
 * Decide what `build-all` builds.
 *
 * Every discovered package lands in exactly one of `build` or `skipped`, and
 * `skipped` carries a reason — because the failure mode this replaces was not
 * a narrow scan, it was a SILENT one. `@_linked/maps` is a shipped Create Now
 * dependency that never got `linkedPackage: true`; `build-all` dropped it and
 * printed nothing, so a build covering half the workspace exited 0 and people
 * acted on it. A skip nobody can see is worse than a failure.
 *
 * What counts as buildable is a CAPABILITY, not a declaration: `build-all`
 * invokes each package's own `build` script, so anything with one can be
 * built whether or not it carries the flag. The flag is still reported when
 * it is missing, since the dev resolver and `linked build` do require it.
 */
export function planBuildAll(rootPath = './', appRoot?: string): BuildAllPlan {
  const build = new Map<string, PackageDetails>();
  const skipped: SkippedPackage[] = [];
  const buildable: LocalPackage[] = [];

  for (const pkg of discoverLocalPackages(rootPath)) {
    const detail = {path: pkg.path, packageName: pkg.packageName};
    // Packages reached through a `../` workspace glob live outside this
    // repository; building them was never in scope for `build-all`.
    if (pkg.path.indexOf('../') !== -1 || pkg.path.indexOf('..\\') !== -1) {
      skipped.push({...detail, reason: 'outside this repository'});
    } else if (pkg.isApp) {
      skipped.push({
        ...detail,
        reason: 'is a linked app — build it with `linked build-app`',
      });
    } else if (!pkg.hasBuildScript) {
      skipped.push({...detail, reason: 'has no `build` script'});
    } else {
      buildable.push(pkg);
      build.set(pkg.packageName, detail);
    }
  }

  // Narrow to what this app actually depends on, if we are inside one.
  if (appRoot) {
    const appPackageJson = getPackageJSON(appRoot);
    const isAppWithLinkedDeps =
      appPackageJson &&
      !isLinkedPackageJson(appPackageJson) &&
      [
        ...Object.keys(appPackageJson.dependencies || {}),
        ...localizedPackageNames(appRoot),
      ].some((dep) => build.has(dep));

    if (isAppWithLinkedDeps) {
      const inTree = filterPackagesByDependencyTree(build, appRoot);
      for (const pkg of buildable) {
        if (inTree.has(pkg.packageName)) continue;
        build.delete(pkg.packageName);
        skipped.push({
          path: pkg.path,
          packageName: pkg.packageName,
          reason: `not in ${appPackageJson.name || 'this app'}'s dependency tree`,
        });
      }
    }
  }

  return {build, skipped};
}
