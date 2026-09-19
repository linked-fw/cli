import chalk from 'chalk';
import {exec} from 'child_process';
import depcheck from 'depcheck';
import {getEnvFile} from 'env-cmd/dist/get-env-vars.js';
import fs from 'fs-extra';
import path, {dirname} from 'path';
import {createInterface} from 'readline';
import {
  debugInfo,
  execp,
  execPromise,
  getFileImports,
  getFiles,
  getLastCommitTime,
  getPackageJSON,
  isImportOutsideOfPackage,
  isInternalLinkedImport,
  needsRebuilding,
} from './utils.js';
import {renameShippedDotfiles} from './utils/shippedDotfiles.js';
import {planPackageSetup} from './utils/packageSetup.js';
import {
  detectPackageManager,
  execBinCommand,
  runScriptCommand,
} from './utils/packageManager.js';
import {rewriteExtensionlessImports} from './utils/esmSpecifiers.js';

import {spawn as spawnChild} from 'child_process';
import {findNearestPackageJson} from 'find-nearest-package-json';
import {statSync} from 'fs';
import {LinkedFileStorage} from '@_linked/core/utils/LinkedFileStorage';
import type {PackageDetails} from './interfaces.js';
// import pkg from 'lincd/utils/LinkedFileStorage';
// const { LinkedFileStorage } = pkg;
// const config = require('@_linked/server/site.webpack.config');
import {glob} from 'glob';
import webpack from 'webpack';

import ora, {Ora} from 'ora';
import stagedGitFiles from 'staged-git-files';

let dirname__ =
  typeof __dirname !== 'undefined'
    ? __dirname
    : //@ts-ignore
      dirname(import.meta.url).replace('file:/', '');

/**
 * Dynamically import the app's backend storage configuration. Tries the
 * canonical `linked.backend.storage.{ts,js}` at app root first, then the
 * earlier `backend-storage-config.{ts,js}` (Iter3), then the legacy
 * `scripts/storage-config.js` (pre-rename). The fallback chain lets older
 * app clones keep booting through the rename.
 */
// Extracted to ./lifecycle.ts so the Vite SSR loader doesn't
// have to graph-walk the rest of cli-methods.ts (which contains many
// dynamic imports Vite can't analyze). We import for internal callers
// AND re-export so external consumers can keep importing from here.
import {
  ensureEnvironmentLoaded,
  loadBackendStorageConfig,
  getLincdPackages,
} from './lifecycle.js';
export {ensureEnvironmentLoaded, loadBackendStorageConfig, getLincdPackages};

var variables = {};
/**
 * Prompt user for input
 */
function promptUser(question: string): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(chalk.cyan(question), (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

export type AppTemplate = 'web' | 'react-native';

type AppIdentity = {
  appName: string;
  appPrefix: string;
  appDomain: string;
  hyphenName: string;
};

export const createApp = async (name, basePath = process.cwd(), options: {appName?: string, appPrefix?: string, appDomain?: string, skipInstall?: boolean, template?: AppTemplate} = {}) => {
  // Reject unknown templates before prompting or writing anything.
  const template = options.template;
  if (
    template !== undefined &&
    template !== 'web' &&
    template !== 'react-native'
  ) {
    console.warn(
      chalk.red(`Unknown template "${template}". Use "web" or "react-native".`),
    );
    return;
  }

  // If no name provided, prompt for folder name first
  if (!name) {
    console.log(chalk.blue('\n📁 Folder name for your app:\n'));
    const folderNameInput = await promptUser('Folder name (e.g., "my-app"): ');
    if (!folderNameInput || !folderNameInput.trim()) {
      console.warn(chalk.red('Folder name is required. Aborting.'));
      return;
    }
    name = folderNameInput.trim();
  }

  let {hyphenName, camelCaseName, underscoreName} = setNameVariables(name);

  const defaultAppName = name
    .split(/[-_\s]+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
  const defaultAppPrefix = underscoreName;
  const defaultAppDomain = hyphenName + '.com';

  let appName: string;
  let appPrefix: string;
  let appDomain: string;

  // If any options provided, skip interactive prompts
  if (options.appName || options.appPrefix || options.appDomain) {
    appName = options.appName || defaultAppName;
    appPrefix = options.appPrefix || defaultAppPrefix;
    appDomain = options.appDomain || defaultAppDomain;
  } else {
    // Prompt user for app configuration
    console.log(chalk.blue('\n📝 Please provide the following information:\n'));
    console.log(
      chalk.gray('(Press Enter to use defaults based on folder name)\n'),
    );

    const appNameInput = await promptUser(
      `App Name (display name) [${chalk.gray(defaultAppName)}]: `,
    );
    const appPrefixInput = await promptUser(
      `App Prefix (short code for data files, e.g., "myapp") [${chalk.gray(defaultAppPrefix)}]: `,
    );
    const appDomainInput = await promptUser(
      `App Domain [${chalk.gray(defaultAppDomain)}]: `,
    );

    appName = appNameInput || defaultAppName;
    appPrefix = appPrefixInput || defaultAppPrefix;
    appDomain = appDomainInput || defaultAppDomain;
  }

  // Set new variables for app configuration
  setVariable('app_name', appName);
  setVariable('app_prefix', appPrefix);
  setVariable('app_domain', appDomain);

  let targetFolder = path.join(basePath, hyphenName);

  if (template === 'react-native') {
    // Called through reactNativeInternals so tests can stub the scaffold step.
    await reactNativeInternals.scaffoldReactNativeApp(
      targetFolder,
      {appName, appPrefix, appDomain, hyphenName},
      {skipInstall: options.skipInstall},
    );
    return;
  }

  if (!fs.existsSync(targetFolder)) {
    fs.mkdirSync(targetFolder);
  }

  // Scaffold from the canonical template repo (single source of truth; CN's
  // server-side createProject clones the same repo). Shallow clone, then drop
  // .git so the new app starts with clean history.
  await execPromise(`git clone --depth 1 https://github.com/linked-fw/app-template.git "${targetFolder}"`, false, false);
  fs.removeSync(path.join(targetFolder, '.git'));
  //make sure the data folder exists (even though its empty).. copying empty folders does not work with fs.copySync
  fs.mkdirSync(path.join(targetFolder, 'data'), {recursive: true});
  fs.mkdirSync(path.join(targetFolder, 'data/uploads/resized'), {
    recursive: true,
  });

  // The template repo now ships real dotfiles; guard the legacy
  // `*.template` renames so they no-op when the dotfile already exists.
  const gitignoreTemplate = path.join(targetFolder, 'gitignore.template');
  if (fs.existsSync(gitignoreTemplate)) {
    fs.renameSync(gitignoreTemplate, path.join(targetFolder, '.gitignore'));
  }
  stripYarnProjectFiles(targetFolder);

  // Seed the real (gitignored) Layer 2 config from the committed example so
  // the scaffolded app boots first try. Users can edit either file later.
  const datasetsExample = path.join(
    targetFolder,
    'linked.backend.datasets.example.json',
  );
  const datasetsReal = path.join(targetFolder, 'linked.backend.datasets.json');
  if (fs.existsSync(datasetsExample) && !fs.existsSync(datasetsReal)) {
    fs.copySync(datasetsExample, datasetsReal);
  }

  // fs.copySync(path.join(__dirname, '..', 'defaults', 'app'), targetFolder);

  log("Creating new Linked app '" + appName + "'");

  //replace variables in some copied files
  await replaceVariablesInFolder(targetFolder);

  // The template ships placeholder-free (so a raw clone boots on defaults), so
  // create-app stamps this app's identity into the clone directly rather than
  // relying on ${var} substitution.
  applyAppIdentity(targetFolder, {appName, appPrefix, hyphenName});

  // New apps are npm apps: npm is the package manager the templates, the CI
  // workflows and the published @_linked/* packages are all tested against, and
  // the react-native template already installs with npm. Keeping a single
  // package manager also keeps the scaffolded app to a single lockfile.
  const pm: PackageManager = CREATE_APP_PACKAGE_MANAGER;

  if (!options.skipInstall) {
    const installCommand = installCommandFor(pm);

    const spinner = ora({
      text: `Installing dependencies (${pm})...`,
      spinner: 'dots',
    }).start();

    const {stdout, stderr, failed} = await new Promise<{
      stdout: string;
      stderr: string;
      failed: boolean;
    }>((resolve) => {
      exec(
        `cd ${hyphenName} && ${installCommand}`,
        {maxBuffer: 50 * 1024 * 1024} as any,
        (error, out, err) => {
          resolve({
            stdout: typeof out === 'string' ? out : out?.toString() ?? '',
            stderr: typeof err === 'string' ? err : err?.toString() ?? '',
            failed: !!error,
          });
        },
      );
    });

    if (failed) {
      spinner.fail('Could not install dependencies');
      if (stdout) process.stdout.write(stdout);
      if (stderr) process.stderr.write(stderr);
    } else {
      spinner.succeed(`Dependencies installed (${pm})`);
      // Even on a 0-exit install, surface stderr (peer-dep warnings,
      // deprecations, ERESOLVE warns). Silent installs hide real problems
      // that bite users the next time they touch the lockfile.
      if (stderr && stderr.trim()) {
        process.stderr.write(stderr);
      }
    }
  }

  const startCommand = startCommandFor(pm);

  log(
    `Your Linked app is ready at ${chalk.blueBright(targetFolder)}`,
    `\nStorage: linked.backend.storage.ts wires aliases to stores; linked.backend.datasets.json holds endpoints.`,
    `Defaults to Fuseki at ${chalk.cyan('http://localhost:3030')} (auto-creates the dataset on first boot).`,
    `Make sure Fuseki is running, e.g.:`,
    `  ${chalk.blueBright('docker run -d --rm -p 3030:3030 --name fuseki stain/jena-fuseki')}`,
    `Edit ${chalk.cyan('linked.backend.datasets.json')} to change endpoints or credentials.`,
    `Mirror file for the frontend: ${chalk.cyan('src/linked.frontend.storage.ts')} + ${chalk.cyan('src/linked.frontend.datasets.json')}.`,
    `\nTo start:`,
    `  ${chalk.blueBright(`cd ${hyphenName} && ${startCommand}`)}`,
  );
};

/**
 * iOS bundle identifier from the app domain and prefix:
 * ('example.com', 'demo') -> 'com.example.demo'.
 */
export function reactNativeBundleId(
  appDomain: string,
  appPrefix: string,
): string {
  const host = appDomain
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .split(/[/?#]/)[0]
    .replace(/:\d*$/, '');
  const hostLabels = host.split('.').filter(Boolean);
  // A bare host such as `localhost` gets a `com` top level: com.localhost.<prefix>.
  if (hostLabels.length === 1) hostLabels.push('com');
  return [...hostLabels.reverse(), appPrefix.toLowerCase()]
    .map((label) => label.replace(/_/g, '-').replace(/[^a-z0-9-]/g, ''))
    .filter(Boolean)
    .join('.');
}

/**
 * The prefix becomes a directory, an npm package name, a bundle-ID label and a
 * literal inside a Jest regex; this form is valid in all four unescaped.
 */
export const RN_PREFIX_PATTERN = /^[a-z][a-z0-9-]*$/;

/** Throws when the prefix is invalid or the target folder is non-empty. */
function assertReactNativeScaffoldable(targetFolder: string, appPrefix: string) {
  if (typeof appPrefix !== 'string' || !RN_PREFIX_PATTERN.test(appPrefix)) {
    throw new Error(
      `Invalid app prefix "${appPrefix ?? ''}": it must match ${RN_PREFIX_PATTERN.source} ` +
        '(start with a lowercase letter; only lowercase letters, digits and hyphens).',
    );
  }
  if (fs.existsSync(targetFolder) && fs.readdirSync(targetFolder).length > 0) {
    throw new Error(
      `Target folder ${targetFolder} already exists and is not empty. ` +
        'Choose another name or remove the folder.',
    );
  }
}

/** Placeholder name of the shapes package in defaults/app-react-native. */
export const RN_SHAPES_TOKEN = 'app-shapes';

/**
 * Literal tokens in defaults/app-react-native that are replaced by names
 * derived from the app prefix: the shapes package and the Fuseki datasets.
 */
export function reactNativeTokens(appPrefix: string): Record<string, string> {
  return {
    [RN_SHAPES_TOKEN]: `${appPrefix}-shapes`,
    'app-dev': `${appPrefix}-dev`,
    'app-test': `${appPrefix}-test`,
  };
}

/**
 * Replace every occurrence of `token` in the text files under `folder`
 * (node_modules and files containing a NUL byte are skipped). A literal token
 * replacement, not the ${...} variable substitution.
 */
function replaceTokenInTextFiles(folder: string, token: string, value: string) {
  if (token === value) return;
  for (const entry of fs.readdirSync(folder, {withFileTypes: true})) {
    const full = path.join(folder, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && entry.name !== '.git') {
        replaceTokenInTextFiles(full, token, value);
      }
    } else if (entry.isFile()) {
      const buffer = fs.readFileSync(full);
      if (buffer.includes(0)) continue;
      const text = buffer.toString('utf8');
      if (text.includes(token)) {
        fs.writeFileSync(full, text.split(token).join(value));
      }
    }
  }
}

const readJSON = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));
const writeJSON = (file: string, data: any) =>
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');

/**
 * Scaffold the React Native monorepo from defaults/app-react-native.
 * Identity is stamped into named fields only; the global ${...} substitution
 * (replaceVariablesInFolder) is never used, so template literals in TypeScript
 * sources stay intact.
 */
export async function scaffoldReactNativeApp(
  targetFolder: string,
  id: AppIdentity,
  options: {skipInstall?: boolean; templateDir?: string} = {},
): Promise<void> {
  const {appName, appPrefix, appDomain, hyphenName} = id;
  // Validate before writing anything.
  assertReactNativeScaffoldable(targetFolder, appPrefix);
  // lib/esm/ (built) is two levels below the package root; src/ (Jest) is one.
  const templateDir =
    options.templateDir ||
    [
      path.join(getScriptDir(), '..', '..', 'defaults', 'app-react-native'),
      path.join(getScriptDir(), '..', 'defaults', 'app-react-native'),
    ].find((dir) => fs.existsSync(dir));
  if (!templateDir) {
    throw new Error('React Native template not found (defaults/app-react-native)');
  }
  const shapesName = `${appPrefix}-shapes`;

  log("Creating new Linked React Native app '" + appName + "'");

  // 1. Copy the template.
  fs.copySync(templateDir, targetFolder);

  // 2. Restore dotfiles npm would strip from the CLI tarball.
  renameShippedDotfiles(targetFolder);

  // 3. Rename the shapes package directory.
  const oldShapesDir = path.join(targetFolder, 'packages', RN_SHAPES_TOKEN);
  const shapesDir = path.join(targetFolder, 'packages', shapesName);
  if (fs.existsSync(oldShapesDir) && oldShapesDir !== shapesDir) {
    fs.renameSync(oldShapesDir, shapesDir);
  }

  // 4a. Rename the shapes package token everywhere: workspaces, .gitignore
  // negation, package names, dependency keys, Jest patterns, import specifiers,
  // test expectations and docs. The Fuseki dataset tokens (`app-dev`,
  // `app-test`) are replaced the same way. Only these literal tokens change.
  for (const [token, value] of Object.entries(reactNativeTokens(appPrefix))) {
    replaceTokenInTextFiles(targetFolder, token, value);
  }

  // 4b. Stamp the identity fields that are not the shapes token.
  const rootPkgPath = path.join(targetFolder, 'package.json');
  if (fs.existsSync(rootPkgPath)) {
    const rootPkg = readJSON(rootPkgPath);
    rootPkg.name = `${hyphenName}-monorepo`;
    writeJSON(rootPkgPath, rootPkg);
  }

  const mobileDir = path.join(targetFolder, 'apps', 'mobile');
  const appJsonPath = path.join(mobileDir, 'app.json');
  if (fs.existsSync(appJsonPath)) {
    const appJson = readJSON(appJsonPath);
    appJson.expo = appJson.expo || {};
    appJson.expo.name = appName;
    appJson.expo.slug = hyphenName;
    appJson.expo.ios = appJson.expo.ios || {};
    appJson.expo.ios.bundleIdentifier = reactNativeBundleId(
      appDomain,
      appPrefix,
    );
    writeJSON(appJsonPath, appJson);
  }

  // 5. Install with npm: the template is an npm workspaces monorepo.
  if (!options.skipInstall) {
    const spinner = ora({
      text: 'Installing dependencies (npm)...',
      spinner: 'dots',
    }).start();
    try {
      await execPromise('npm install', false, false, {
        cwd: targetFolder,
        maxBuffer: 50 * 1024 * 1024,
      });
      spinner.succeed('Dependencies installed (npm)');
    } catch (err) {
      spinner.fail('Could not install dependencies');
      if (err?.stdout) process.stdout.write(err.stdout);
      if (err?.stderr) process.stderr.write(err.stderr);
      throw new Error(
        `npm install failed. The files are in ${targetFolder}; ` +
          `run \`npm install\` there to retry.`,
      );
    }
  }

  // 6. Next steps.
  log(
    `Your Linked React Native app is ready at ${chalk.blueBright(targetFolder)}`,
    `\nNext steps:`,
    `  ${chalk.blueBright(`cd ${path.basename(targetFolder)}`)}`,
    `  ${chalk.blueBright('npm test')}                                        app and API unit tests`,
    `  ${chalk.blueBright('cp services/api/.env.example services/api/.env')}  once`,
    `  ${chalk.blueBright('npm run fuseki:up')}                               Fuseki on :3030 (Docker)`,
    `  ${chalk.blueBright('npm run api')}                                     API-only backend on :4000`,
    `  ${chalk.blueBright('npm run test:integration')}                        round trip against Fuseki`,
    `  ${chalk.blueBright('cd apps/mobile && npx expo run:ios')}`,
    `See README.md (and services/api/README.md if port 3030 is taken).`,
  );
}

// Indirection so tests can replace the scaffold step when exercising createApp.
export const reactNativeInternals = {scaffoldReactNativeApp};

/** Set or append a `KEY=value` line in a `.env`-style text blob. */
function setEnvVar(envText: string, key: string, value: string): string {
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, 'm');
  return re.test(envText)
    ? envText.replace(re, line)
    : envText.replace(/\n?$/, `\n${line}\n`);
}

/**
 * Stamp the new app's identity into the freshly-cloned template. The template
 * ships without `${var}` placeholders (so a raw CN clone boots on defaults), so
 * create-app writes the real per-app values here:
 *  - `.env.example` (committed defaults for this app) + `.env` (local): APP_NAME
 *    drives the display name; APP_PREFIX names data files.
 *  - `package.json`: `name` (hyphenated id) + `displayName` (human name).
 *  - `src/package.ts`: the runtime `linkedPackage` id — shape URIs derive from it.
 *  - pm2 process names + the VS Code launch name (cosmetic, but should match).
 */
/**
 * Scaffolded apps are npm apps, so the new app must not also look like a yarn
 * project. Removes every yarn project file a template clone may still carry —
 * including the legacy `yarnrc.yml.template` that create-app used to rename
 * into `.yarnrc.yml`. (No empty `yarn.lock` is written any more either; that
 * file only existed to pin down Yarn's project-root search.)
 */
export function stripYarnProjectFiles(targetFolder: string) {
  for (const yarnLeftover of [
    'yarnrc.yml.template',
    '.yarnrc.yml',
    '.yarn',
    'yarn.lock',
  ]) {
    fs.removeSync(path.join(targetFolder, yarnLeftover));
  }
}

function applyAppIdentity(
  targetFolder: string,
  ids: {appName: string; appPrefix: string; hyphenName: string},
) {
  const {appName, appPrefix, hyphenName} = ids;

  // 1. .env.example (+ seed .env from it so the first `npm start` is correct).
  const envExample = path.join(targetFolder, '.env.example');
  if (fs.existsSync(envExample)) {
    let env = fs.readFileSync(envExample, 'utf8');
    env = setEnvVar(env, 'APP_NAME', appName);
    env = setEnvVar(env, 'APP_PREFIX', appPrefix);
    fs.writeFileSync(envExample, env);
    const envReal = path.join(targetFolder, '.env');
    if (!fs.existsSync(envReal)) fs.writeFileSync(envReal, env);
  }

  // 2. package.json — name + displayName.
  const pkgPath = path.join(targetFolder, 'package.json');
  if (fs.existsSync(pkgPath)) {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    pkg.name = hyphenName;
    pkg.displayName = appName;
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  }

  // 3. src/package.ts — the runtime linkedPackage id.
  const packageTs = path.join(targetFolder, 'src', 'package.ts');
  if (fs.existsSync(packageTs)) {
    const src = fs.readFileSync(packageTs, 'utf8');
    fs.writeFileSync(
      packageTs,
      src.replace(
        /linkedPackage\(\s*['"][^'"]*['"]\s*\)/,
        `linkedPackage('${hyphenName}')`,
      ),
    );
  }

  // 4. pm2 process names + VS Code launch name (template hardcodes 'app').
  const renames: Array<[string, RegExp, string]> = [
    ['pm2.config.js', /name:\s*'app'/, `name: '${hyphenName}'`],
    ['pm2-staging.config.js', /name:\s*'app-staging'/, `name: '${hyphenName}-staging'`],
    [path.join('.vscode', 'launch.json'), /"name":\s*"Run app"/, `"name": "Run ${hyphenName}"`],
  ];
  for (const [rel, re, replacement] of renames) {
    const f = path.join(targetFolder, rel);
    if (!fs.existsSync(f)) continue;
    fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(re, replacement));
  }
}

