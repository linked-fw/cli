import {execFile} from 'child_process';
import fs from 'fs';
import path from 'path';
import {pathToFileURL} from 'url';
import {ASSET_HOOK, findShapeModules} from './shapeReferences.js';
import {isLinkedPackageJson} from '../installed-packages.js';

/**
 * Checking shape hierarchy: do the package's shapes agree with the class hierarchy?
 *
 * The store infers `rdf:type` through `rdfs:subClassOf`, and SHACL targeting follows it, so a shape
 * tree that disagrees with the class tree validates and queries nodes its author did not mean to.
 * `@_linked/core/shapes/checkShapeHierarchy` reports the disagreements (an `extends` the data does
 * not back, a subclass whose shape does not extend its superclass's shape, a borrowed target class,
 * a term a mirror package's data does not define, an override that widens). `linked build` fails
 * on any `error`, so a published package is clean; an app only logs them at boot.
 *
 * Everything has to be registered in one process: the package's shapes, its ontology data and the
 * ontology data of its dependencies (a package's `shapes/index` imports its dependencies' shapes
 * but not their data, which registers through each package's `ontologies/*.register.js`). Core's
 * `registerInstalledOntologies` registers the data of the package and of every linked dependency,
 * as an app's boot does. So, unlike the shape-reference check, this runs one child `node` for the
 * whole package.
 */

/** As `@_linked/core/shapes/checkShapeHierarchy` returns them. */
export interface ShapeCheckFinding {
  kind: string;
  severity: 'error' | 'warning';
  shape?: string;
  iri?: string;
  message: string;
}

export interface ShapeCheckInputs {
  /** File URLs of the package's own modules (`package.js`, its shapes), imported in this order. */
  modules: string[];
  /** The package's directory and each linked dependency's, for `registerInstalledOntologies`. */
  packageDirs: string[];
  /** The packages among them that have register modules, so must come back registered. */
  expectRegistered: string[];
  /** Package name → its `dependencies` and `peerDependencies`, for the check's direction-I scope. */
  dependencies: Record<string, string[]>;
  /** File URL of the `checkShapeHierarchy` module the package's core provides. */
  core: string;
  /** File URL of the `registerInstalled` module the package's core provides. */
  registerInstalled: string;
}

export type ShapeCheckOutcome =
  | {findings: ShapeCheckFinding[]}
  /** Nothing to check, said nothing about (no shapes, no core). */
  | {skip: true; reason?: undefined}
  /** Could not check; the build warns and goes on. */
  | {skip: true; reason: string}
  /** The package's modules could not be loaded, or the check threw. */
  | {error: string};

const CORE = '@_linked/core';
const CHECK_MODULE = path.join('lib', 'esm', 'shapes', 'checkShapeHierarchy.js');
const REGISTER_MODULE = path.join('lib', 'esm', 'ontology', 'registerInstalled.js');
const DEPENDENCY_FIELDS = ['dependencies', 'peerDependencies'];

const readJson = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));

const dependencyNames = (pkgJson: any): string[] => [
  ...new Set(DEPENDENCY_FIELDS.flatMap((field) => Object.keys(pkgJson[field] || {}))),
];

/**
 * The directory `name` resolves to from `fromDir`, by Node's `node_modules` walk, as a real path.
 * Not `require.resolve`: a package's export map need not expose `package.json`.
 */
