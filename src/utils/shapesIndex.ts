import fs from 'fs';
import path from 'path';
import {minimatch} from 'minimatch';
import {
  inspectShapeReferences,
  type ShapeReferenceReport,
} from './shapeReferences.js';

/**
 * The shape-registration standard, checked against a package's build output.
 *
 * Every package has `src/shapes/index.ts`: side-effect-only imports of every
 * shape module, so an app can register the whole set with one import
 * (`import '@_linked/<pkg>/shapes/index'`). A shape registers only when its
 * module is evaluated, so a shape the index forgets is a shape an app that
 * trusts the index never has, and a query naming it throws "Shape class not
 * found" in that app's bundle. And a bundler that believes a package's
 * `sideEffects` drops a side-effect-only import outright, so declaring shape
 * modules side-effect-free empties the index in production while dev (which
 * does not tree-shake) keeps working.
 */

/** The index, relative to lib/esm, as the per-module inspection keys it. */
const INDEX = path.join('shapes', 'index.js');

const shortIri = (iri: string) => iri.replace(/^.*\/shape\//, '');

/** `lib/esm/shapes/X.js` → `src/shapes/X.ts`, for messages. */
const srcPath = (module: string) =>
  path.join('src', module).replace(/\.js$/, '.ts');

/** The line shapes/index.ts needs to load `module` (relative to lib/esm). */
const importLine = (module: string) => {
  let rel = path
    .relative('shapes', module)
    .split(path.sep)
    .join('/');
  if (!rel.startsWith('.')) rel = './' + rel;
  return `import '${rel}';`;
};

/**
 * For each shape, the module the fix should import: the one named after the
 * shape, else the one whose source declares its class, else the module
 * registering the fewest shapes (the most specific).
 */
const moduleFor = (
  shape: string,
  registered: Record<string, string[]>,
  libEsm: string,
): string | undefined => {
  const name = shape.replace(/^.*\//, '');
  const declares = (m: string) => {
    try {
      return new RegExp(`\\b(?:class ${name}|${name} = class)\\b`).test(
        fs.readFileSync(path.join(libEsm, m), 'utf8'),
      );
    } catch {
      return false;
    }
  };
  const candidates = Object.keys(registered)
    .filter((m) => m !== INDEX && registered[m].includes(shape))
    .sort(
      (a, b) =>
        registered[a].length - registered[b].length || a.localeCompare(b),
    );
  return (
    candidates.find((m) => path.basename(m, '.js') === name) ??
    candidates.find(declares) ??
    candidates[0]
  );
};

/**
 * Build step: does loading `lib/esm/shapes/index.js` alone, in a fresh
 * process, register every one of this package's shapes that loading its
 * shape modules one by one registers?
 *
 * Fails when the package has shapes but no shapes/index, when the index throws
 * on load, or when it misses a shape. A package without shapes passes.
 */
export const checkShapesIndex = async (
  packagePath: string,
  options?: Parameters<typeof inspectShapeReferences>[1],
  inspection?: Promise<ShapeReferenceReport>,
): Promise<true | string | {error: string}> => {
  const report = await (inspection ??
    inspectShapeReferences(packagePath, options));
  if (report.skipped) return `skipped: ${report.skipped}`;

  const libEsm = path.join(packagePath, 'lib', 'esm');
  const all = new Set<string>();
  for (const [module, shapes] of Object.entries(report.registered)) {
    if (module !== INDEX) shapes.forEach((s) => all.add(s));
  }
  if (all.size === 0) return true;

  const hasIndex = report.modules.includes(INDEX);
  const indexError = report.loadErrors.find((e) => e.module === INDEX);
  if (indexError) {
    return {
      error:
        `lib/esm/shapes/index.js throws when loaded on its own, so an app importing ` +
        `'<package>/shapes/index' registers nothing:\n  ${indexError.error.split('\n').join('\n  ')}`,
    };
  }
  const covered = new Set(hasIndex ? report.registered[INDEX] : []);
  const missing = [...all].filter((s) => !covered.has(s)).sort();
  if (missing.length === 0) return true;

  const lines = [
    ...new Set(
      missing.map((s) => {
        const m = moduleFor(s, report.registered, libEsm);
        return m ? importLine(m) : `// ${shortIri(s)}: no single module registers it`;
      }),
    ),
  ].sort();
  const listing = missing
    .map((s) => {
      const m = moduleFor(s, report.registered, libEsm);
      return `  ${shortIri(s)}${m ? ` (${srcPath(m)})` : ''}`;
    })
    .join('\n');
  const outside = missing
    .map((s) => moduleFor(s, report.registered, libEsm))
    .filter((m) => m && m.split(path.sep)[0] !== 'shapes');
  const moveNote =
    outside.length > 0
      ? `\nShapes declared outside src/shapes/ belong in src/shapes/; until they move, the index imports their module.`
      : '';

  if (!hasIndex) {
    return {
      error:
        `This package declares ${all.size} shape(s) but has no src/shapes/index.ts, so an app ` +
        `cannot register them with import '<package>/shapes/index':\n${listing}\n` +
        `Create src/shapes/index.ts holding only side-effect imports (no exports):\n` +
        lines.map((l) => `  ${l}`).join('\n') +
        `\nand import it from src/index.ts: import './shapes/index.js';` +
        moveNote,
    };
  }
  return {
    error:
      `${missing.length} shape(s) are not registered by loading lib/esm/shapes/index.js on its own, ` +
      `so an app that imports '<package>/shapes/index' never has them:\n${listing}\n` +
      `Add to src/shapes/index.ts:\n` +
      lines.map((l) => `  ${l}`).join('\n') +
      moveNote,
  };
};

/** Every emitted module under lib/esm/shapes, relative to the package root, `/`-separated. */
const emittedShapeModules = (packagePath: string): string[] => {
  const root = path.join(packagePath, 'lib', 'esm', 'shapes');
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, {withFileTypes: true})) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.js'))
        out.push(path.relative(packagePath, full).split(path.sep).join('/'));
    }
  };
  if (fs.existsSync(root)) walk(root);
  return out.sort();
};