function logHelp() {
  execp(execBinCommand(detectPackageManager(), 'linked help'));
}

function log(...messages) {
  messages.forEach((message) => {
    console.log(chalk.cyan('Info: ') + message);
  });
}

function progressUpdate(message) {
  process.stdout.write(
    '                                                                    \r',
  );
  process.stdout.write(message + '\r');
}

export function warn(...messages) {
  messages.forEach((message) => {
    console.warn(chalk.redBright('Warning: ') + message);
    // console.log(chalk.red(message));
  });
}
export function logError(...errors) {
  errors.forEach((error:Error) => {
    console.error(chalk.redBright('Error: ') + error);
  });
}
export function developPackage(target, mode) {
  if (!target) target = 'es6';
  if (mode !== 'production') mode = '';
  else if (target !== 'es6')
    log('target must be es6 when developing for production');
  if (target == 'es5' || target == 'es6') {
    // log('> Starting continuous development build for '+target+' target')
    log('starting continuous development build');
    log(
      'grunt dev' +
        (target ? '-' + target : '') +
        (mode ? '-' + mode : '') +
        ' --color',
    );
    var command = exec(
      'grunt dev' +
        (target ? '-' + target : '') +
        (mode ? '-' + mode : '') +
        ' --color',
    );
    command.stdout.pipe(process.stdout);
    command.stderr.pipe(process.stderr);
  } else {
    console.warn('unknown build target. Use es5 or es6');
  }
}

function checkWorkspaces(rootPath, workspaces, res) {
  // console.log('checking workspaces at '+rootPath+": "+workspaces.toString());
  if (workspaces.packages) {
    workspaces = workspaces.packages;
  }

  workspaces.forEach((workspace) => {
    let workspacePath = path.join(rootPath, workspace.replace('/*', ''));
    if (workspace.indexOf('/*') !== -1) {
      // console.log(workspacePath);
      if (fs.existsSync(workspacePath)) {
        let folders = fs.readdirSync(workspacePath);
        folders.forEach((folder) => {
          if (folder !== './' && folder !== '../') {
            checkPackagePath(rootPath, path.join(workspacePath, folder), res);
          }
        });
      }
    } else {
      checkPackagePath(rootPath, workspacePath, res);
    }
  });
}

function checkPackagePath(rootPath, packagePath, res) {
  let packageJsonPath = path.join(packagePath, 'package.json');
  // console.log('checking '+packagePath);
  if (fs.existsSync(packageJsonPath)) {
    var pack = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    //some packages are not true lincd packages, but we still want them to be re-built automatically. This is what lincd_util is for
    if (pack && pack.workspaces) {
      checkWorkspaces(packagePath, pack.workspaces, res);
    } else if (pack && pack.linkedPackage === true) {
      res.push({
        path: packagePath,
        packageName: pack.name,
      });
    }
  }
}

export function runOnPackagesGroupedByDependencies(
  lincdPackages,
  onBuildStack: (
    packageGroup,
    dependencies,
  ) => (pkg: PackageDetails) => Promise<any>,
  onStackEnd,
  sync = false,
): Promise<void> {
  let dependencies: Map<PackageDetails, PackageDetails[]> = new Map();

  let res, rej;
  const deferredPromise = new Promise<void>((resolve, reject) => {
    res = resolve;
    rej = reject;
  });
  //get dependencies of each package
  let leastDependentPackage;
  lincdPackages.forEach((pkg) => {
    var pack = getPackageJSON(pkg.path);
    if (pack) {
      //get lincd related dependencies and get the actual package details from the package map by removing '@dacore/' from the package name
      let packageDependencies = Object.keys(pack.dependencies || {})
        .filter((dependency) => lincdPackages.has(dependency))
        .map((dependency) => {
          return lincdPackages.has(dependency)
            ? lincdPackages.get(dependency)
            : dependency;
        });
      // console.log(package.packageName,packageDependencies.map())
      dependencies.set(pkg, packageDependencies);
    }
  });

  dependencies.forEach((PackageDependencies, pkg) => {
    if (
      !PackageDependencies.some((dependency) => {
        return (
          typeof dependency !== 'string' &&
          lincdPackages.has(dependency.packageName)
        );
      })
    ) {
      leastDependentPackage = pkg;
    }
  });

  let startStack: PackageDetails[] = leastDependentPackage
    ? [leastDependentPackage]
    : [];

  const runPackage = async (runFunction, pck) => {
    try {
      const result = await runFunction(pck);
      done.add(pck);
      return result;
    } catch (errorObj) {
      if (errorObj.error) {
        let {error, stdout, stderr} = errorObj;
        warn(
          'Uncaught exception whilst running parallel function on ' +
            pck.packageName,
          error?.message ? error.message : error?.toString(),
          // stdout,
          // stderr,
        );
      } else {
        warn(
          'Uncaught exception whilst running parallel function on ' +
            pck.packageName,
          errorObj?.toString(),
          // stdout,
          // stderr,
        );
        process.exit();
      }
      // warn(chalk.red(pck.packageName+' failed:'));
      // console.log(stdout);
      done.add(pck);
      return undefined;
    }
  };

  let done: Set<PackageDetails> = new Set();
  let results = [];
  let runStack = async (stack) => {
    let runFunction = onBuildStack(stack, dependencies);
    let stackPromise: Promise<any>;
    if (sync) {
      //build the stack in parallel
      stackPromise = Promise.resolve(true);
      stack.forEach((pck) => {
        stackPromise = stackPromise.then(() => {
          return runPackage(runFunction, pck);
        });
      });
    } else {
      //build the stack in parallel
      stackPromise = Promise.all(
        stack.map((pck) => {
          return runPackage(runFunction, pck);
        }),
      );
    }

    //wait till stack is completed
    let stackResults = await stackPromise;
    results = results.concat(stackResults);

    //clear stack for next round
    stack = [];

    //find those packages who have all their dependencies already built and add them to the stack
    lincdPackages.forEach((pkg) => {
      let deps = dependencies.get(pkg);

      //if the package is not done yet
      //but every dependency is now done OR was not something we can build (some @dacore dependencies may not be local)
      if (
        !done.has(pkg) &&
        deps.every((dependency) => {
          return (
            typeof dependency !== 'string' &&
            (done.has(dependency) || !lincdPackages.has(dependency.packageName))
          );
        })
      ) {
        stack.push(pkg);
      }
    });

    if (stack.length <= 0 && done.size < lincdPackages.size) {
      console.log(
        chalk.red(
          'Only ' +
            done.size +
            ' out of ' +
            lincdPackages.size +
            ' packages have been built',
        ),
      );
      console.log(
        'ALL remaining packages have dependencies that have not been met. This may point to ' +
          chalk.red('circular dependencies.'),
      );
      console.log(
        'Already built: ' +
          Array.from(done)
            .map((p) => chalk.green(p.packageName))
            .join(', '),
      );
      console.log(
        chalk.blue('\nTo solve this issue') +
          ': find the circular dependencies below and fix the dependencies:\n\n',
      );
      //TODO: actually find and name the packages that have circular dependencies
      // let circular = [];
      // lincdPackages.forEach((pkg) => {
      //   if (!done.has(pkg))
      //   {
      //     let deps = dependencies.get(pkg);
      //     if (deps.some(dependency => {
      //       //return true if this dependency (indirectly) depends on the package whos' dependency it is
      //       return hasDependency(dependency,pkg,dependencies)
      //     }))
      //     {
      //       circular.push(pkg);
      //     }
      //     process.exit();
      //   }
      // });
      lincdPackages.forEach((pkg) => {
        let deps = dependencies.get(pkg);
        if (!done.has(pkg)) {
          console.log(
            chalk.red(pkg.packageName) +
              ' has not been built yet. Unbuilt dependencies:\n' +
              deps
                .filter((dependency) => {
                  return !Array.from(done).some((p) => {
                    // console.log(p.packageName,dependency.packageName,p===dependency)
                    return p === dependency;
                  });
                })
                .map((p) =>
                  chalk.red(
                    '\t- ' +
                      (p?.packageName ? p.packageName : p.toString()) +
                      '\n',
                  ),
                )
                .join(' '),
          );
          // console.log(chalk.red(pkg.packageName)+' has not been built yet. Built dependencies:\n' + deps.filter(dependency => {
          //   return Array.from(done).some(p => p.packageName === pkg.packageName)
          // }).map(p => chalk.green('\t- '+p.packageName+'\n')).join(" "))
          // console.log(chalk.red(pkg.packageName)+' has not been built yet. Built dependencies:\n' + deps.filter(dependency => done.has(pkg)).map(p => chalk.green('\t- '+p.packageName+'\n')).join(" "))
        }
      });
    }

    //if more to be built, iterate
    if (stack.length > 0) {
      return runStack(stack);
    } else {
      onStackEnd(dependencies, results.filter(Boolean));
      res();
    }
  };

  //starts the process
  if (startStack.length === 0) {
    // No packages to build, resolve immediately
    onStackEnd(dependencies, []);
    res();
  } else {
    runStack(startStack).catch((err) => {
      rej(err);
    });
  }
  return deferredPromise;
}

