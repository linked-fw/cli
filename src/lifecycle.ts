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
import {parseWorkspacePatterns, isWorkspacePathNegated} from './workspace-globs.js';
import type {PackageDetails} from './interfaces.js';

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

const readEnvNamesFromArgv = (): string[] => {
  const args = process.argv.slice(2);
  const envIndex = args.indexOf('--env');
  if (envIndex === -1) return [];
  return (args[envIndex + 1] || '').split(',').filter(Boolean);
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
      return import(/* @vite-ignore */ candidate);
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
  /** `linkedPackage: true`, or the legacy `lincd: true`. */
  isLinkedPackage: boolean;
  /** `linkedApp: true` — built by `linked build-app`, not `linked build`. */
  isApp: boolean;
  /** Has a `build` script of its own, which is what `build-all` invokes. */
  hasBuildScript: boolean;
}

/**
 * Directory holding localized checkouts (`linked localize`). It is
 * deliberately in NO workspace glob — that is the whole point of the design,
 * since npm learning about these checkouts is what made their predecessor
 * under `packages/` a trap — so any walk of `workspaces` alone cannot see it
 * and has to be told about it separately.
 */
export const LOCAL_PACKAGES_DIR = 'packages-local';

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
export function getLincdPackages(
  rootPath = process.cwd(),
): PackageDetails[] {
  return discoverLocalPackages(rootPath, {includeLocalPackagesDir: false})
    .filter((pkg) => pkg.isLinkedPackage)
    .map(({path: packagePath, packageName}) => ({path: packagePath, packageName}));
}

/**
 * Every local package directory this app can see, whether or not it declares
 * `linkedPackage: true`.
 *
 * Two sources, because the workspace globs are not the whole picture any more:
 *
 *   1. the `workspaces` field (negations honoured — see ./workspace-globs.js);
 *   2. `packages-local/`, the localized checkouts, which is in no glob.
 *
 * Nothing is filtered out here. Callers decide what they can act on and are
 * expected to SAY what they skipped and why.
 */
export function discoverLocalPackages(
  rootPath = process.cwd(),
  options: {includeLocalPackagesDir?: boolean; localPackagesDir?: string} = {},
): LocalPackage[] {
  const {includeLocalPackagesDir = true, localPackagesDir = LOCAL_PACKAGES_DIR} =
    options;

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
    // A checkout that some glob already picked up must not appear twice —
    // duplicates would be built twice and counted twice.
    if (already.has(path.resolve(packagePath))) continue;
    addPackage(packagePath, 'local-packages-dir', res);
  }
}

function checkWorkspaces(rootPath: string, workspaces: any, res: LocalPackage[]) {
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

function checkPackagePath(rootPath: string, packagePath: string, res: LocalPackage[]) {
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
    // `lincd: true` is the pre-rename spelling of the same flag and is still
    // honoured by `linked build-package`; honouring it here too keeps the two
    // from disagreeing about what a linked package is.
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
 * localize's manifest filename (`MANIFEST_FILENAME` in `@_linked/localize`).
 * Repeated rather than imported: that package is ESM-only and loaded lazily,
 * and this runs synchronously while planning a build.
 */
const LOCALIZE_MANIFEST = 'local-packages.json';

/**
 * The package names recorded in the app's `local-packages.json` — what
 * `linked localize` has linked. Read tolerantly: localize owns that file and
 * refuses a malformed one loudly, so here a missing or unreadable file is
 * simply "nothing localized".
 */
export function localizedPackageNames(appRootPath: string): string[] {
  try {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(appRootPath, LOCALIZE_MANIFEST), 'utf8'),
    );
    const packages = manifest?.packages;
    return packages && typeof packages === 'object' && !Array.isArray(packages)
      ? Object.keys(packages)
      : [];
  } catch {
    return [];
  }
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
      appPackageJson.lincd !== true &&
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