export const resolvePackageDir = (name: string, fromDir: string): string | undefined => {
  let dir = fromDir;
  for (;;) {
    const candidate = path.join(dir, 'node_modules', name);
    if (fs.existsSync(path.join(candidate, 'package.json'))) {
      return fs.realpathSync(candidate);
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
};

/** Whether a package's build holds ontology register modules (`lib/esm/ontologies/*.register.js`). */
const hasRegisterModules = (packageDir: string): boolean => {
  const dir = path.join(packageDir, 'lib', 'esm', 'ontologies');
  return fs.existsSync(dir) && fs.readdirSync(dir).some((file) => /\.register\.js$/.test(file));
};

/** The name the package registers its shapes under: `linkedPackage('<name>')` in `package.js`. */
const runtimePackageName = (libEsm: string): string | undefined => {
  const pkgModule = path.join(libEsm, 'package.js');
  if (!fs.existsSync(pkgModule)) return undefined;
  return fs
    .readFileSync(pkgModule, 'utf8')
    .match(/linkedPackage\(\s*['"]([^'"]+)['"]/)?.[1];
};


/**
 * What the check of the built package at `packagePath` loads, or why it does not run: a package
 * with no shape modules, or without a `@_linked/core` dependency, has nothing to check; a core
 * older than `shapes/checkShapeHierarchy` cannot check.
 */
export const collectShapeCheckInputs = (
  packagePath: string,
): ShapeCheckInputs | {skip: true; reason?: string} => {
  const pkgJson = readJson(path.join(packagePath, 'package.json'));
  const libEsm = path.join(packagePath, 'lib', 'esm');
  const shapeModules = findShapeModules(libEsm);
  if (shapeModules.length === 0) return {skip: true};

  const ownDeps = dependencyNames(pkgJson);
  const isCore = pkgJson.name === CORE;
  if (!isCore && !ownDeps.includes(CORE)) return {skip: true};
  const coreDir = isCore ? packagePath : resolvePackageDir(CORE, packagePath);
  if (!coreDir) {
    return {skip: true, reason: `${CORE} is a dependency but could not be resolved from ${packagePath}`};
  }
  const core = path.join(coreDir, CHECK_MODULE);
  const registerInstalled = path.join(coreDir, REGISTER_MODULE);
  const lacking = [core, registerInstalled].find((file) => !fs.existsSync(file));
  if (lacking) {
    return {
      skip: true,
      reason: `the ${CORE} this package resolves (${readJson(path.join(coreDir, 'package.json')).version}) has no ${path
        .relative(path.join(coreDir, 'lib', 'esm'), lacking)
        .replace(/\.js$/, '')
        .split(path.sep)
        .join('/')}`,
    };
  }

  const modules: string[] = [];
  const pkgModule = path.join(libEsm, 'package.js');
  if (fs.existsSync(pkgModule)) modules.push(pkgModule);
  const index = path.join(libEsm, 'shapes', 'index.js');
  modules.push(...(fs.existsSync(index) ? [index] : shapeModules));
  const packageDirs = [fs.realpathSync(packagePath)];

  const dependencies: Record<string, string[]> = {};
  for (const name of new Set([pkgJson.name, runtimePackageName(libEsm)])) {
    if (name) dependencies[name] = ownDeps;
  }
  // Every linked dependency, transitively, each resolved from the package that depends on it.
  const queue = ownDeps.map((name) => ({name, from: packagePath}));
  const seen = new Set<string>([pkgJson.name]);
  while (queue.length) {
    const {name, from} = queue.shift()!;
    if (seen.has(name)) continue;
    seen.add(name);
    const dir = resolvePackageDir(name, from);
    if (!dir) continue;
    const depJson = readJson(path.join(dir, 'package.json'));
    // A dependency whose ontology data an app would register: a linked package.
    if (!isLinkedPackageJson(depJson)) continue;
    const deps = dependencyNames(depJson);
    dependencies[name] = deps;
    packageDirs.push(dir);
    queue.push(...deps.map((dep) => ({name: dep, from: dir})));
  }

  return {
    modules: modules.map((file) => pathToFileURL(file).href),
    packageDirs: [...new Set(packageDirs)],
    expectRegistered: [...new Set(packageDirs)]
      .filter(hasRegisterModules)
      .map((dir) => readJson(path.join(dir, 'package.json')).name ?? path.basename(dir)),
    dependencies,
    core: pathToFileURL(core).href,
    registerInstalled: pathToFileURL(registerInstalled).href,
  };
};

/**
 * The script the child runs, passed with `-e` so it runs the same from `src` under a test runner as
 * from the published `lib`. It reports through a marker line: the modules it loads may log.
 */
const CHECK = `
import {register} from 'node:module';
register('data:text/javascript,' + encodeURIComponent(${JSON.stringify(ASSET_HOOK)}));
const MARK = '__LINKED_SHAPE_HIERARCHY__';
const out = {findings: null, error: null};
let loading;
try {
  for (const m of JSON.parse(process.env.LINKED_CHECK_MODULES)) {
    loading = m;
    await import(m);
  }
  loading = 'the ontology data of ' + process.env.LINKED_CHECK_PACKAGE_DIRS;
  const {registerInstalledOntologies} = await import(process.env.LINKED_CHECK_REGISTER);
  // A register module that throws is only warned about; here it fails the check, with the warning.
  const warnings = [];
  const warn = console.warn;
  console.warn = (...args) => warnings.push(args.map(String).join(' '));
  let registered;
  try {
    registered = await registerInstalledOntologies(JSON.parse(process.env.LINKED_CHECK_PACKAGE_DIRS));
  } finally {
    console.warn = warn;
  }
  const failed = JSON.parse(process.env.LINKED_CHECK_EXPECT).filter((name) => !registered.includes(name));
  if (failed.length > 0) {
    throw new Error('the ontology register modules of ' + failed.join(', ') + ' threw:\\n' + warnings.join('\\n'));
  }
  loading = undefined;
  const {checkShapeHierarchy} = await import(process.env.LINKED_CHECK_CORE);
  out.findings = await checkShapeHierarchy({
    dependencies: JSON.parse(process.env.LINKED_CHECK_DEPENDENCIES),
  });
} catch (e) {
  const trace = e && e.stack ? e.stack.split('\\n').slice(0, 6).join('\\n') : String(e);
  out.error = (loading ? 'loading ' + loading + ': ' : '') + trace;
}
process.stdout.write('\\n' + MARK + JSON.stringify(out) + '\\n', () => process.exit(0));
`;

const MARK = '__LINKED_SHAPE_HIERARCHY__';

/** Load the built package at `packagePath` with its dependencies' ontology data and run the check. */
export const runShapeHierarchyCheck = async (
  packagePath: string,
  {timeoutMs = 120000} = {},
): Promise<ShapeCheckOutcome> => {
  const inputs = collectShapeCheckInputs(packagePath);
  if ('skip' in inputs) return inputs as ShapeCheckOutcome;
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ['--input-type=module', '-e', CHECK],
      {
        cwd: packagePath,
        env: {
          ...process.env,
          LINKED_CHECK_MODULES: JSON.stringify(inputs.modules),
          LINKED_CHECK_DEPENDENCIES: JSON.stringify(inputs.dependencies),
          LINKED_CHECK_CORE: inputs.core,
          LINKED_CHECK_REGISTER: inputs.registerInstalled,
          LINKED_CHECK_PACKAGE_DIRS: JSON.stringify(inputs.packageDirs),
          LINKED_CHECK_EXPECT: JSON.stringify(inputs.expectRegistered),
        },
        timeout: timeoutMs,
        maxBuffer: 64 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        const line = String(stdout)
          .split('\n')
          .reverse()
          .find((l) => l.startsWith(MARK));
        if (line) {
          const out = JSON.parse(line.slice(MARK.length));
          resolve(out.error ? {error: out.error} : {findings: out.findings});
          return;
        }
        resolve({
          error:
            err && (err as any).killed
              ? `did not finish within ${timeoutMs}ms`
              : String(stderr).trim().split('\n').slice(-6).join('\n') ||
                String(err || 'exited without reporting'),
        });
      },
    );
  });
};