function hasDependency(pkg, childPkg, dependencies, depth = 1) {
  console.log(
    'Does ' + pkg.packageName + ' have dep ' + childPkg.packageName + ' ?',
  );
  let deps = dependencies.get(pkg);
  if (
    deps.some((dependency) => {
      console.log(
        dependency.packageName,
        childPkg.packageName,
        dependency === childPkg,
      );
      if (depth === 2) return false;
      // return dependency === childPkg;
      return (
        dependency === childPkg ||
        hasDependency(dependency, childPkg, dependencies, depth++)
      );
    })
  ) {
    console.log('##YES');
    return true;
  }
  console.log('going up');
  return false;
}

/**
 * Finds the topmost package.json that could be an APP_ROOT
 * Returns null if no app root is found (standalone repo case)
 */
function findAppRoot(startPath = process.cwd()): string | null {
  let currentPath = startPath;
  let candidateRoots: Array<{
    path: string;
    hasWorkspaces: boolean;
    isLinked: boolean;
  }> = [];

  // Walk up the directory tree
  for (let i = 0; i < 10; i++) {
    const packageJsonPath = path.join(currentPath, 'package.json');

    if (fs.existsSync(packageJsonPath)) {
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

      candidateRoots.push({
        path: currentPath,
        hasWorkspaces: !!packageJson.workspaces,
        isLinked: packageJson.linkedPackage === true,
      });
    }

    const parentPath = path.join(currentPath, '..');
    // If we've reached the root or haven't moved up
    if (parentPath === currentPath) {
      break;
    }
    currentPath = parentPath;
  }

  // Find the topmost package.json that has workspaces
  // Prefer non-linked packages (app roots) over linked packages
  let appRoot = null;
  for (let i = candidateRoots.length - 1; i >= 0; i--) {
    const candidate = candidateRoots[i];
    if (candidate.hasWorkspaces && !candidate.isLinked) {
      appRoot = candidate.path;
      break;
    }
  }

  // If no non-linked workspace found, use the topmost workspace
  if (!appRoot) {
    for (let i = candidateRoots.length - 1; i >= 0; i--) {
      if (candidateRoots[i].hasWorkspaces) {
        appRoot = candidateRoots[i].path;
        break;
      }
    }
  }

  return appRoot;
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

  // Start with direct dependencies from app root
  if (appPackageJson.dependencies) {
    Object.keys(appPackageJson.dependencies).forEach((dep) => {
      if (allPackages.has(dep)) {
        packagesToCheck.add(dep);
      }
    });
  }

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

export function buildAll(options) {
  console.log(
    'Building all LINCD packages of this repository in order of dependencies',
  );
  let lincdPackages = getLocalLincdPackageMap();
  const originalPackageCount = lincdPackages.size;

  // Check if we're in an app context and filter packages accordingly
  const appRoot = findAppRoot();

  if (appRoot) {
    const appPackageJson = getPackageJSON(appRoot);
    // Check if this is an app (not a lincd package itself) with lincd dependencies
    const isAppWithLincdDeps =
      appPackageJson &&
      appPackageJson.lincd !== true &&
      appPackageJson.dependencies &&
      Object.keys(appPackageJson.dependencies).some((dep) =>
        lincdPackages.has(dep),
      );

    if (isAppWithLincdDeps) {
      debugInfo(chalk.blue(`Found app root at: ${appRoot}`));
      const filteredPackages = filterPackagesByDependencyTree(
        lincdPackages,
        appRoot,
      );

      console.log(
        chalk.magenta(
          `Found ${filteredPackages.size} total LINCD packages in use by this app`,
        ),
      );

      lincdPackages = filteredPackages;
    } else {
      debugInfo(
        chalk.blue(
          `Building all ${originalPackageCount} packages from workspace`,
        ),
      );
    }
  } else {
    debugInfo(
      chalk.blue(
        `No workspace root found, building all ${originalPackageCount} packages`,
      ),
    );
  }

  let startFrom: string;
  //by default start building
  let building: boolean = true;

  let from = options?.from;
  let sync = options?.sync || false;

  // console.log('from', from);
  // console.log('sync', sync);
  // process.exit();

  //option to start from a specific package in the stack
  if (from) {
    startFrom = from;
    //if we have a startFrom, then we havnt started the build process yet
    building = startFrom ? false : true;

    //clear targets
    // target = '';
    // target2 = '';
    console.log(chalk.blue('Will skip builds until ' + startFrom));

    // return async (pkg) => {};
  }
  // if (target2 == 'from') {
  //   startFrom = target3;
  //   //if we have a startFrom, then we havnt started the build process yet
  //   building = startFrom ? false : true;
  //
  //   //clear targets
  //   target2 = '';
  //   target3 = '';
  //   console.log(chalk.blue('Will skip builds until ' + startFrom));
  //
  //   // return async (pkg) => {};
  // }

  let done: Set<PackageDetails> = new Set();
  let failedModules = [];

  progressUpdate(lincdPackages.size + ' packages left');

  let packagesLeft = lincdPackages.size;
  // let packagesLeft = lincdPackages.size - done.size;
  runOnPackagesGroupedByDependencies(
    lincdPackages,
    (packageGroup, dependencies) => {
      if (done.size > 0) {
        debugInfo(
          chalk.magenta(
            '\n-------\nThese packages are next, since all their dependencies have now been build:',
          ),
        );
        // log(stack);
      }
      debugInfo(
        'Now building: ' + chalk.blue(packageGroup.map((i) => i.packageName)),
      );
      return async (pkg: PackageDetails) => {
        let command;
        let skipping = false;
        //if we're skipping builds until a certain package
        if (!building) {
          //if the package name matches the package we're supposed to start from then start building packages
          if (pkg.packageName == startFrom || pkg.packageName == startFrom) {
            building = true;
          }
          //else still waiting for the package
          else {
            log(chalk.blue('skipping ' + pkg.packageName));
            command = Promise.resolve(true);
            skipping = true;
          }
        }
        //unless told otherwise, build the package
        if (!command) {
          // Invoke the package's own `build` script. This lets each package
          // own its build pipeline — e.g. @_linked/core uses direct tsc, pure-CSS
          // packages may have no-op builds, and linkedPackage: true packages
          // typically call `linked build` internally.
          //
          // npm is the default; the package manager is detected per package so
          // packages inside an existing yarn workspace still build with yarn.
          const pkgDir = path.join(process.cwd(), pkg.path);
          const pkgJson = getPackageJSON(pkgDir);
          const hasBuildScript = !!(pkgJson?.scripts?.build);

          if (!hasBuildScript) {
            // No build script — skip gracefully (e.g. a pure-assets package).
            command = Promise.resolve(true);
          } else {
            const buildCmd = runScriptCommand(
              detectPackageManager(pkgDir),
              'build',
            );
            command = execPromise(buildCmd, false, false, {
              cwd: pkgDir,
            })
              .then((res) => res === '' || typeof res === 'string')
              .catch((err) => ({
                error: err.stdout || err.stderr || String(err),
              }));
          }
          log(chalk.cyan('Building ' + pkg.packageName));
          process.stdout.write(packagesLeft + ' packages left\r');
        }

        return command
          .then((res) => {
            //empty string or true is success
            //false is success with warnings
            //any other string is the build error text
            //undefined result means it failed
            // if (res !== '' && res !== true && res !== false) {
            if (typeof res === 'undefined') {
              failedModules.push(pkg.packageName);
              let dependentModules = getDependentPackages(dependencies, pkg);
              if (dependentModules.length > 0) {
                printBuildResults(failedModules, done);
                console.log(
                  'Stopping build process because an error occurred whilst building ' +
                    pkg.packageName +
                    ', which ' +
                    dependentModules.length +
                    ' other packages depend on.',
                ); //"+dependentModules.map(d => d.packageName).join(", ")));
                log(
                  'Run ' +
                    chalk.greenBright(
                      `lincd build-all --from=${pkg.packageName}`,
                    ) +
                    ' to build only the remaining packages',
                ); //"+dependentModules.map(d => d.packageName).join(", ")));
                process.exit(1);
              }
            } else {
              if (!skipping) {
                log(
                  chalk.green('Built ' + pkg.packageName) +
                    (res === false ? chalk.redBright(' (with warnings)') : ''),
                );
              }
              done.add(pkg);

              packagesLeft--;
              // log(chalk.magenta(packagesLeft + ' packages left'));
              process.stdout.write(packagesLeft + ' packages left\r');
              if (packagesLeft == 0) {
                printBuildResults(failedModules, done);
                if (failedModules.length > 0) {
                  process.exit(1);
                }
              }

              return res;
            }
          })
          .catch(({error, stdout, stderr}) => {
            logError(chalk.red('Failed to build ' + pkg.packageName));
            console.log(stdout);
            process.exit(1);
            // let dependentModules = getDependentP
          });
        //undefined result means it failed
        /*if (typeof res === 'undefined')
        {
          // .catch(({ error,stdout,stderr }) => {
          //this prints out the webpack output, including the build errors
          // warn('Failed to build ' + pkg.packageName);
          // console.log(stdout);
          failedModules.push(pkg.packageName);
          let dependentModules = getDependentPackages(dependencies,pkg);
          if (dependentModules.length > 0)
          {
            printBuildResults(failedModules,done);
            console.log(
              'Stopping build process because an error occurred whilst building ' +
              pkg.packageName +
              ', which ' +
              dependentModules.length +
              ' other packages depend on.',
            ); //"+dependentModules.map(d => d.packageName).join(", ")));
            log(
              'Run ' +
              chalk.greenBright(`lincd build-all --from=${pkg.packageName}`) +
              ' to build only the remaining packages',
            ); //"+dependentModules.map(d => d.packageName).join(", ")));
            process.exit(1);
          }
        }
        else //true is successful build, false is successful but with warnings
        {
          //successful build
          // })
          //   .then((res) => {
          if (!skipping)
          {
            log(chalk.green('Built ' + pkg.packageName)+(res === false ? chalk.redBright(' (with warnings)') : ''));
          }
          done.add(pkg);

          packagesLeft--;
          // log(chalk.magenta(packagesLeft + ' packages left'));
          process.stdout.write(packagesLeft + ' packages left\r');
          if (packagesLeft == 0)
          {
            printBuildResults(failedModules,done);
            if (failedModules.length > 0)
            {
              process.exit(1);
            }
          }

          return res;
        }*/
        // }).catch(err => {
        //   console.log(err);
        // })
      };
    },
    (dependencies) => {
      //if no more packages to build but we never started building...
      if (!building) {
        console.log(
          chalk.red(
            'Could not find the package to start from. Please provide a correct package name or package name to build from',
          ),
        );
      } else {
        //Detecting cyclical dependencies that caused some packages not to be build
        let first = true;
        lincdPackages.forEach((pkg) => {
          if (!done.has(pkg)) {
            let deps = dependencies.get(pkg);
            if (first) {
              console.log(
                chalk.red(
                  'CYCLICAL DEPENDENCIES? - could not build some packages because they depend on each other.',
                ),
              );
              first = false;
            }
            //print the cyclical dependencies
            console.log(
              chalk.red(pkg.packageName) +
                ' depends on ' +
                deps
                  .filter((dependency) => {
                    return typeof dependency !== 'string';
                  })
                  .map((d: PackageDetails) => {
                    return done.has(d)
                      ? d.packageName
                      : chalk.red(d.packageName);
                  })
                  .join(', '),
            );

            //also print some information why these packages have not been moved into the stack
            let stringDependencies = deps.filter((d) => typeof d === 'string');
            if (stringDependencies.length > 0) {
              console.log(
                chalk.red(
                  'And it depends on these package(s) - which seem not to be proper packages :' +
                    stringDependencies.join(', '),
                ),
              );
              console.log(
                chalk.red(
                  'Could you remove this from dependencies? Should it be a devDependency?',
                ),
              );
            }
          }
        });
      }
    },
    sync,
  );
}

function getDependentPackages(dependencies, pkg): PackageDetails[] {
  let dependentModules: PackageDetails[] = [];
  dependencies.forEach((dModuleDependencies, dModule) => {
    if (dModuleDependencies.indexOf(pkg) !== -1) {
      dependentModules.push(dModule);
    }
  });

  return dependentModules;
}

/**
 * Returns a map of the packages that this repository manages (so no packages found through the workspaces who's path contains ../ )
 * @param rootPath
 */
function getLocalLincdPackageMap(rootPath = './'): Map<string, PackageDetails> {
  let map = new Map();
  getLincdPackages(rootPath).forEach((pkg) => {
    if (pkg.path.indexOf('../') === -1 && pkg.path.indexOf('..\\') === -1) {
      // console.log(package.path);
      map.set(pkg.packageName, pkg);
    }
  });
  return map;
}

function getLocalLincdModules(rootPath = './'): PackageDetails[] {
  return getLincdPackages(rootPath).filter((pkg) => {
    return pkg.path.indexOf('..\\') === -1;
  });
}

// getLincdPackages moved to ./lifecycle.ts and re-exported above.

function setVariable(name, replacement) {
  //prepare name for regexp
  name = name.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&');
  variables[name] = replacement;
}

var replaceVariablesInFile = async (filePath: string) => {
  var fileContent = await fs.readFile(filePath, 'utf8').catch((err) => {
    console.warn(chalk.red('Could not read file ' + filePath));
  });
  if (fileContent) {
    var newContent = replaceCurlyVariables(fileContent);
    return fs.writeFile(filePath, newContent);
  } else {
    return Promise.resolve();
  }
};

var replaceCurlyVariables = function (string) {
  // var reg = new RegExp('\\$\\{'+key+'\\}','g');
  for (var key in variables) {
    string = string.replace(
      new RegExp('\\$\\{' + key + '\\}', 'g'),
      variables[key],
    );
  }
  return string;
};

const capitalize = (str) =>
  str.charAt(0).toUpperCase() + str.toLowerCase().slice(1);
const camelCase = (str) => {
  let string = str.replace(/[^A-Za-z0-9]/g, ' ').split(' ');
  if (string.length > 1) {
    return string.reduce((result, word) => result + capitalize(word));
  }
  return str;
};

export const createOntology = async (
  prefix,
  uriBase?,
  basePath = process.cwd(),
) => {
  if (!prefix) {
    console.warn('Please provide a suggested prefix as the first argument');
    return;
  }

  let sourceFolder = getSourceFolder(basePath);
  let targetFolder = ensureFolderExists(sourceFolder, 'ontologies');

  if (!uriBase) {
    uriBase = 'http://lincd.org/ont/' + prefix + '/';
  }
  setVariable('uri_base', uriBase);

  let {hyphenName, camelCaseName, underscoreName} = setNameVariables(prefix);

  //copy ontology accessor file
  log("Creating files for ontology '" + prefix + "'");
  let targetFile = path.join(targetFolder, hyphenName + '.ts');
  fs.copySync(
    path.join(
      dirname__,
      '..',
      '..',
      'defaults',
      'package',
      'src',
      'ontologies',
      'example-ontology.ts',
    ),
    targetFile,
  );

  //copy data files
  let targetDataFile = path.join(
    targetFolder,
    '..',
    'data',
    hyphenName + '.json',
  );
  let targetDataFile2 = path.join(
    targetFolder,
    '..',
    'data',
    hyphenName + '.json.d.ts',
  );
  fs.copySync(
    path.join(
      dirname__,
      '..',
      '..',
      'defaults',
      'package',
      'src',
      'data',
      'example-ontology.json',
    ),
    targetDataFile,
  );
  fs.copySync(
    path.join(
      dirname__,
      '..',
      '..',
      'defaults',
      'package',
      'src',
      'data',
      'example-ontology.json.d.ts',
    ),
    targetDataFile2,
  );

  await replaceVariablesInFiles(targetFile, targetDataFile, targetDataFile2);
  log(
    `Prepared a new ontology data files in ${chalk.magenta(
      targetDataFile.replace(basePath, ''),
    )}`,
    `And an ontology accessor file in ${chalk.magenta(
      targetFile.replace(basePath, ''),
    )}`,
  );

  //if this is not a lincd app (but a lincd package instead)
  if (!sourceFolder.includes('frontend')) {
    //then also add an import to index
    let indexPath = addLineToIndex(
      `import './ontologies/${hyphenName}.js';`,
      'ontologies',
    );
    log(`Added an import of this file from ${chalk.magenta(indexPath)}`);
  }
};
// The shapes barrel (src/shapes/index.ts) is imported by both the frontend index and
// the backend entry, so every shape registers on both boot paths (and materializes into
// app-data on boot). `create-shape` adds each new shape here — NOT to the main index.
const SHAPES_BARREL_HEADER =
  `// Shape registry — every shape is imported here so its @linkedShape decorator runs and\n` +
  `// the shape registers on both boot paths (backend materialization + frontend). \`linked\n` +
  `// create-shape\` maintains this list.\n//SHAPES\n`;

const ensureBackendImportsShapes = function (root: string = process.cwd()) {
  const backendPath = path.join(root, 'src', 'backend.ts');
  if (!fs.existsSync(backendPath)) return;
  let contents = fs.readFileSync(backendPath, 'utf-8');
  if (contents.includes('./shapes/index')) return;
  fs.writeFileSync(backendPath, `import './shapes/index.js';\n` + contents);
};

// Register a shape in the shapes barrel (src/shapes/index.ts), creating it if needed, and
// make sure both the main index and backend.ts import the barrel. Idempotent.
export const addShapeToBarrel = function (shapeHyphenName: string, root: string = process.cwd()) {
  const shapesDir = path.join(root, 'src', 'shapes');
  fs.ensureDirSync(shapesDir);
  const barrelPath = path.join(shapesDir, 'index.ts');
  let contents = fs.existsSync(barrelPath)
    ? fs.readFileSync(barrelPath, 'utf-8')
    : SHAPES_BARREL_HEADER;
  const line = `import './${shapeHyphenName}.js';`;
  if (!contents.split(/\n/g).some((l) => l.trim() === line.trim())) {
    contents = contents.includes('//SHAPES')
      ? contents.replace('//SHAPES', `//SHAPES\n${line}`)
      : contents.replace(/\n*$/, '') + `\n${line}\n`;
    fs.writeFileSync(barrelPath, contents);
  }
  // Both boot paths must load the barrel (idempotent).
  addLineToIndex(`import './shapes/index.js';`, 'shapes', root);
  ensureBackendImportsShapes(root);
  return barrelPath;
};

// Exported for Shape-Builder reuse: CodeShapeSyncService adds
// the `import './shapes/<Shape>.js';` line to a generated app package's index.
export const addLineToIndex = function (
  line,
  insertMatchString: string,
  root: string = process.cwd(),
  insertAtStart: boolean = false,
) {
  //import ontology in index
  let indexPath = ['index.ts', 'index.tsx']
    .map((f) => path.join(root, 'src', f))
    .find((indexFileName) => {
      return fs.existsSync(indexFileName);
    });
  if (indexPath) {
    let indexContents = fs.readFileSync(indexPath, 'utf-8');
    // Idempotent: if the exact line is already present, do nothing (re-running
    // a shape edit must not append a duplicate import).
    if (indexContents.split(/\n/g).some((l) => l.trim() === line.trim())) {
      return indexPath;
    }
    let lines = indexContents.split(/\n/g);
    let newContents;
    for (var key in lines) {
      //if the match string is found
      if (lines[key].indexOf(insertMatchString) !== -1) {
        //add the new line after this line
        lines[key] += `\n${line}`;
        newContents = lines.join('\n');
        // log("Found at "+key,lines,newContents);
        break;
      }
    }
    if (!newContents) {
      if (insertAtStart) {
        newContents = `${line}\n${indexContents}`;
      } else {
        newContents = `${indexContents}\n${line}`;
      }
      // log("Added at end",newContents);
    }
    fs.writeFileSync(indexPath, newContents);
  }
  return indexPath;
};
const replaceVariablesInFiles = function (...files: string[]) {
  return Promise.all(
    files.map((file) => {
      return replaceVariablesInFile(file);
    }),
  );
};
const replaceVariablesInFolder = async function (
  folder: string,
): Promise<void> {
  //get all files in folder, including files that start with a dot
  try {
    const files = await glob(folder + '/**/*', {dot: true, nodir: true});
    await Promise.all(
      files.map((file) => {
        return replaceVariablesInFile(file);
      }),
    );
  } catch (err) {
    console.log('Error', err);
    throw err;
  }
};

const replaceVariablesInFilesWithRoot = function (
  root: string,
  ...files: string[]
) {
  return replaceVariablesInFiles(...files.map((f) => path.join(root, f)));
};
export type PackageManager = 'npm' | 'yarn';

/**
 * The package manager `create-app` scaffolds with. Both templates (web and
 * react-native) install with npm, so a scaffolded app has exactly one lockfile.
 */
export const CREATE_APP_PACKAGE_MANAGER: PackageManager = 'npm';

/** The shell command that installs a scaffolded app's dependencies. */
export function installCommandFor(pm: PackageManager): string {
  return pm === 'yarn'
    ? 'export NODE_OPTIONS="--no-network-family-autoselection" && yarn install'
    : 'npm install';
}

/** The command printed to the user for starting their new app. */
export function startCommandFor(pm: PackageManager): string {
  return pm === 'yarn' ? 'yarn start' : 'npm start';
}

const ensureFolderExists = function (...folders: string[]) {
  let target;
  folders.forEach((folder) => {
    target = target ? path.join(target, folder) : path.join(folder);
    if (!fs.existsSync(target)) {
      fs.mkdirSync(target);
    }
  });
  return target;
  /*let targetFolder = path.join(...folders);
  let parentDirectory = folders.slice(0, folders.length - 1);
  if (!fs.existsSync(targetFolder)) {
    if (fs.existsSync(path.join(...parentDirectory))) {
      fs.mkdirSync(targetFolder);
    } else {
      warn(
        `Please run this command from the root of your package. This command expects ${parentDirectory.toString()} to exists from that folder`,
      );
    }
  }
  return targetFolder;*/
};

export const setNameVariables = function (name) {
  let hyphenName = name.toLowerCase().replace(/[-_\s]+/g, '-');
  let camelCaseName = camelCase(name); //some-package --> someModule
  let underscoreName = name.replace(/[-\s]+/g, '_');
  let plainName = name.replace(/[-\s]+/g, '');

  //longer similar variables names should come before the shorter ones
  setVariable('underscore_name', underscoreName);
  setVariable('hyphen_name', hyphenName);
  setVariable('camel_name', camelCaseName);
  setVariable('name', name);
  setVariable('plain_name', plainName);

  return {hyphenName, camelCaseName, underscoreName, plainName};
};

function getSourceFolder(basePath = process.cwd()) {
  //LINCD App
  if (fs.existsSync(path.join(basePath, 'frontend', 'src'))) {
    return path.join(basePath, 'frontend', 'src');
  }
  //LINCD package
  if (fs.existsSync(path.join(basePath, 'src'))) {
    return path.join(basePath, 'src');
  } else {
    console.warn('Cannot find source folder');
    return path.join(basePath, 'src');
  }
}

/**
 * get __dirname for either ESM/CJS
 */
export const getScriptDir = () => {
  return dirname__;
  // // @ts-ignore
  // if (typeof __dirname !== 'undefined')
  // {
  //   // @ts-ignore
  //   return __dirname;
  // }
  // else
  // {
  //   // @ts-ignore
  //   return dirname(import.meta.url).replace('file:/','');
  // }
};
export const createShape = async (name, basePath = process.cwd()) => {
  let sourceFolder = getSourceFolder(basePath);
  let targetFolder = ensureFolderExists(sourceFolder, 'shapes');
  let {hyphenName, camelCaseName, underscoreName} = setNameVariables(name);

  //copy default shape file
  // log("Creating files for shape '" + name + "'");
  let targetFile = path.join(targetFolder, hyphenName + '.ts');
  fs.copySync(
    path.join(getScriptDir(), '..', '..', 'defaults', 'shape.ts'),
    targetFile,
  );

  //replace variables in some of the copied files
  await replaceVariablesInFiles(targetFile);
  log(
    `Created a new shape class template in ${chalk.magenta(
      targetFile.replace(basePath, ''),
    )}`,
  );

  // Register the shape in the shapes barrel (src/shapes/index.ts) — NOT the main index —
  // and make sure the barrel is loaded on both boot paths. This is what makes the app
  // materialize its own shapes on boot.
  const barrelPath = addShapeToBarrel(hyphenName);
  log(`Registered the shape in ${chalk.magenta(barrelPath.replace(basePath, ''))}`);
};

export const createSetComponent = async (name, basePath = process.cwd()) => {
  let targetFolder = ensureFolderExists(basePath, 'src', 'components');
  let {hyphenName, camelCaseName, underscoreName} = setNameVariables(name);

  //copy default shape file
  log("Creating files for set component '" + name + "'");
  let targetFile = path.join(targetFolder, hyphenName + '.tsx');
  fs.copySync(
    path.join(getScriptDir(), '..', '..', 'defaults', 'set-component.tsx'),
    targetFile,
  );

  let targetFile2 = path.join(targetFolder, hyphenName + '.scss');
  fs.copySync(
    path.join(getScriptDir(), '..', '..', 'defaults', 'component.scss'),
    targetFile2,
  );

  //replace variables in some of the copied files
  await replaceVariablesInFiles(targetFile, targetFile2);

  let indexPath = addLineToIndex(
    `import './components/${hyphenName}.js';`,
    'components',
  );

  log(
    `Created a new set component in ${chalk.magenta(
      targetFile.replace(basePath, ''),
    )}`,
    `Created a new stylesheet in ${chalk.magenta(
      targetFile2.replace(basePath, ''),
    )}`,
    `Added an import of this file from ${chalk.magenta(indexPath)}`,
  );
};
export const createComponent = async (name, basePath = process.cwd()) => {
  let sourceFolder = getSourceFolder(basePath);
  let targetFolder = ensureFolderExists(sourceFolder, 'components');
  let {hyphenName, camelCaseName, underscoreName} = setNameVariables(name);

  //copy default shape file
  log("Creating files for component '" + name + "'");
  let targetFile = path.join(targetFolder, hyphenName + '.tsx');
  fs.copySync(
    path.join(getScriptDir(), '..', 'defaults', 'component.tsx'),
    targetFile,
  );

  let targetFile2 = path.join(targetFolder, hyphenName + '.scss');
  fs.copySync(
    path.join(getScriptDir(), '..', 'defaults', 'component.scss'),
    targetFile2,
  );

  //replace variables in some of the copied files
  await replaceVariablesInFiles(targetFile, targetFile2);
  log(
    `Created a new component template in ${chalk.magenta(
      targetFile.replace(basePath, ''),
    )}`,
    `Created component stylesheet template in ${chalk.magenta(
      targetFile2.replace(basePath, ''),
    )}`,
  );

  //if this is not a lincd app (but a lincd package instead)
  if (!sourceFolder.includes('frontend')) {
    //then also add an import to index
    let indexPath = addLineToIndex(
      `import './components/${hyphenName}.js';`,
      'components',
    );
    log(`Added an import of this file from ${chalk.magenta(indexPath)}`);
  }
};

// Reads the source of all ts/tsx files in the src folder and fails on imports
// that reach outside the package source root ('outside_package'), or that point
// into another Linked package's /src/ or /lib/ ('internal_linked'). Extensionless relative
// imports are fine: `linked build` rewrites the emitted ESM specifiers.
export const checkImports = async (
  sourceFolder: string = getSourceFolder(),
  depth: number = 0, // Used to check if the import is outside the src folder
  invalidImports: Map<string, {type: string; importPath: string}[]> = new Map(),
) => {
  if (!fs.existsSync(sourceFolder)) {
    // Package has no src/ folder (e.g. pure-CSS packages). Nothing to check.
    return true;
  }
  const dir = fs.readdirSync(sourceFolder);

  // Start checking each file in the source folder
  for (const file of dir) {
    const filename = path.join(sourceFolder, file);

    // Skip test sources. Test files (and their helpers/probes) are not part
    // of the shipped package, so the import rules do not apply to them.
    if (
      /(?:^|[\\/])(?:tests?|__tests__|test-helpers)(?:[\\/]|$)/.test(filename) ||
      /\.(?:test|spec)\.tsx?$/.test(file) ||
      /^type-probe.*\.tsx?$/.test(file)
    ) {
      continue;
    }

    // File is either a directory, or not a .ts(x)
    // INFO: For future use - if this part fails, it could be due to user permissions
    //  i.e. the program not having access to check the file metadata
    if (!filename.match(/\.tsx?$/)) {
      try {
        if (statSync(filename).isDirectory()) {
          await checkImports(filename, depth + 1, invalidImports);
        }
      } catch (e) {
        console.log(e);
      }
      // A directory has now been recursed into, and any other file is not a
      // source file: either way there is nothing here to read imports from.
      continue;
    }

    const allImports = await getFileImports(filename);
    if (!invalidImports.has(filename)) {
      invalidImports.set(filename, []);
    }

    allImports.forEach((i) => {
      if (isImportOutsideOfPackage(i, depth)) {
        invalidImports.get(filename).push({
          type: 'outside_package',
          importPath: i,
        });
      }
      if (isInternalLinkedImport(i)) {
        invalidImports.get(filename).push({
          type: 'internal_linked',
          importPath: i,
        });
      }
    });
  }

  let res = '';
  //check if invalidImports has any
  let flat = [...invalidImports.values()].flat();
  // All recursion must have finished, display any errors
  if (depth === 0 && flat.length > 0) {
    res += chalk.red('Invalid imports found.\n');

    invalidImports.forEach((value, key) => {
      // res += '- '+chalk.blueBright(key.split('/').pop()) + ':\n';
      value.forEach(({type, importPath}) => {
        let message =
          key.split('/').pop() + " imports from '" + importPath + "'";
        if (type === 'outside_package') {
          message += ' which is outside the package source root';
        }
        if (type === 'internal_linked') {
          message +=
            " which reaches into another Linked package's /src/ or /lib/." +
            ' That breaks when its build layout changes and bypasses its' +
            ' exports map. Import its public subpath instead.';
        }
        res += chalk.red(message + '\n');
      });
    });

    // Throw so buildStep aborts the compile pipeline: importing from outside
    // the package, or into another Linked package's /src/ or /lib/, breaks the
    // published package.
    throw res;
  }
  // Nothing invalid: all imports OK.
  return true;
};

export const depCheckStaged = async () => {
  console.log('Checking dependencies of staged files');
  stagedGitFiles(async function (err, results) {
    const packages = new Set<string>();
    await Promise.all(
      results.map(async (file) => {
        // console.log('STAGED: ', file.filename);
        let root = await findNearestPackageJson(file.filename);
        packages.add(root.path);
      }),
    );

    [...packages].forEach((packageRoot) => {
      const pack = JSON.parse(fs.readFileSync(packageRoot, 'utf8'));
      const srcPath = packageRoot.replace('package.json', '');
      console.log('Checking dependencies of ' + chalk.blue(pack.name) + ':');
      return depCheck(process.cwd() + '/' + srcPath);
      // console.log('check dependencies of ' + pack.name);
      //
      // console.log('ROOT of ' + file.filename + ': ' + root.path);
      // console.log('ROOT of ' + file.filename + ': ' + root.data);
    });
  });
};
export const depCheck = async (packagePath: string = process.cwd()) => {
  // log('Checking depencies of ' + chalk.cyan(packagePath));
  return new Promise((resolve, reject) => {
    depcheck(packagePath, {}, (results) => {
      if (results.missing) {
        let lincdPackages = getLocalLincdModules(packagePath);
        let missing = Object.keys(results.missing);
        //filter out missing types, if it builds we're not too concerned about that at the moment?
        //especially things like @types/react, @types/react-dom, @types/node (they are added elsewhere?)
        // missing = missing.filter(m => m.indexOf('@types/') === 0);
        //currently react is not an explicit dependency, but we should add it as a peer dependency
        missing.splice(missing.indexOf('react'), 1);

        let missingLincdPackages = missing.filter((missingDep) => {
          return lincdPackages.some((lincdPackage) => {
            return lincdPackage.packageName === missingDep;
          });
        });
        //currently just missing LINCD packages cause a hard failure exit code
        if (missingLincdPackages.length > 0) {
          reject(
            chalk.red(
              packagePath.split('/').pop() +
                '\n[ERROR] These LINCD packages are imported but they are not listed in package.json:\n- ' +
                missingLincdPackages
                  .map((missedKey) => {
                    const files = results.missing[missedKey];
                    return `${missedKey} (${files.length} files: ${files.join(', ')})`;
                  })
                  .join(',\n- '),
            ),
          );
        } else if (missing.length > 0) {
          resolve(
            chalk.redBright(
              'warning: ' +
                packagePath.split('/').pop() +
                ' is missing dependencies:\n  - ' +
                missing.join('\n  - '),
            ),
          );
        } else {
          resolve(true);
        }
      }
      // if(Object.keys(results.invalidFiles).length > 0) {
      //   console.warn(chalk.red("Invalid files:\n")+Object.keys(results.invalidFiles).join(",\n"));
      // }
      // if(Object.keys(results.invalidDirs).length > 0) {
      //   console.warn(chalk.red("Invalid dirs:\n")+results.invalidDirs.toString());
      // }
      // if(results.unused) {
      //   console.warn("Unused dependencies: "+results.missing.join(", "));
      // }
    });
  });
};
// ensureEnvironmentLoaded moved to ./lifecycle.ts and re-exported above.
export const runScript = async (
  scriptName: string,
  options: {spawn: boolean},
) => {
  //if spawn is not defined, default to true
  const spawn = options.spawn !== undefined ? options.spawn : true;

  await ensureEnvironmentLoaded();
  if (spawn) {
    await startServer(true);
  }

  log('Running script ' + scriptName);
  const scriptPath = path.join(process.cwd(), 'scripts', scriptName);
  const script = await import(scriptPath);
  await script.default().catch((error) => {
    log('Script ' + scriptName + ' finished with errors');
    logError(error);
    process.exit(1);
  });
  log('Script ' + scriptName + ' finished');
  process.exit(0);
};

export const runMethod = async (
  packageName: string,
  method: string,
  options: {spawn: boolean},
) => {
  await ensureEnvironmentLoaded();

  if (options.spawn) {
    let linkedConfig = (
      await import(path.join(process.cwd(), 'linked.config.js'))
    ).default;

    // Set default loadAppComponent if not provided
    if (!linkedConfig.server) {
      linkedConfig.server = {};
    }
    if (!linkedConfig.server.loadAppComponent) {
      linkedConfig.server.loadAppComponent = async () =>
        (await import(path.join(process.cwd(), 'src', 'App'))).default;
    }
    // Set default loadRoutes if not provided
    if (!linkedConfig.server.loadRoutes) {
      linkedConfig.server.loadRoutes = async () =>
        await import(path.join(process.cwd(), 'src', 'routes.tsx'));
    }

    //@ts-ignore
    const ServerClass = (await import('@_linked/server/shapes/LinkedServer'))
      .LinkedServer;
    await loadBackendStorageConfig();
    let server = new ServerClass(linkedConfig);
    //init the server
    console.log('Initializing server...');
    server.initOnly().then(() => {
      //process the backend method call
      console.log('Running method ' + method);
      //mock the request and response objects
      let request = {
        body: {},
        query: {},
        params: {},
        headers: {},
        method: 'POST',
        url: '/' + packageName + '/' + method,
      };
      let response = {
        status: (statusCode) => {
          console.log('Response status code:', statusCode);
          return response;
        },
        json: (data) => {
          console.log('Response data:', data);
        },
        send: (data) => {
          console.log('Response data:', data);
        },
      };
      //TODO; allow sending args
      server
        .callBackendMethod(
          packageName,
          method,
          [],
          request as any,
          response as any,
        )
        .then(() => {
          console.log('Done');
          process.exit();
        })
        // An unmatched method (ServerCallError 501) or a provider error rejects; report it instead of an
        // unhandled rejection.
        .catch((err) => {
          console.error(err?.message ?? err);
          process.exit(1);
        });
    });
  } else {
    //reuse the existing running LinkedServer instance.
    //make a HTTP call
    //'/call/:pkg/:method',
    fetch(process.env.SITE_ROOT + '/call/' + packageName + '/' + method, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
    })
      .then((response) => {
        if (!response.ok) {
          throw new Error('Network response was not ok');
        }
        return response.json();
      })
      .then((data) => {
        console.log('Response data:', data);
        process.exit();
      })
      .catch((error) => {
        if (
          error.code === 'ECONNREFUSED' ||
          error.cause?.code === 'ECONNREFUSED'
        ) {
          console.error(
            chalk.red(
              'Could not connect to the backend server. Is it running?',
            ),
          );
          console.error(
            `Make sure you ${chalk.magenta('run "npm start" in a separate process')} before calling this method.`,
          );
        } else {
          console.error('Error during backend call:', error);
        }
        process.exit(1);
      });
  }
};
export const startServer = async (
  initOnly: boolean = false,
  ServerClass = null,
) => {
  await ensureEnvironmentLoaded();

  let linkedConfig = (await import(path.join(process.cwd(), 'linked.config.js')))
    .default;

  // function scssLoadcall(source, filename) {
  //   return 'console.log("SCSS CALL: ' + filename + '");\n' + source;
  //   process.exit();
  // }
  // hook.hook('.scss', scssLoadcall);
  // hook.hook('.css', scssLoadcall);
  // import.meta.
  // // hook.hook('*.css', scssLoadcall);
  // // hook.hook('Body.module.css', scssLoadcall);
  // hook.hook('.module.css', scssLoadcall);

  if (!ServerClass) {
    //@ts-ignore
    ServerClass = (await import('@_linked/server/shapes/LinkedServer')).LinkedServer;
  }
  await loadBackendStorageConfig();

  // Set default loadAppComponent if not provided
  if (!linkedConfig.server) {
    linkedConfig.server = {};
  }
  if (!linkedConfig.server.loadAppComponent) {
    let appPromise;
    if (process.env.NODE_ENV !== 'development') {
      appPromise = (await import(path.join(process.cwd(), 'lib', 'App.js')))
        .default;
    } else {
      appPromise = (await import(path.join(process.cwd(), 'src', 'App.tsx')))
        .default;
    }
    linkedConfig.server.loadAppComponent = async () => {
      return appPromise;
    };
  }

  // Set default loadRoutes if not provided
  if (!linkedConfig.server.loadRoutes) {
    linkedConfig.server.loadRoutes = async () => {
      if (process.env.NODE_ENV !== 'development') {
        return await import(path.join(process.cwd(), 'lib', 'routes.js'));
      } else {
        return await import(path.join(process.cwd(), 'src', 'routes.tsx'));
      }
    };
  }

  let server = new ServerClass(linkedConfig);
  //Important to use slice, because when using clusers, child processes need to be able to read the same arguments
  let args = process.argv.slice(2);
  //if --initOnly is passed, only initialize the server and don't start it
  if (args.includes('--initOnly') || initOnly) {
    return server.initOnly();
  } else {
    return server.start();
  }
};
export const buildApp = async () => {
  await buildFrontend();
  await buildBackend();
  console.log(chalk.magenta(`✅ ${process.env.NODE_ENV} app build finished`));
  process.exit(0);
};
export const buildFrontend = async () => {
  await ensureEnvironmentLoaded();
  // @vite-ignore — the webpack build path is legacy code, only reached
  // by `linked build-frontend` which is not part of the Vite dev/SSR
  // flow. Tell Vite not to graph-walk into it so we don't emit
  // import-analysis warnings for a file we never load via SSR.
  const webpackAppConfig = await (
    await import(/* @vite-ignore */ './config-webpack-app.js')
  ).getWebpackAppConfig();

  console.log(
    chalk.magenta(`🛠 Building ${process.env.NODE_ENV} frontend bundles`),
  );
  await new Promise((resolve, reject) => {
    webpack(webpackAppConfig as any, async (err, stats) => {
      if (err) {
        console.error(err.stack || err);
        process.exit(1);
      }
      const info = stats.toJson();
      if (stats.hasErrors()) {
        console.log('Finished running webpack with errors.');
        info.errors.forEach((e) => console.error(e));
        // process.exit(1);
        reject();
      } else {
        console.log(
          stats.toString({
            chunks: false,
            assets: true,
            entrypoints: false,
            modules: false,
            moduleAssets: false,
            colors: true,
          }),
        );
        console.log('App build process finished');
        resolve(true);
        // console.log(
        // 	chalk.green('\t'+Object.keys(stats.compilation.assets).join('\n\t')),
        // );

        //build metadata (JSON-LD files containing metadata about the lincd components, shapes & ontologies in this app or its packages)
        // let updatedPaths = await buildMetadata();
        // console.log(chalk.green("Updated metadata:\n")+" - "+updatedPaths.map(p => chalk.magenta(p.replace(process.cwd(),''))).join("\n - "));
      }
      // process.exit();
    });
  }).then(async () => {
    // make sure environment is not development for storage config
    // and if we want to upload to storage, we need set S3_BUCKET_ENDPOINT
    if (
      process.env.NODE_ENV === 'development' ||
      !process.env.S3_BUCKET_ENDPOINT
    ) {
      console.warn(
        'Upload build to storage skip in development environment or S3_BUCKET_ENDPOINT is not set',
      );
      return;
      // process.exit();
    }

    if (process.env.APP_ENV) {
      console.warn('Not uploading to CDN for app builds');
      return;
      // process.exit();
    }

    // load the storage config
    const storageConfig = await loadBackendStorageConfig();

    // check if LincdFileStorage has a default FileStore
    // if yes: copy all the files in the build folder over with LincdFileStorage
    if (LinkedFileStorage.getDefaultDataset()) {
      // get public directory
      const rootDirectory = 'public';
      const pathDir = path.join(process.cwd(), rootDirectory);
      if (!fs.existsSync(pathDir)) {
        console.warn(
          'No public directory found. Please create a public directory in the root of your project',
        );
        return;
      }

      // get all files in the web directory and then upload them to the storage
      const files = await getFiles(pathDir);
      console.log(
        chalk.magenta(
          `🕊  Publishing ${files.length} public files to linked file storage`,
        ),
      );
      const clearSpinner = ora({
        discardStdin: true,
        text: `Publishing ${files.length} public files`,
      }).start();

      let counter = 0;
      const uploads = files.map(async (filePath) => {
        // read file content
        const fileContent = await fs.promises.readFile(filePath);

        // replace pathDir with rootDirectory in filePath to get pathname
        // example: /Users/username/project/www/index.html -> /project/www/index.html
        const pathname = filePath.replace(pathDir, `/${rootDirectory}`);

        // upload file to storage
        await LinkedFileStorage.saveFile(pathname, fileContent)
          .then(() => {
            clearSpinner.text = `${counter++}/${files.length}: - Published ${pathname} `;
          })
          .catch(console.error);
      });

      const urls = await Promise.all(uploads);
      clearSpinner.succeed(`${urls.length} files uploaded to storage`);
    }
  });
};
export const buildBackend = async () => {
  console.log(chalk.magenta(`🛠 Preparing ${process.env.NODE_ENV} backend`));
  //run tsc in the backend folder
  await ensureEnvironmentLoaded();

  const sourceFolder = path.join(process.cwd(), 'src');
  const targetFolder = path.join(process.cwd(), 'lib');

  // Step 1: Clear lib folder
  const clearSpinner = ora({
    discardStdin: true,
    text: 'Clearing lib folder',
  }).start();

  try {
    if (fs.existsSync(targetFolder)) {
      await fs.remove(targetFolder);
    }
    clearSpinner.succeed('Lib folder cleared');
  } catch (e) {
    console.error(e);
    clearSpinner.fail('Failed to clear lib folder');
    return;
  }

  // Step 2: Compile TS files
  const compileSpinner = ora({
    discardStdin: true,
    text: 'Compiling backend TS files',
  }).start();

  try {
    await execPromise(execBinCommand(detectPackageManager(), 'tsc'));
    compileSpinner.succeed('Backend TS files compiled');
  } catch (e) {
    console.error(e);
    compileSpinner.fail('Failed to compile backend TS files');
    return;
  }

  // Step 3: Copy CSS files
  const copySpinner = ora({
    discardStdin: true,
    text: 'Copying CSS files',
  }).start();

  try {
    const cssFiles = await getFiles(sourceFolder, '.css');
    await Promise.all(
      cssFiles.map((file) => {
        const targetFile = file.replace(sourceFolder, targetFolder);
        //ensure the target folder exists
        const targetDir = path.dirname(targetFile);
        if (!fs.existsSync(targetDir)) {
          fs.mkdirSync(targetDir, {recursive: true});
        }
        return fs.copyFile(file, targetFile);
      }),
    );
    copySpinner.succeed(`${cssFiles.length} CSS files copied`);
  } catch (e) {
    console.error(e);
    copySpinner.fail('Failed to copy CSS files');
  }
  return true;
};

