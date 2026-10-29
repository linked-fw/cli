import {execFile} from 'child_process';
import fs from 'fs';
import path from 'path';
import {pathToFileURL} from 'url';
import {resolvePackageDir} from './shapeHierarchy.js';
import {ASSET_HOOK} from './shapeReferences.js';

/**
 * Writing components.ttl: the package's component index, at `lib/esm/data/components.ttl`.
 *
 * A package offers its components through `components/index` (`lib/esm/components/index.js`): per
 * linked component it exports, the index holds its export name, start shape, query shape and query
 * wire format. A host (Create Now) stores the file's triples as they are and hashes its bytes. The
 * Turtle comes from `componentIndexTurtle(packageName, exports)` of the `@_linked/react` the package
 * resolves, called in a child `node` that has loaded the built `package.js` (sets the package's
 * publish root), `shapes/index.js` and `components/index.js`, in that order, with asset imports
 * stubbed. The name passed is the one the package's shapes register under, as for `shapes.ttl`.
 *
 * No `components/index`, or no linked component in it, gives no file, and a file left by an
 * earlier build is removed.
 */

export const COMPONENTS_TURTLE_PATH = path.join('lib', 'esm', 'data', 'components.ttl');

export interface ComponentsTurtleInputs {
  /** File URLs of the package's own modules, imported in this order; `components/index` is last. */
  modules: string[];
  /** The name the package's shapes register under. */
  packageName: string;
  /** File URL of the `utils/componentIndex` module of the react the package resolves. */
  generator: string;
}

export type ComponentsTurtleOutcome =
  /** The Turtle (`undefined` when there is no linked component) and the generator's warnings. */
  | {turtle: string | undefined; warnings: string[]}
  /** Nothing to write, said nothing about (no components/index, no react dependency). */
  | {skip: true; reason?: undefined}
  /** Could not generate; the build warns and goes on without a file. */
  | {skip: true; reason: string}
  /** The package's modules could not be loaded, or the generation threw. */
  | {error: string};

const REACT = '@_linked/react';
const GENERATOR_MODULE = path.join('lib', 'esm', 'utils', 'componentIndex.js');
const DEPENDENCY_FIELDS = ['dependencies', 'peerDependencies'];

const readJson = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));

/** The name the package registers under: `linkedPackage('<name>')` in `package.js`. */
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
 * package without `components/index`, or without `@_linked/react` among its dependencies, has no
 * index; a react older than `utils/componentIndex` cannot generate one.
 */
export const collectComponentsTurtleInputs = (
  packagePath: string,
): ComponentsTurtleInputs | {skip: true; reason?: string} => {
  const pkgJson = readJson(path.join(packagePath, 'package.json'));
  const libEsm = path.join(packagePath, 'lib', 'esm');
  const componentsIndex = path.join(libEsm, 'components', 'index.js');
  if (!fs.existsSync(componentsIndex)) return {skip: true};

  const deps = DEPENDENCY_FIELDS.flatMap((field) => Object.keys(pkgJson[field] || {}));
  if (!deps.includes(REACT)) return {skip: true};
  const reactDir = resolvePackageDir(REACT, packagePath);
  if (!reactDir) {
    return {skip: true, reason: `${REACT} is a dependency but could not be resolved from ${packagePath}`};
  }
  const generator = path.join(reactDir, GENERATOR_MODULE);
  if (!fs.existsSync(generator)) {
    return {
      skip: true,
      reason: `the ${REACT} this package resolves (${readJson(path.join(reactDir, 'package.json')).version}) has no utils/componentIndex`,
    };
  }

  const modules: string[] = [];
  for (const file of [path.join(libEsm, 'package.js'), path.join(libEsm, 'shapes', 'index.js')]) {
    if (fs.existsSync(file)) modules.push(file);
  }
  modules.push(componentsIndex);

  return {
    modules: modules.map((file) => pathToFileURL(file).href),
    packageName: runtimePackageName(libEsm, pkgJson),
    generator: pathToFileURL(generator).href,
  };
};

/**
 * A resolve hook for the child: a relative asset import (`./icon.svg`) resolves even when the
 * build did not copy the file (only `json, d.ts, css, scss, ttl` are copied to `lib/`), so the
 * load hook ({@link ASSET_HOOK}) can stub it. Node resolves before it loads, and fails on a missing
 * file before any load hook runs.
 */