const shortIri = (iri: string) => iri.replace(/^.*\/shape\//, '');

export const formatFinding = (f: ShapeCheckFinding): string =>
  `  ${f.severity} ${f.kind}${f.shape ? ` ${shortIri(f.shape)}` : ''}: ${f.message}`;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * Build step. Any `error` finding fails the build; warnings alone warn. Every finding is printed
 * either way. `skip` (from `--skip-shape-check "<reason>"`) skips the check and says why.
 */
export const checkShapeHierarchyStep = async (
  packagePath: string,
  {skip, timeoutMs}: {skip?: string; timeoutMs?: number} = {},
): Promise<true | string | {error: string}> => {
  if (skip !== undefined) return `skipped: ${skip}`;
  const outcome = await runShapeHierarchyCheck(packagePath, {timeoutMs});
  if ('error' in outcome) return {error: outcome.error};
  if ('skip' in outcome) return outcome.reason ? `skipped: ${outcome.reason}` : true;
  const {findings} = outcome;
  if (findings.length === 0) return true;
  const errors = findings.filter((f) => f.severity === 'error').length;
  const warnings = findings.length - errors;
  const summary = [errors && plural(errors, 'error'), warnings && plural(warnings, 'warning')]
    .filter(Boolean)
    .join(', ');
  const text = `${summary}:\n${findings.map(formatFinding).join('\n')}`;
  return errors > 0 ? {error: text} : text;
};