export const upgradePackages = async () => {
  await ensureEnvironmentLoaded();
  // let packages = getLincdPackages();
  // let packages = getLocalLincdModules();
  let packages = getLocalLincdPackageMap();
  let dirname = getScriptDir();
  const tsConfigCJS = path.join(
    dirname,
    '../../defaults/package',
    'tsconfig-cjs.json',
  );
  const tsConfigESM = path.join(
    dirname,
    '../../defaults/package',
    'tsconfig-esm.json',
  );
  const typesFile = path.join(
    dirname,
    '../../defaults/package/src',
    'types.d.ts',
  );

  const tsConfigTemplate = await fs
    .readJson(path.join(dirname, '../../defaults/package', 'tsconfig.json'))
    .catch((err) => {
      console.log(err);
    });
  runOnPackagesGroupedByDependencies(
    packages,
    (packageGroup, dependencies) => {
      // packageGroup.forEach((pkg) => {
      //   console.log(' Upgrading ' + pkg.packageName);
      console.log('-----');
      return async (pkg: PackageDetails) => {
        if (pkg.packageName === 'lincd') return;
        // await execPromise(`cd ${pkg.path} && yarn upgrade`);
        console.log('Upgrading ' + pkg.packageName);
        //
        // //create a new file src/tsconfig-cjs.json
        // //copy the contents of tsconfig.json into it
        // if (!fs.existsSync(path.join(pkg.path,'tsconfig-cjs.json')))
        // {
        //   await fs.copy(tsConfigCJS,path.join(pkg.path,'tsconfig-cjs.json'));
        //   await fs.copy(tsConfigESM,path.join(pkg.path,'tsconfig-esm.json'));
        //   console.log('Copied new tsconfig to ' + pkg.packageName);
        // }
        //
        // //read tsconfig
        // await fs.readJson(path.join(pkg.path,'tsconfig.json')).then((tsconfig) => {
        //   let oldCompilerOpts = tsconfig.compilerOptions;
        //   tsconfig.compilerOptions = tsConfigTemplate.compilerOptions;
        //   tsconfig.compilerOptions.types = oldCompilerOpts.types;
        //   tsconfig.compilerOptions.plugins = [{"name": "typescript-plugin-css-modules"}];
        //
        //   console.log('Upgraded tsconfig for ' + pkg.packageName);
        //   return fs.writeJson(path.join(pkg.path,'tsconfig.json'),tsconfig,{spaces: 2});
        // });
        // //import types at the beginning of index.ts
        // addLineToIndex(`import './types';`,null,pkg.path,true);
        // //copy over the types file
        // await fs.copy(typesFile,path.join(pkg.path,'src','types.d.ts'));

        // await fs.readJson(path.join(pkg.path,'package.json')).then((packageJson) => {
        //   let version = packageJson.version;
        //   let nextVersion;
        //   if (version.split('.').shift() === '0')
        //   {
        //     nextVersion = getNextMajorVersion(version);
        //   }
        //   else
        //   {
        //     nextVersion = getNextMinorVersion(version);
        //   }
        //   console.log('Upgraded version for ' + pkg.packageName + ' to ' + nextVersion);
        //
        //   packageJson.version = nextVersion;
        //   packageJson.devDependencies['tsconfig-to-dual-package'] = '^1.2.0';
        //   packageJson.devDependencies['typescript-plugin-css-modules'] = '^5.1.0';
        //
        //   packageJson.main = 'lib/cjs/index.js';
        //   packageJson.module = 'lib/esm/index.js';
        //   packageJson.exports = {
        //     '.': {
        //       'types': './lib/esm/index.d.ts',
        //       'import': './lib/esm/index.js',
        //       'require': './lib/cjs/index.js',
        //     },
        //     './*': {
        //       'types': './lib/esm/*.d.ts',
        //       'import': './lib/esm/*.js',
        //       'require': './lib/cjs/*.js',
        //     },
        //   };
        //   packageJson.typesVersions = {
        //     '*': {
        //       '*': [
        //         'lib/esm/*',
        //       ],
        //     },
        //   };
        //
        //   return fs.writeJson(path.join(pkg.path,'package.json'),packageJson,{ spaces: 2 });
        // });

        //change .css files and .scss files to .module.css and .module.scss
        let files = await getFiles(path.join(pkg.path, 'src'));
        // let tsFiles = files.filter(f => f.match(/\.(ts|tsx)$/));
        // let cssFiles = files.filter(f => f.match(/\.(css|scss)$/)).filter(f => !f.match(/\.module\.(css|scss)$/));
        // cssFiles.forEach(cssFile => {
        //   let cssFileName = path.basename(cssFile);
        //   let newFile = cssFileName.replace(/\.s?css$/,'.module$&');
        //   let newFilePath = cssFile.replace(/\.s?css$/,'.module$&');
        //   let jsonFile = cssFileName.replace(/\.s?css$/,'$&.json');
        //   fs.renameSync(cssFile,newFilePath);
        //   console.log('Renaming ' + cssFileName + ' to ' + newFilePath);
        //   //find other files that import this file and update them
        //   tsFiles.forEach(tsFile => {
        //     //read contents of f2
        //     let contents = fs.readFileSync(tsFile,'utf8');
        //     //if it imports f
        //     if (contents.indexOf(cssFileName) !== -1)
        //     {
        //       //find the whole line that imports f
        //       let line = contents.split('\n').find(l => l.indexOf(cssFileName) !== -1);
        //       // console.log("OLD: "+line);
        //       let jsonLine = contents.split('\n').find(l => l.indexOf(jsonFile) !== -1);
        //       // console.log("JSON: "+jsonLine);
        //       //if not commented out
        //       if(line.indexOf('//') === -1) {
        //         let previousImportPath = line.match(/['"](.*)['"]/)[1];
        //         let newImportPath = previousImportPath.replace(cssFileName,newFile);
        //         let newContents = contents.replace(line,`import style from '${newImportPath}';`)
        //           .replace(jsonLine+'\n','');
        //         // console.log("\n");
        //         fs.writeFileSync(tsFile,newContents);
        //         console.log('Updated imports in ' + tsFile);
        //         // fs.writeFileSync
        //         // fs.writeFileSync(i,fs.readFileSync(i,'utf8').replace(f,newFile));
        //       }
        //     }
        //   })
        // });
        files
          .filter((f) => f.match(/\.(scss\.json|css\.json)$/))
          .forEach((cssJsonFile) => {
            console.log('Removing ' + cssJsonFile);
            fs.unlinkSync(cssJsonFile);
          });
      };
      // });
    },
    () => {
      console.log('Finished upgrading packages');
    },
  );

  // packages.forEach((pkg,key) => {
  //   console.log(key+' Upgrading ' + pkg.packageName);
  // execPromise(`cd ${pkg.path} && yarn upgrade`).then(() => {
  //   console.log('Upgraded ' + pkg.packageName);
  // }).catch(err => {
  //   console.warn(err);
  // })
  // });
};

