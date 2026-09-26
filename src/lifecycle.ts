// Lifecycle helpers shared by the Vite-based dev orchestrator.
//
// Extracted from cli-methods.ts so the SSR module graph (started from
// `commands/start.ts`) doesn't have to walk the rest of that file. The
// legacy webpack-era helpers in cli-methods.ts contain many dynamic
// `import(<variable>)` calls Vite can't analyze statically and would
// emit warnings about — even though startWithVite never calls them.

import fs from 'fs-extra';
import path from 'path';
import chalk from 'chalk';
import {getPackageJSON} from './utils.js';
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
 * Walk the app's `package.json` `workspaces` field and return every
 * workspace package that declares `"linkedPackage": true`.
 *
 * Lives here (not in cli-methods.ts) so consumers like LinkedServer can
 * import it without dragging the rest of the legacy webpack flow into
 * Vite's SSR module graph.
 */
export function getLincdPackages(
  rootPath = process.cwd(),
): PackageDetails[] {
  let pack = getPackageJSON(rootPath);
  if (!pack || !pack.workspaces) {
    const originalRoot = rootPath;
    for (let i = 0; i <= 3; i++) {
      rootPath = path.join(originalRoot, ...Array(i).fill('..'));
      pack = getPackageJSON(rootPath);
      if (pack && pack.workspaces) break;
    }
  }
  if (!pack || !pack.workspaces) {
    // Standalone apps (scaffolded with `linked create-app`) don't have
    // workspaces — expected; just no local packages to scan.
    return [];
  }
  const res: PackageDetails[] = [];
  checkWorkspaces(rootPath, pack.workspaces, res);
  return res;
}

function checkWorkspaces(rootPath: string, workspaces: any, res: PackageDetails[]) {
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

function checkPackagePath(rootPath: string, packagePath: string, res: PackageDetails[]) {
  const packageJsonPath = path.join(packagePath, 'package.json');
  if (!fs.existsSync(packageJsonPath)) return;
  const pack = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  if (pack && pack.workspaces) {
    checkWorkspaces(packagePath, pack.workspaces, res);
  } else if (pack && pack.linkedPackage === true) {
    res.push({path: packagePath, packageName: pack.name});
  }
}
