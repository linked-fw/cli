import {execFile} from 'child_process';
import fs from 'fs';
import path from 'path';
import {pathToFileURL} from 'url';
import {resolvePackageDir} from './shapeHierarchy.js';
import {ASSET_HOOK, findShapeModules} from './shapeReferences.js';

/**
 * Writing shapes.ttl: the package's shapes as Turtle, at `lib/esm/data/shapes.ttl`.
 *
 * An app's server syncs each installed package's shapes into that package's shape graph from this
 * file (by a content hash), so the file must be exactly what core generates in process for the same
 * package. It therefore comes from core's own `packageShapesTurtle(pkg)`, called with no options in
 * a child `node` that has loaded the built package's `package.js` and `shapes/index.js` (every shape
 * module when there is no index), with the core that package resolves. The name passed is the one
 * the shapes register under (`linkedPackage('<name>')` in `package.js`, else `package.json`'s).
 *
 * A package that registers no shapes gets no file, and a file left by an earlier build is removed.
 */

export const SHAPES_TURTLE_PATH = path.join('lib', 'esm', 'data', 'shapes.ttl');

export interface ShapesTurtleInputs {
  /** File URLs of the package's own modules (`package.js`, its shapes), imported in this order. */
  modules: string[];
  /** The name the package's shapes register under. */
  packageName: string;
  /** File URL of the `shapes/shapesToTurtle` module of the core the package resolves. */
  core: string;
}

export type ShapesTurtleOutcome =
  /** The Turtle, or `undefined` when the package registers no shapes. */
  | {turtle: string | undefined}
  /** Nothing to write, said nothing about (no shape modules, no core). */
  | {skip: true; reason?: undefined}
  /** Could not generate; the build warns and goes on without a file. */
  | {skip: true; reason: string}
  /** The package's modules could not be loaded, or the generation threw. */
  | {error: string};

const CORE = '@_linked/core';
const TURTLE_MODULE = path.join('lib', 'esm', 'shapes', 'shapesToTurtle.js');
const DEPENDENCY_FIELDS = ['dependencies', 'peerDependencies'];

const readJson = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));

/** The name the package registers its shapes under: `linkedPackage('<name>')` in `package.js`. */
const runtimePackageName = (libEsm: string, pkgJson: any): string => {
  const pkgModule = path.join(libEsm, 'package.js');
  if (fs.existsSync(pkgModule)) {
    const m = fs
      .readFileSync(pkgModule, 'utf8')
      .match(/linkedPackage\(\s*['"]([^'"]+)['"]/);
    if (m) return m[1];
  }
  return pkgJson.name;
};

/**
 * What the generation for the built package at `packagePath` loads, or why it does not run: a
 * package with no shape modules, or without a `@_linked/core` dependency, has no shapes; a core
 * older than `shapes/shapesToTurtle` cannot generate them.
 */
export const collectShapesTurtleInputs = (
  packagePath: string,
): ShapesTurtleInputs | {skip: true; reason?: string} => {
  const pkgJson = readJson(path.join(packagePath, 'package.json'));
  const libEsm = path.join(packagePath, 'lib', 'esm');
  const shapeModules = findShapeModules(libEsm);
  if (shapeModules.length === 0) return {skip: true};

  const isCore = pkgJson.name === CORE;
  const deps = DEPENDENCY_FIELDS.flatMap((field) => Object.keys(pkgJson[field] || {}));
  if (!isCore && !deps.includes(CORE)) return {skip: true};
  const coreDir = isCore ? packagePath : resolvePackageDir(CORE, packagePath);
  if (!coreDir) {
    return {skip: true, reason: `${CORE} is a dependency but could not be resolved from ${packagePath}`};
  }
  const core = path.join(coreDir, TURTLE_MODULE);
  if (!fs.existsSync(core)) {
    return {
      skip: true,
      reason: `the ${CORE} this package resolves (${readJson(path.join(coreDir, 'package.json')).version}) has no shapes/shapesToTurtle`,
    };
  }

  const modules: string[] = [];
  const pkgModule = path.join(libEsm, 'package.js');
  if (fs.existsSync(pkgModule)) modules.push(pkgModule);
  const index = path.join(libEsm, 'shapes', 'index.js');
  modules.push(...(fs.existsSync(index) ? [index] : shapeModules));

  return {
    modules: modules.map((file) => pathToFileURL(file).href),
    packageName: runtimePackageName(libEsm, pkgJson),
    core: pathToFileURL(core).href,
  };
};

/**
 * The script the child runs, passed with `-e` so it runs the same from `src` under a test runner as
 * from the published `lib`. It reports through a marker line: the modules it loads may log.
 */
const GENERATE = `
import {register} from 'node:module';
register('data:text/javascript,' + encodeURIComponent(${JSON.stringify(ASSET_HOOK)}));
const MARK = '__LINKED_SHAPES_TURTLE__';
const out = {turtle: null, error: null};
let loading;
try {
  for (const m of JSON.parse(process.env.LINKED_SHAPES_MODULES)) {
    loading = m;
    await import(m);
  }
  loading = undefined;
  const {packageShapesTurtle} = await import(process.env.LINKED_SHAPES_CORE);
  out.turtle = packageShapesTurtle(process.env.LINKED_SHAPES_PACKAGE) ?? null;
} catch (e) {
  const trace = e && e.stack ? e.stack.split('\\n').slice(0, 6).join('\\n') : String(e);
  out.error = (loading ? 'loading ' + loading + ': ' : '') + trace;
}
process.stdout.write('\\n' + MARK + JSON.stringify(out) + '\\n', () => process.exit(0));
`;

const MARK = '__LINKED_SHAPES_TURTLE__';

/** Load the built package at `packagePath` and generate its shapes' Turtle with its core. */
export const generateShapesTurtle = async (
  packagePath: string,
  {timeoutMs = 120000} = {},
): Promise<ShapesTurtleOutcome> => {
  const inputs = collectShapesTurtleInputs(packagePath);
  if ('skip' in inputs) return inputs as ShapesTurtleOutcome;
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ['--input-type=module', '-e', GENERATE],
      {
        cwd: packagePath,
        env: {
          ...process.env,
          LINKED_SHAPES_MODULES: JSON.stringify(inputs.modules),
          LINKED_SHAPES_PACKAGE: inputs.packageName,
          LINKED_SHAPES_CORE: inputs.core,
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
          resolve(out.error ? {error: out.error} : {turtle: out.turtle ?? undefined});
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

/**
 * Build step. Writes `lib/esm/data/shapes.ttl` when the package registers shapes; otherwise makes
 * sure there is none. A core that cannot generate the file warns; a module that throws fails.
 */
export const writeShapesTurtleStep = async (
  packagePath: string,
  {timeoutMs}: {timeoutMs?: number} = {},
): Promise<true | string | {info: string} | {error: string}> => {
  const target = path.join(packagePath, SHAPES_TURTLE_PATH);
  const outcome = await generateShapesTurtle(packagePath, {timeoutMs});
  if ('error' in outcome) return {error: outcome.error};
  if ('turtle' in outcome && outcome.turtle !== undefined) {
    fs.mkdirSync(path.dirname(target), {recursive: true});
    fs.writeFileSync(target, outcome.turtle);
    return {info: path.relative(packagePath, target).split(path.sep).join('/')};
  }
  fs.rmSync(target, {force: true});
  return 'reason' in outcome && outcome.reason ? `skipped: ${outcome.reason}` : true;
};