export const createPackage = async (
  name,
  uriBase?,
  basePath = process.cwd(),
) => {
  if (!name) {
    console.warn('Please provide a name as the first argument');
    return;
  }

  //if ran with npx, basePath will be the root directory of the repository, even if we're executing from a sub folder (the root directory is where node_modules lives and package.json with workspaces)
  //so we manually find a packages folder, if it exists we go into that.
  if (fs.existsSync(path.join(basePath, 'packages'))) {
    basePath = path.join(basePath, 'packages');
  }
  //for lincd.org currently packages are stored in the modules folder
  else if (fs.existsSync(path.join(basePath, 'modules'))) {
    basePath = path.join(basePath, 'modules');
  }

  //let's remove scope for variable names
  let [packageName, scope, cleanPackageName] = name.match(
    /(@[\w\-]+\/)?([\w\-]+)/,
  );

  let targetFolder = ensureFolderExists(basePath, cleanPackageName);

  if (!uriBase) {
    uriBase = 'http://lincd.org/ont/' + name;
  }
  setVariable('uri_base', uriBase + '/');

  //find @scope and the next part between 2 slashes after
  //so @dacore/some-mod/lib/file.js
  // --> match[0] = @dacore/some-mod
  // --> match[1] = @dacore
  // --> match[2] = some-mod

  //but save full scoped package name under ${package_name}
  setVariable('package_name', name);

  //extra variable for clarity (will be same as 'name')
  setVariable('output_file_name', name);

  let {hyphenName, camelCaseName, underscoreName} =
    setNameVariables(cleanPackageName);

  log("Creating new LINCD package '" + name + "'");
  fs.copySync(
    path.join(getScriptDir(), '..', '..', 'defaults', 'package'),
    targetFolder,
  );
  renameShippedDotfiles(targetFolder);

  //replace variables in some of the copied files
  await Promise.all(
    [
      'src/index.ts',
      'package.json',
      'Gruntfile.js',
      'src/package.ts',
      'src/ontologies/example-ontology.ts',
      'src/data/example-ontology.json',
    ]
      .map((f) => path.join(targetFolder, f))
      .map((file) => {
        return replaceVariablesInFile(file);
      }),
  );

  //rename these to a file name similar to the pkg name
  [
    'src/ontologies/example-ontology.ts',
    'src/data/example-ontology.json',
    'src/data/example-ontology.json.d.ts',
  ].forEach((f) => {
    let parts = f.split('/');
    let newParts = [...parts];
    let [name, ...extensions] = newParts.pop().split('.');
    let newName = hyphenName + '.' + extensions.join('.');
    console.log(
      'rename ',
      path.join(targetFolder, f),
      path.join(targetFolder, ...newParts, newName),
    );
    fs.renameSync(
      path.join(targetFolder, f),
      path.join(targetFolder, ...newParts, newName),
    );
  });

  // npm is the default for a new package. yarn is only consulted when the new
  // package lands inside an existing yarn project (an mrgit/yarn-3 monorepo),
  // where adding an npm lockfile would break the workspace.
  const insideYarnProject =
    detectPackageManager(path.dirname(path.resolve(targetFolder))) === 'yarn';
  let version = insideYarnProject
    ? ((await execPromise('yarn --version').catch(() => {
        console.log('yarn probably not working');
        return '';
      })) as string)
    : '';
  const setup = planPackageSetup(
    version.toString(),
    path.join(getScriptDir(), 'launch.js'),
    process.execPath,
    insideYarnProject,
  );
  if (setup.yarnrc) {
    fs.writeFileSync(path.join(targetFolder, '.yarnrc.yml'), setup.yarnrc);
  }
  const installed = await execp(setup.installCommand, true, false, {
    cwd: targetFolder,
  })
    .then(() => true)
    .catch(() => {
      console.warn(`Could not install dependencies (${setup.installCommand})`);
      process.exitCode = 1;
      return false;
    });
  if (installed) {
    await execp(setup.buildCommand, true, false, {cwd: targetFolder}).catch(
      () => {
        console.warn('Dependencies installed, but the initial build failed');
        process.exitCode = 1;
      },
    );
  }

  log(
    `Prepared a new LINCD package in ${chalk.magenta(targetFolder)}`,
    `Run ${chalk.blueBright(
      runScriptCommand(setup.packageManager, 'build'),
    )} from this directory to build once`,
    `Or ${chalk.blueBright(
      runScriptCommand(setup.packageManager, 'start'),
    )} to continuously rebuild on file changes`,
  );
};