/**
 * Whether a `sideEffects` pattern matches a package-relative path, the way
 * webpack and Rollup's node-resolve read it: a leading `./` is dropped and a
 * pattern without a `/` matches the file name anywhere.
 */
const sideEffectsMatch = (pattern: string, file: string): boolean => {
  let p = pattern.replace(/^\.\//, '');
  if (!p.includes('/')) p = '**/' + p;
  return minimatch(file, p, {dot: true});
};

/**
 * Build step: `package.json` must not declare any `lib/esm/shapes` module
 * side-effect-free. A pure match of the field against the emitted files; no
 * bundling.
 */
export const checkShapesSideEffects = (
  packagePath: string,
): true | {error: string} => {
  const pkgJson = JSON.parse(
    fs.readFileSync(path.join(packagePath, 'package.json'), 'utf8'),
  );
  const sideEffects = pkgJson.sideEffects;
  if (sideEffects === undefined || sideEffects === true) return true;
  const files = emittedShapeModules(packagePath);
  if (files.length === 0) return true;

  const fix =
    `Remove the "sideEffects" field, or list the shape modules in it:\n` +
    `  "sideEffects": ["lib/esm/shapes/index.js", "lib/esm/shapes/*.js"]` +
    (files.some((f) => f.split('/').length > 4)
      ? `\n  (with "lib/esm/shapes/**/*.js" for the nested folders)`
      : '');
  const why =
    `A bundler drops a side-effect-only import of a module it is told is side-effect-free, ` +
    `so shapes/index would register nothing in a production build.`;

  if (sideEffects === false) {
    return {
      error: `package.json declares "sideEffects": false, which marks every shape module side-effect-free. ${why}\n${fix}`,
    };
  }
  if (
    !Array.isArray(sideEffects) ||
    sideEffects.some((p) => typeof p !== 'string')
  ) {
    return {
      error: `package.json "sideEffects" must be true, false or a list of globs; found ${JSON.stringify(sideEffects)}.\n${fix}`,
    };
  }
  const unmatched = files.filter(
    (f) => !sideEffects.some((p: string) => sideEffectsMatch(p, f)),
  );
  if (unmatched.length === 0) return true;
  return {
    error:
      `package.json "sideEffects" does not cover ${unmatched.length} shape module(s), so they are declared ` +
      `side-effect-free:\n` +
      unmatched
        .slice(0, 10)
        .map((f) => `  ${f}`)
        .join('\n') +
      (unmatched.length > 10 ? `\n  and ${unmatched.length - 10} more` : '') +
      `\n${why}\n${fix}`,
  };
};