export const ASSET_RESOLVE_HOOK = `
const ASSET = /\\.(css|scss|sass|less|styl|svg|png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|eot)$/i;
export async function resolve(specifier, context, next) {
  if (/^\\.{1,2}\\//.test(specifier) && ASSET.test(specifier) && context.parentURL) {
    return {url: new URL(specifier, context.parentURL).href, shortCircuit: true};
  }
  return next(specifier, context);
}
`;

/**
 * The script the child runs, passed with `-e` so it runs the same from `src` under a test runner as
 * from the published `lib`. It reports through a marker line: the modules it loads may log.
 */
const GENERATE = `
import {register} from 'node:module';
register('data:text/javascript,' + encodeURIComponent(${JSON.stringify(ASSET_RESOLVE_HOOK)}));
register('data:text/javascript,' + encodeURIComponent(${JSON.stringify(ASSET_HOOK)}));
const MARK = '__LINKED_COMPONENTS_TURTLE__';
const out = {turtle: null, warnings: [], error: null};
let loading;
try {
  let exports;
  for (const m of JSON.parse(process.env.LINKED_COMPONENTS_MODULES)) {
    loading = m;
    exports = await import(m);
  }
  loading = undefined;
  const {componentIndexTurtle} = await import(process.env.LINKED_COMPONENTS_GENERATOR);
  out.turtle = componentIndexTurtle(process.env.LINKED_COMPONENTS_PACKAGE, {...exports}, out.warnings) ?? null;
} catch (e) {
  const trace = e && e.stack ? e.stack.split('\\n').slice(0, 6).join('\\n') : String(e);
  out.error = (loading ? 'loading ' + loading + ': ' : '') + trace;
}
process.stdout.write('\\n' + MARK + JSON.stringify(out) + '\\n', () => process.exit(0));
`;

const MARK = '__LINKED_COMPONENTS_TURTLE__';

/** Load the built package at `packagePath` and generate its component index with its react. */
export const generateComponentsTurtle = async (
  packagePath: string,
  {timeoutMs = 120000} = {},
): Promise<ComponentsTurtleOutcome> => {
  const inputs = collectComponentsTurtleInputs(packagePath);
  if ('skip' in inputs) return inputs as ComponentsTurtleOutcome;
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ['--input-type=module', '-e', GENERATE],
      {
        cwd: packagePath,
        env: {
          ...process.env,
          LINKED_COMPONENTS_MODULES: JSON.stringify(inputs.modules),
          LINKED_COMPONENTS_PACKAGE: inputs.packageName,
          LINKED_COMPONENTS_GENERATOR: inputs.generator,
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
          resolve(
            out.error
              ? {error: out.error}
              : {turtle: out.turtle ?? undefined, warnings: out.warnings ?? []},
          );
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
 * Build step. Writes `lib/esm/data/components.ttl` when `components/index` exports linked
 * components; otherwise makes sure there is none. A react that cannot generate the file warns, and
 * so do components the generator leaves out; a module that throws fails. `skip` (from
 * `--skip-shape-check "<reason>"`) skips the step: the shapes the index names are unchecked.
 * Whenever no new file is written, an earlier one is removed, so a stale index never ships.
 */
export const writeComponentsTurtleStep = async (
  packagePath: string,
  {skip, timeoutMs}: {skip?: string; timeoutMs?: number} = {},
): Promise<true | string | {info: string} | {error: string}> => {
  const target = path.join(packagePath, COMPONENTS_TURTLE_PATH);
  if (skip !== undefined) {
    fs.rmSync(target, {force: true});
    return `skipped with --skip-shape-check (${skip}): no components.ttl written`;
  }
  const outcome = await generateComponentsTurtle(packagePath, {timeoutMs});
  if ('error' in outcome) {
    fs.rmSync(target, {force: true});
    return {error: outcome.error};
  }
  if ('turtle' in outcome) {
    const {turtle} = outcome;
    const written = turtle !== undefined;
    if (turtle !== undefined) {
      fs.mkdirSync(path.dirname(target), {recursive: true});
      fs.writeFileSync(target, turtle);
    } else {
      fs.rmSync(target, {force: true});
    }
    if (outcome.warnings.length) {
      const what = written ? 'lib/esm/data/components.ttl written' : 'no components.ttl written';
      return `${what}; ${outcome.warnings.join('; ')}`;
    }
    return written ? {info: path.relative(packagePath, target).split(path.sep).join('/')} : true;
  }
  fs.rmSync(target, {force: true});
  return 'reason' in outcome && outcome.reason ? `skipped: ${outcome.reason}` : true;
};