var getNextVersion = function (version) {
  let parts = version.split('.');
  return parts[0] + '.' + parts[1] + '.' + (parseInt(parts[2]) + 1).toString();
};
var getNextMajorVersion = function (version) {
  let parts = version.split('.');
  return (parseInt(parts[0]) + 1).toString() + '.0.0';
};
var getNextMinorVersion = function (version) {
  let parts = version.split('.');
  return parts[0] + '.' + (parseInt(parts[1]) + 1).toString() + '.0';
};
var buildFailed = function (output: string) {
  return (
    output.indexOf('Aborted due to warnings') !== -1 &&
    output.indexOf('Command failed') !== -1
  );
};

export const register = function (registryURL) {
  if (fs.existsSync(process.cwd() + '/package.json')) {
    var pack = JSON.parse(
      fs.readFileSync(process.cwd() + '/package.json', 'utf8'),
    );
    let version = pack.version;
    let packageName = pack.name;
    // let author = pack.author;
    // let description = pack.description;
    //
    // let authorName = pack.author;
    // if (pack.author.name) {
    //   authorName = pack.author.name;
    // }

    console.log(
      chalk.cyan(
        'registering package ' +
          packageName +
          ' ' +
          version +
          ' in the LINCD registry',
      ),
    );

    return fetch(registryURL + '/register', {
      method: 'POST',
      headers: {
        Accept: 'application/json, text/plain, */*',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({package: packageName, version}),
      // body: JSON.stringify({package: packageName, version, author}),
    })
      .then((res) => res.json())
      .then((json) => {
        if (json.error) {
          console.log(chalk.red('Response: ' + json.error));
        } else if (json.result) {
          console.log(chalk.blueBright('Response: ') + json.result);
          if (json.warning) {
            console.log(chalk.red('Warning: ') + json.warning);
          }
        }
      })
      .catch((err) => {
        console.warn(
          chalk.red('Warning: ') + 'Could not connect to LINCD registry',
        );
      });
  } else {
    console.warn(
      chalk.red('Warning:') + ' not found: ' + process.cwd() + '/package.json',
    );
  }
};

export const buildPackage = async (
  target,
  target2,
  packagePath = process.cwd(),
  logResults: boolean = true,
) => {
  // Ensure packagePath is absolute and points to a directory containing package.json; if not, go up until we find one
  // First, resolve to absolute path
  let currentPath = path.isAbsolute(packagePath) 
    ? packagePath 
    : path.resolve(process.cwd(), packagePath);
  while (!fs.existsSync(path.join(currentPath, 'package.json'))) {
    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) {
      // Reached root and didn't find package.json. Optionally, handle this error.
      console.error(
        'No package.json found in ' +
          packagePath +
          ' or any parent directories',
      );
      return false;
    }
    currentPath = parentPath;
  }
  // Always use the resolved absolute path
  packagePath = currentPath;

  // Guard: `linked build` only makes sense for linkedPackage. Apps must use
  // `linked build-app`. Plain packages (no linked flag) have no build pipeline
  // defined here and should have their own build script.
  const pkgJson = JSON.parse(
    fs.readFileSync(path.join(packagePath, 'package.json'), 'utf8'),
  );
  const isPackage = pkgJson.linkedPackage === true;
  const isApp = pkgJson.linkedApp === true;
  if (!isPackage) {
    if (isApp) {
      console.error(
        chalk.red(
          `'${pkgJson.name || packagePath}' is a linkedApp, not a linkedPackage. Use 'linked build-app' instead of 'linked build'.`,
        ),
      );
    } else {
      console.error(
        chalk.red(
          `'${pkgJson.name || packagePath}' does not have 'linkedPackage: true' in package.json. 'linked build' only builds linked packages. Add the flag or run a different build command.`,
        ),
      );
    }
    return false;
  }

  let spinner: Ora;
  if (logResults) {
    //TODO: replace with listr so we can show multiple processes at once
    spinner = ora({
      discardStdin: true,
      text: 'Compiling ESM',
    }).start();
  }
  let buildProcess: Promise<boolean | string | void> = Promise.resolve(true);
  let warned = false;
  let buildStep = (step) => {
    buildProcess = buildProcess.then((previousResult) => {
      if (!previousResult) {
        return false;
      }
      if (logResults) {
        spinner.text = step.name;
        spinner.start();
      }
      return step.apply().then((stepResult) => {
        //if a build step returns a string,
        //a warning is shown but the build is still successful with warnings
        if (typeof stepResult === 'string') {
          warned = true;
          if (logResults) {
            spinner.warn(step.name + ' - ' + stepResult);
            spinner.stop();
          } else {
            console.warn(chalk.yellow(step.name + ' - ' + stepResult));
          }
          //can still continue
          return true;
        } else if (stepResult === true || typeof stepResult === 'undefined') {
          if (logResults) {
            spinner.succeed();
          }
          return previousResult && true;
        } else if (
          //a step may report a detail alongside success, e.g. how many files
          //it changed. Not a warning: the build stays clean.
          stepResult &&
          typeof stepResult === 'object' &&
          (stepResult as any).info
        ) {
          if (logResults) {
            spinner.succeed(step.name + ' - ' + (stepResult as any).info);
          }
          return previousResult && true;
        } else if (
          stepResult &&
          typeof stepResult === 'object' &&
          (stepResult as any).error
        ) {
          if (logResults) {
            spinner.fail(step.name + ' - ' + (stepResult as any).error);
            spinner.stop();
          } else {
            console.error(
              chalk.red(step.name + ' - ' + (stepResult as any).error),
            );
          }
          //failed and should stop
          return false;
        }
        //anything else — notably a literal false, which several steps return
        //on failure — is a failure. Name the step, so the build does not end
        //on a bare 'Build failed'.
        const failure = step.name + ' failed';
        if (logResults) {
          spinner.fail(failure);
          spinner.stop();
        } else {
          console.error(chalk.red(failure));
        }
        return false;
      });
    });
  };

  planBuildSteps(pkgJson, packagePath).forEach(buildStep);

  let success = await buildProcess.catch((err) => {
    let msg =
      typeof err === 'string' || err instanceof Error
        ? err.toString()
        : err.error && !err.error.toString().includes('Command failed:')
          ? err.error
          : err.stdout + '\n' + err.stderr;
    if (logResults) {
      spinner.stopAndPersist({
        symbol: chalk.red('✖'),
        // text: 'Build failed',
      });
      console.log(msg);
    } else {
      console.error(
        chalk.red(packagePath.split('/').pop(), ' - Build failed:'),
      );
      console.error(err);
    }
    //a failed build always resolves to false, never to a truthy message:
    //callers decide success by the return value.
    return false;
  });
  if (success === true) {
    if (logResults) {
      spinner.stopAndPersist({
        symbol: chalk.greenBright('✔'),
        text: warned ? 'Build successful with warnings' : 'Build successful',
      });
    }
  } else {
    if (logResults) {
      spinner.stopAndPersist({
        symbol: chalk.red('✖'),
        text: 'Build failed',
      });
    }
  }
  //true only when every step succeeded (warnings included); false otherwise.
  return success === true;
};

type BuildStep = {
  name: string;
  // true/undefined: success; {info}: success with a note; a string: success
  // with a warning; false/{error}: stop.
  apply: () => Promise<unknown>;
};

// The ordered `linked build` steps for a linkedPackage. Source may use
// extensionless relative imports: once `lib/esm` holds everything it will ship,
// every package gets `.js` added to the relative specifiers in it (JS and
// declarations). For a package that already writes `.js` this is a no-op.
export const planBuildSteps = (pkgJson, packagePath: string): BuildStep[] => [
  {
    name: 'Checking imports',
    apply: () => checkImports(packagePath + '/src'),
  },
  {
    name: 'Compiling ESM',
    apply: async () => {
      return compilePackageESM(packagePath);
    },
  },
  {
    name: 'Compiling CJS',
    apply: async () => {
      return compilePackageCJS(packagePath);
    },
  },
  {
    name: 'Copying files to lib folder',
    apply: async () => {
      const files = await glob(packagePath + '/src/**/*.{json,d.ts,css,scss}');
      return Promise.all(
        files.map(async (file) => {
          try {
            await fs.copy(
              file,
              packagePath +
                '/lib/esm/' +
                file.replace(packagePath + '/src/', ''),
            );
            await fs.copy(
              file,
              packagePath +
                '/lib/cjs/' +
                file.replace(packagePath + '/src/', ''),
            );
            return true;
          } catch (err) {
            console.warn(err);
            return false;
          }
        }),
      ).then((allResults) => {
        return allResults.every((r) => r === true);
      });
    },
  },
  {
    name: 'Dual package support',
    apply: () => {
      // Skip if no tsconfig files (e.g. pure-CSS packages).
      if (
        !fs.existsSync(path.join(packagePath, 'tsconfig-esm.json')) ||
        !fs.existsSync(path.join(packagePath, 'tsconfig-cjs.json'))
      ) {
        return Promise.resolve(true);
      }
      // Resolve the binary from the nearest node_modules (supports both
      // per-package and workspace-root installs of tsconfig-to-dual-package).
      return execPromise(
        'npx tsconfig-to-dual-package ./tsconfig-cjs.json ./tsconfig-esm.json',
        false,
        false,
        {cwd: packagePath},
      ).then((res) => {
        return res === '';
      });
    },
  },
  {
    name: 'Removing old files from lib folder',
    apply: async () => {
      return removeOldFiles(packagePath);
    },
  },
  {
    // MUST run after 'Copying files to lib folder' and after 'Removing old
    // files from lib folder', because the rewrite resolves each specifier
    // against the files actually present in lib/esm:
    // - the copy step brings in the assets (`./x.scss`) and hand-written
    //   `.d.ts` from src; before it, an asset import looks unresolvable (a
    //   spurious "build with warnings") and a copied `.d.ts` is never rewritten;
    // - the cleanup step deletes stale output; before it, a leftover `x.js`
    //   makes './x' resolve to './x.js' and the cleanup then removes the file
    //   the specifier now points at.
    name: 'Rewriting ESM import specifiers',
    apply: async () => {
      // No tsconfig-esm.json means the ESM compile was skipped (e.g. pure-CSS
      // packages), so there is nothing to rewrite and nothing to fail over.
      if (!fs.existsSync(path.join(packagePath, 'tsconfig-esm.json'))) {
        return true;
      }
      const libEsm = path.join(packagePath, 'lib', 'esm');
      if (!fs.existsSync(libEsm)) {
        return {
          error:
            'lib/esm was not emitted while tsconfig-esm.json is present. Check the ESM compile.',
        };
      }
      const {changed, unresolved} = await rewriteExtensionlessImports(libEsm);
      if (unresolved.length > 0) {
        return `could not resolve ${unresolved.length} import(s), left unchanged: ${unresolved.join(', ')}`;
      }
      return changed > 0 ? {info: `rewrote ${changed} file(s)`} : true;
    },
  },
  {
    name: 'Checking dependencies',
    apply: () => depCheck(packagePath),
  },
];

export const compilePackage = async (packagePath = process.cwd()) => {
  //echo 'compiling CJS' && tsc -p tsconfig-cjs.json && echo 'compiling ESM' && tsc -p tsconfig-esm.json
  // let cjsConfig = fs.existsSync(path.join(packagePath,'tsconfig-cjs.json'));
  // let esmConfig = fs.existsSync(path.join(packagePath,'tsconfig-esm.json'));
  // let compileCJS = `yarn exec tsc -p tsconfig-cjs.json`;
  // let compileESM = `yarn exec tsc -p tsconfig-esm.json`;
  // let compileCommand;
  // if (cjsConfig && esmConfig)
  // {
  //   compileCommand = `${compileCJS} && ${compileESM}`;
  // }
  // else if (cjsConfig)
  // {
  //   compileCommand = compileCJS;
  // }
  // else if (esmConfig)
  // {
  //   compileCommand = compileESM;
  // }
  // else
  // {
  //   compileCommand = `yarn exec tsc`;
  // }
  await compilePackageESM(packagePath);
  await compilePackageCJS(packagePath);
};
export const compilePackageESM = async (packagePath = process.cwd()) => {
  // Skip packages without a tsconfig-esm.json (e.g. pure-CSS packages).
  if (!fs.existsSync(path.join(packagePath, 'tsconfig-esm.json'))) {
    return true;
  }
  let compileCommand = `npx tsc -p tsconfig-esm.json`;
  return execPromise(compileCommand, false, false, {cwd: packagePath}).then(
    (res) => {
      return res === '';
    },
  );
};
export const compilePackageCJS = async (packagePath = process.cwd()) => {
  // Skip packages without a tsconfig-cjs.json.
  if (!fs.existsSync(path.join(packagePath, 'tsconfig-cjs.json'))) {
    return true;
  }
  let compileCommand = `npx tsc -p tsconfig-cjs.json`;
  return execPromise(compileCommand, false, false, {cwd: packagePath})
    .then((res) => {
      return res === '';
    })
    .catch((err) => {
      return {
        error: err.stdout,
      };
    });
};

export var publishUpdated = function (test: boolean = false) {
  let packages = getLocalLincdModules();

  var p: Promise<any> = Promise.resolve('');
  let packagesLeft = packages.length;
  let results = [];
  log(
    'Checking which packages need to be published by comparing last published date with last git commit',
  );
  // p = Promise.all(packages.map((pckg) => {
  packages.forEach((pckg) => {
    p = p
      .then((previousResult) => {
        // progressUpdate(packagesLeft-- + ' packages left. Now checking ' + pckg.packageName);
        log('# Checking package ' + pckg.packageName);
        // log('# Requesting ' + 'yarn info '+pkg.packageName+' --json');
        // return execPromise('yarn info '+pkg.packageName+' --json').then((output:string) => {
        // console.log("Will be requesting npm view from this current working directory:\n"+process.cwd());
        // return execPromise('npm view '+pkg.packageName+' --json').then((output:string) => {

        let shouldPublish;
        var pack = getPackageJSON(pckg.path);
        let version = getNextVersion(pack.version);
        if (pack.private) {
          shouldPublish = false;
          debugInfo(chalk.blue('--> is private, skipping'));

          return chalk.gray(pckg.packageName + ' is private');
          // return previousResult + ' ' + chalk.gray(pckg.packageName + ' is private\n');
        }
        console.log('testing npm');
        return execPromise('npm info ' + pckg.packageName + ' --json')
          .then(async (output: string) => {
            console.log('testing npm done');
            var info;
            try {
              if (output == '' || output.includes('E404')) {
                debugInfo(
                  'Empty or 404 response from `npm info`. This package was probably not published before',
                );
                // throw new Error('Empty response from `yarn info`. This pkg was probably not published before');
                // return;
                shouldPublish = true;
                //don't patch the version number (default, see above), use the current version
                version = pack.version;
              } else {
                info = JSON.parse(output);
              }

              if (info) {
                let lastPublish;
                //yarn:
                // let lastPublish = info.data.time[info.data.version];
                lastPublish = info.time[info.version];
                // }
                // catch (e) {
                //   console.log(info);
                //   console.error(chalk.red("Could not parse response from npm info. Format may have changed?"));
                //   process.exit();
                // }

                let lastPublishDate = new Date(lastPublish);
                // let {lastModifiedTime, lastModifiedName, lastModified} = getLastModifiedSourceTime(pkg.path);
                let lastCommitInfo = await getLastCommitTime(pckg.path);
                if (!lastCommitInfo) {
                  shouldPublish = false;
                  debugInfo('Could not determine last git commit');
                  // return previousResult + ' ' + chalk.red(pckg.packageName + ' - could not determine last commit\n');
                  return chalk.red(
                    pckg.packageName + ' - could not determine last commit',
                  );
                } else {
                  //NOTE: removed lastModified, because switching branches will say that the file was modified and cause everything to publish
                  //SO: now you NEED TO commit before it picks up that you should publish
                  shouldPublish =
                    lastPublishDate.getTime() < lastCommitInfo.date.getTime();

                  //ignore changes to package.json if that's the only change, because when we publish the version number changes, which is then committed
                  //(note there is always 2 lines for commit info + number of files changed)
                  let changedFiles = lastCommitInfo.changes
                    .split('\n')
                    .filter((line) => line.includes('|'));
                  let numberOfFilesChanges = changedFiles.length;
                  // console.log("CHECK "+lastCommitInfo.changes.includes("package.json")+" - "+numberOfFilesChanges)
                  if (
                    shouldPublish &&
                    lastCommitInfo.changes.includes('package.json') &&
                    numberOfFilesChanges === 1
                  ) {
                    shouldPublish = false;
                  }
                  if (shouldPublish) {
                    log(
                      chalk.magenta(pckg.packageName) +
                        ' should be published because:',
                    );
                    log(
                      lastPublishDate.toDateString() +
                        ' ' +
                        lastPublishDate.toTimeString() +
                        ' published ' +
                        info.version,
                    );
                    log(
                      lastCommitInfo.date.toDateString() +
                        ' ' +
                        new Date(lastCommitInfo.date).toTimeString() +
                        ' source last committed:',
                    );
                    log(lastCommitInfo.changes);
                  }
                }
              }
            } catch (err) {
              // var stats = fs.statSync(path.join(packageDirectory));
              // var files = fs.readdirSync(path.join(packageDirectory,'src'));
              console.log(
                chalk.red(pckg.packageName + ' failed: ' + err.message + '\n'),
              );
              console.warn('Returned JSON from npm: ' + output);
              // return previousResult + ' ' + chalk.red(pckg.packageName + ' failed: ' + err.message + '\n');
              return chalk.red(pckg.packageName + ' failed: ' + err.message);
            }
            if (shouldPublish) {
              return publishPackage(pckg, test, info, version);
            }
            return (
              chalk.blue(pckg.packageName) + ' latest version is up to date'
            );
          })
          .catch(({error, stdout, stderr}) => {
            if (error) {
              console.error(error.message);
            }
            if (stdout) {
              console.log(stderr);
            }
            if (stderr) {
              console.log(stderr);
            }
            // return previousResult + ' ' + chalk.red(pckg.packageName + ' failed\n');
            console.warn(chalk.red(pckg.packageName + ' failed'));
            return chalk.red(pckg.packageName + ' failed');
          });
      })
      .then((res) => {
        log(res);
        results.push(res);
      })
      .catch((err) => {
        console.warn(
          chalk.red(pckg.packageName + ' failed: ' + err.toString()),
        );
        results.push(
          chalk.red(pckg.packageName + ' failed: ' + err.toString()),
        );
      });
  });
  return p.then(() => {
    // if (messages == '')
    // {
    //   console.log('All published packages are already up-to-date.');
    // }
    // else
    // {
    console.log(
      'Summary:                                \n' + results.join('\n'),
    );
    // }
  });
};

async function getEnvJsonPath(relativeToPath = process.cwd()) {
  let path = '';
  if (!relativeToPath.endsWith('/')) {
    relativeToPath += '/';
  }
  // let path = './';
  for (let i = 0; i <= 10; i++) {
    let envFile = await getEnvFile({
      filePath: relativeToPath + path + '.env.json',
    }).catch((err) => {
      return null;
    });
    if (envFile) {
      //note: we're getting the actual contents here, so we could also use that more directly?
      return path + '.env.json';
    }
    path += '../';
  }
}

export var publishPackage = async function (
  pkg?,
  test?,
  info?,
  publishVersion?,
) {
  if (!pkg) {
    let localPackageJson = getPackageJSON();
    pkg = {
      path: process.cwd(),
      packageName: localPackageJson.name,
    };
  }
  if (!publishVersion) {
    publishVersion = info ? getNextVersion(info.version) : 'patch';
  }
  if (test) {
    debugInfo('should publish ' + pkg.packageName + ' ' + publishVersion);
    //when testing what needs to be published
    return chalk.blue(pkg.packageName + ' should publish');
  }
  console.log(
    chalk.blue('publishing ' + pkg.packageName + ' ' + publishVersion),
  );

  //looking for an .env.json file in our workspace, which may store our NPM AUTH key
  let envJsonPath = await getEnvJsonPath(pkg.path);

  // `yarn version` / `yarn npm publish` is Yarn Berry syntax. Only use it when
  // the package really lives in a yarn project; otherwise publish with npm.
  const publishPm = detectPackageManager(pkg.path);
  const versionAndPublish =
    publishPm === 'yarn'
      ? `yarn version ${publishVersion} && yarn npm publish`
      : `npm version ${publishVersion} --no-git-tag-version && npm publish`;

  return execPromise(
    `cd ${pkg.path} && ${
      envJsonPath ? `env-cmd -f ${envJsonPath} --use-shell "` : ''
    }${versionAndPublish}${envJsonPath ? `"` : ''}`,
    true,
    false,
    {},
    true,
  )
    .then((res) => {
      if (
        res.indexOf('Aborted due to warnings') !== -1 ||
        res.indexOf('Could not publish') !== -1 ||
        res.indexOf("Couldn't publish") !== -1
      ) {
        console.log(res);
        return chalk.red(pkg.packageName + ' failed\n');
      }

      console.log(
        'Successfully published ' +
          chalk.green(pkg.path) +
          ' ' +
          chalk.magenta(publishVersion),
      );
      return (
        chalk.green(pkg.packageName) +
        ' published ' +
        chalk.magenta(publishVersion)
      );
    })
    .catch(({error, stdout, stderr}) => {
      logError('Failed to publish: ' + error.message);
      return chalk.red(pkg.packageName + ' failed to publish');
    });
};

export var buildUpdated = async function (
  back,
  target,
  target2,
  useGitForLastModified: boolean = false,
  test: boolean = false,
) {
  // back = back || 1;
  // return execPromise(`git log -${back} --format=%ci`).then((result) => {
  // let now = new Date();
  let previousResult = '';
  log(
    test
      ? 'Checking which packages need to be rebuild'
      : 'Building updated packages',
  );
  // let packages = getLocalLincdModules();
  let packages = getLocalLincdPackageMap();

  // console.log(packages);
  // let jsonldPkgUpdated = await needsRebuilding(
  //   packages.get('lincd-jsonld'),
  //   useGitForLastModified,
  // );
  // let cliPkgUpdated = await needsRebuilding(packages.get('lincd-cli'), useGitForLastModified);

  //if either cli or jsonldPkg needs to be rebuilt
  // if (jsonldPkgUpdated || cliPkgUpdated) {
  // if (jsonldPkgUpdated)
  // {
  //   await execPromise(
  //     'yarn exec tsc && echo "compiled lincd-jsonld"',
  //     false,
  //     false,
  //     {
  //       cwd: packages.get('lincd-jsonld').path,
  //     },
  //     true,
  //   );
  //   // await execPromise('yarn build-core', false, false, {}, true);
  // }
  let rebuildAllModules = false;
  // if (cliPkgUpdated) {
  //   rebuildAllModules = true;
  //   log(chalk.magenta('Rebuilding all packages because the build tools (lincd-cli) got updated'));
  // }

  let packagesLeft = packages.size;
  runOnPackagesGroupedByDependencies(
    packages,
    (packageGroup, dependencies) => {
      debugInfo(
        'Now checking: ' + chalk.blue(packageGroup.map((i) => i.packageName)),
      );
      debugInfo(packagesLeft + ' packages left.');

      packagesLeft = packagesLeft - packageGroup.length;
      return async (pkg: PackageDetails) => {
        // debugInfo('# Checking package ' + pkg.packageName);
        let needRebuild = await needsRebuilding(
          pkg,
          useGitForLastModified,
          // true,
        );

        // if (pkg.packageName === 'lincd-jsonld' && jsonldPkgUpdated)
        // {
        //   needRebuild = true;
        // }
        if (needRebuild || rebuildAllModules) {
          //TODO: when building a pkg, also rebuild all packages that depend on this package.. and iteratively build packages that depend on those packages..

          // log(packageName+' modified since last commit on '+now.toString());

          if (test) {
            debugInfo('Need to build ' + pkg.packageName);
            return chalk.blue(pkg.packageName + ' should be build');
          }
          log('Building ' + pkg.packageName);
          const pathToBuild = pkg.path.startsWith('.')
            ? path.join(process.cwd(), pkg.path)
            : pkg.path;
          //if the path is relative,
          // log('path: ' + pathToBuild);
          return buildPackage(null, null, pathToBuild, false)
            .then((res) => {
              //buildPackage returns true only when the build succeeded
              //(warnings included); anything else is a failure.
              if (res !== true) {
                logError('Failed to build ' + pkg.packageName);
                process.exit(1);
              } else {
                debugInfo(chalk.green(pkg.packageName + ' successfully built'));
                return chalk.green(pkg.packageName + ' built');
              }
            })
            .catch((err) => {
              logError(
                'Failed to build ' + pkg.packageName + '. ' + err.message,
              );
              //console.error(err);
              process.exit(1);
            });
        }
      };
    },
    (dependencies, results) => {
      if (results.length) {
        log(chalk.green('Changed packages have been rebuilt'));
        log('Summary:');
        log(results.join('\n'));
      } else {
        log(chalk.green('Nothing to rebuild'));
      }
    },
  );

  return;
};

const printBuildResults = function (failed, done) {
  if (done.size > 0 || done.length > 0) {
    log(
      'Successfully built: ' +
        chalk.green([...done].map((m) => m.packageName).join(', ')) +
        '\n',
    );
  }
  if (failed.length > 0) {
    warn('Failed to build: ' + chalk.red(failed.join(', ')) + '\n');
  }
};

export var executeCommandForEachPackage = function (
  packages,
  command,
  filterMethod,
  filterValue,
) {
  //if a specific set of packages is given
  if (filterMethod == 'exclude') {
    //filter packages, so that we only execute on the packages as provided in the command
    log('Excluding ' + filterValue);
    filterValue = filterValue.split(',');
    packages = packages.filter(
      (pkg) => filterValue.indexOf(pkg.packageName) === -1,
    );
  }
  let startFrom: string;
  //by default start executing, unless 'from' is given
  let executing: boolean = true;
  //option to start from a specific pkg in the stack
  if (filterMethod == 'from') {
    startFrom = filterValue;
    if (startFrom) {
      console.log(chalk.blue('Will skip ahead to ' + startFrom));
    }
    let seen = false;
    packages = packages.filter((pkg) => {
      if (!seen && pkg.packageName.includes(startFrom)) {
        seen = true;
      }
      return seen;
    });
  }

  log(
    "Executing '" +
      chalk.blueBright(command) +
      "' on packages " +
      chalk.magenta(packages.map((m) => m.packageName).join(', ')),
  );

  var p = Promise.resolve(true);
  packages.forEach((pkg) => {
    p = p.then(() => {
      log('# Package ' + chalk.magenta(pkg.packageName));
      return execp('cd ' + pkg.path + ' && ' + command);
    });
  });
  return p;
};

var gitIgnore = function (...entries) {
  //add each entry to the .gitignore file
  let gitIgnorePath = path.resolve(process.cwd(), '.gitignore');
  addLinesToFile(gitIgnorePath, entries);
};
export var addLinesToFile = function (filePath, entries) {
  let fileContents = fs.readFileSync(filePath, {encoding: 'utf8'});
  entries.forEach((entry) => {
    fileContents += '\n' + entry;
  });
  fs.writeFileSync(filePath, fileContents);
};
export var addCapacitor = async function (basePath = process.cwd()) {
  let targetFolder = ensureFolderExists(basePath);

  log('Adding capacitor');
  fs.copySync(
    path.join(getScriptDir(), '..', '..', 'defaults', 'app-static'),
    targetFolder,
  );
  fs.copySync(
    path.join(getScriptDir(), '..', '..', 'defaults', 'capacitor', 'scripts'),
    path.join(targetFolder, 'scripts'),
  );

  //update .env-cmdrc.json file
  let envCmdPath = path.resolve(basePath, '.env-cmdrc.json');
  let envCmd = JSON.parse(fs.readFileSync(envCmdPath, {encoding: 'utf8'}));

  envCmd['app-main'] = {
    APP_ENV: true,
    OUTPUT_PATH: './public/assets',
    ASSET_PATH: './assets/',
    ENTRY_PATH: './src/index-static.tsx',
  };
  envCmd['app-local-android'] = {
    NODE_ENV: 'app',
    SITE_ROOT: 'http://10.0.2.2:4000',
  };
  envCmd['app-local-ios'] = {
    NODE_ENV: 'app',
    SITE_ROOT: 'http://localhost:4000',
  };

  fs.writeFile(envCmdPath, JSON.stringify(envCmd, null, 2));
  log('Edited .env-cmdrc.json');

  gitIgnore(
    'android/app/build',
    'android/**/capacitor.build.gradle',
    'ios/App/App/public',
  );

  //update package.json scripts
  let pack = getPackageJSON(basePath);
  pack.scripts['build-staging'] =
    'env-cmd -e _main, staging node scripts/build.js';
  pack.scripts['fix-app'] = 'node scripts/fix-namespace.js';
  pack.scripts['app'] =
    'env-cmd -e _main,production,app-main node scripts/build.js && npx cap sync && npm run fix-app';
  pack.scripts['app-local-ios'] =
    'env-cmd -e _main,development,app-main,app-local-ios node scripts/build.js && npx cap sync && npm run fix-app';
  pack.scripts['app-local-android'] =
    'env-cmd -e _main,development,app-main,app-local-android node scripts/build.js && npx cap sync && npm run fix-app';
  pack.scripts['cap:android'] = 'npx cap open android';
  pack.scripts['cap:ios'] = 'npx cap open ios';
  pack.scripts['cap:sync'] = 'npx cap sync';

  fs.writeFile(
    path.resolve(basePath, 'package.json'),
    JSON.stringify(pack, null, 2),
  );
  log('Added new run script to package.json');

  await execPromise(`npm install --save-dev @capacitor/cli`, true, false, null, true);
  await execPromise(
    `npm install @capacitor/android @capacitor/core @capacitor/app @capacitor/ios`,
    false,
    false,
    null,
    true,
  );

  // TODO: Do we need to add `npx cap init`? If yes, we should not copy capacitor config.ts yet
  // await execPromise(`npx cap init`, true, false, null, true);
  // got error:
  // [error] Non-interactive shell detected.
  // Run the command with --help to see a list of arguments that must be provided.
  // [error] Non-interactive shell detected.
  // Run the command with --help to see a list of arguments that must be provided.

  log(
    `Done! Now update your Capacitor configuration by providing an app name, app ID, and web directory at ${chalk.blue(
      'capacitor.config.ts',
    )}`,
  );
  log(
    `And then run ${chalk.magenta(
      'npx cap add android',
    )} and/or ${chalk.magenta('npx cap add ios')}')`,
  );
  log(
    `Last, run ${chalk.magenta('npm run app')} or ${chalk.magenta(
      'npm run app-local-ios',
    )} or ${chalk.magenta('npm run app-local-android')}`,
  );
};

export var executeCommandForPackage = function (packageName, command) {
  let packageDetails = getLincdPackages().find(
    (modDetails: PackageDetails) =>
      modDetails.packageName.indexOf(packageName) !== -1 ||
      modDetails.packageName.indexOf(packageName) !== -1,
  );
  if (packageDetails) {
    // npm is the default; only a package inside a yarn project is driven with
    // yarn (`yarn linked <cmd>` resolves the bin from the yarn workspace).
    const pm = detectPackageManager(packageDetails.path);
    // Windows quirk: the shim is `yarn.cmd` / `npx.cmd`.
    const isWin = process.platform === 'win32';
    const runner =
      pm === 'yarn' ? (isWin ? 'yarn.cmd' : 'yarn') : isWin ? 'npx.cmd' : 'npx';
    const runnerArgs = pm === 'yarn' ? ['linked'] : ['--no-install', 'linked'];

    log(
      "Executing 'cd " +
        packageDetails.path +
        ` && ${runner} linked` +
        (command ? ' ' + command : '') +
        "'",
    );

    spawnChild(
      runner,
      [...runnerArgs, command || null],
      {
        cwd: packageDetails.path,
        stdio: 'inherit',
      },
    );
  } else {
    warn(
      "Could not find a pkg who's name (partially) matched " +
        chalk.cyan(packageName),
    );
  }
};

/**
 * Function to remove files older than 10 seconds from the 'lib' folder.
 * @param {string} packagePath - The path to the package directory.
 */
export const removeOldFiles = async (packagePath) => {
  const libPath = path.join(packagePath, 'lib');

  try {
    // Read all files in the 'lib' folder asynchronously
    const files = await glob(packagePath + '/lib/**/*.*');

    // Iterate through each file
    for (const file of files) {
      // const filePath = path.join(libPath, file);

      // Check if the file exists before attempting to delete it
      // if (await fs.pathExists(filePath)) {
      const stats = await fs.stat(file);
      const currentTime = new Date().getTime();
      const lastModifiedTime = stats.mtime.getTime();

      // Check if the difference between the current time and last modified time is greater than 120 seconds
      if (currentTime - lastModifiedTime > 120000) {
        // Attempt to delete the file
        await fs.unlink(file);
        // console.log(`Removed: ${file}`);
      }
      // }
    }
    return true;
  } catch (error) {
    console.error(`Error removing files: ${error.message}`);
    return false;
  }
};
