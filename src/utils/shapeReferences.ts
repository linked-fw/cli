import {execFile} from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {declaresShape} from './shapeNames.js';

/**
 * Checking shape references: does loading a compiled shape module, on its own,
 * register every shape its properties point at?
 *
 * A property can name its value shape by `[package, name]` instead of by class
 * (`shape: ['@_linked/schema', 'ImageObject']`), usually because importing the
 * class would close an import cycle. That names the shape without loading it.
 * A shape registers only when its module is evaluated, and consumers deep-import
 * single shape modules (`@_linked/schema/shapes/Thing`), so nothing guarantees
 * the named shape is registered when a query traverses the property. The query
 * then throws `Shape class not found for …/ImageObject` — in a production bundle,
 * far from the cause. A reference to a package under an old name
 * (`['lincd-sioc', …]`) can never resolve at all.
 *
 * So each module is loaded the way a consumer's fresh process would load it: in
 * a child `node` of its own, with nothing else imported first. Separate processes
 * rather than one process re-importing: ESM has no module-cache eviction, and the
 * shape registry lives on `globalThis`, so a second module in the same process
 * would see every shape the first one registered.
 */

/** One module that could not be evaluated. */
export interface ShapeModuleLoadError {
  module: string;
  error: string;
}

/**
 * A property whose value shape was not registered after loading `modules`
 * (each on its own). One entry per distinct reference, however many modules
 * showed it.
 */
export interface UnresolvedShapeReference {
  shape: string;
  property: string;
  valueShape: string;
  modules: string[];
  /**
   * What the target package's entry does for it: `registered` — loading the
   * entry registers it, so the referencing module just does not import it;
   * `missing` — not even the entry registers it, so the name or package is
   * wrong; `not-a-dependency` — the IRI's package is neither this package nor
   * one of its dependencies; `unknown` — the entry could not be loaded.
   */
  target: 'registered' | 'missing' | 'not-a-dependency' | 'unknown';
  /** The package the IRI's slug maps to, when one does. */
  targetPackage?: string;
}

export interface ShapeReferenceReport {
  modules: string[];
  loadErrors: ShapeModuleLoadError[];
  unresolved: UnresolvedShapeReference[];
  /** Unresolved references that match {@link KNOWN_UNRESOLVED}. */
  known: UnresolvedShapeReference[];
  /** Set when the registry could not be inspected, so nothing was checked. */
  skipped?: string;
}

/**
 * References known to be unresolved, reported as warnings rather than failures.
 *
 * This is deliberately a list in the CLI rather than an opt-out a package can
 * write for itself: every entry is a shipped bug with a tracked fix, not an
 * accepted design. No package was found with a legitimate reason to leave a
 * reference unresolved; add an opt-out mechanism when one turns up.
 *
 * - `@_linked/core`: `PropertyShape.in` names `List` by `[package, name]`
 *   because `List`'s module depends on the SHACL shapes. Only core's entry
 *   loads `List`, so a process that deep-imports core without its entry cannot
 *   traverse `sh:in`. Tracked as core's backlog-045; core builds with `linked
 *   build-all`, which must not fail on it meanwhile. Remove this entry once
 *   core registers `List` wherever `PropertyShape` is registered.
 */
export const KNOWN_UNRESOLVED: {
  package: string;
  shape: string;
  property: string;
  valueShape: string;
}[] = [
  {
    package: '@_linked/core',
    shape: '/shape/core/PropertyShape',
    property: 'in',
    valueShape: '/shape/core/List',
  },
];

/** arch-02: the `{slug}` in `{baseUri}shape/{slug}/{Name}`. Mirrors core's `packageNameToSlug`. */
export const packageNameToSlug = (packageName: string): string =>
  packageName
    .replace(/^@[^/]+\//, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();

/** The slug in a node-shape IRI, or undefined when it is not shaped like one. */
const slugOf = (iri: string): string | undefined =>
  iri.match(/\/shape\/([^/]+)\/[^/]+$/)?.[1];

/**
 * A loader hook for the child: asset imports (`import styles from
 * './X.module.css'`) evaluate to a stub. Node cannot load them and a consumer's
 * bundler always can, so without this a shape module whose file also holds a
 * component would look broken when it is not. A CSS-module stub maps every
 * class name to itself.
 */
const ASSET_HOOK = `
const ASSET = /\\.(css|scss|sass|less|styl|svg|png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|eot)$/i;
export async function load(url, context, next) {
  if (url.startsWith('file:') && ASSET.test(new URL(url).pathname)) {
    return {format: 'module', shortCircuit: true,
      source: 'export default new Proxy({}, {get: (_, k) => typeof k === "string" ? k : undefined});'};
  }
  return next(url, context);
}
`;

/**
 * The script each child runs. Plain JS, passed with `-e`, so it runs the same
 * from `src` under a test runner as from the published `lib`.
 *
 * It reads the registry from `globalThis.__linkedShapeRegistry` rather than
 * importing `@_linked/core`: the module under test decides which copy of core
 * it loads, and the registry is shared by every copy.
 */
const PROBE = `
import {register} from 'node:module';
register('data:text/javascript,' + encodeURIComponent(${JSON.stringify(ASSET_HOOK)}));
const MARK = '__LINKED_SHAPE_REFERENCES__';
const out = {error: null, unresolved: [], registry: true};
const reg = () => globalThis.__linkedShapeRegistry;
const ownSlug = process.env.LINKED_PROBE_SLUG;
const report = () => {
  process.stdout.write('\\n' + MARK + JSON.stringify(out) + '\\n', () => process.exit(0));
};
try {
  await import(process.env.LINKED_PROBE_MODULE);
  const r = reg();
  if (!r || !r.nodeShapeRegistry) {
    out.registry = false;
  } else {
    for (const [id, ns] of r.nodeShapeRegistry) {
      if (!id.includes('/shape/' + ownSlug + '/')) continue;
      for (const ps of ns.propertyShapes || []) {
        const v = ps.valueShape && ps.valueShape.id;
        if (v && !r.nodeShapeRegistry.has(v)) {
          out.unresolved.push({shape: id, property: ps.label, valueShape: v});
        }
      }
    }
    // For each unresolved target, load its package's entry and look again: that
    // tells a missing import apart from a name that can never resolve.
    const entries = JSON.parse(process.env.LINKED_PROBE_ENTRIES || '{}');
    const tried = {};
    for (const u of out.unresolved) {
      const slug = (u.valueShape.match(/\\/shape\\/([^/]+)\\/[^/]+$/) || [])[1];
      const entry = entries[slug];
      if (!entry) { u.target = 'not-a-dependency'; continue; }
      u.targetPackage = entry.name;
      if (!(slug in tried)) {
        try { await import(entry.specifier); tried[slug] = true; }
        catch (e) { tried[slug] = false; }
      }
      u.target = !tried[slug] ? 'unknown'
        : reg().nodeShapeRegistry.has(u.valueShape) ? 'registered' : 'missing';
    }
  }
} catch (e) {
  out.error = e && e.stack ? e.stack.split('\\n').slice(0, 4).join('\\n') : String(e);
}
report();
`;

interface ProbeResult {
  error: string | null;
  registry: boolean;
  unresolved: {
    shape: string;
    property: string;
    valueShape: string;
    target: UnresolvedShapeReference['target'];
    targetPackage?: string;
  }[];
}

const MARK = '__LINKED_SHAPE_REFERENCES__';

const runProbe = (
  modulePath: string,
  packagePath: string,
  env: Record<string, string>,
  timeoutMs: number,
): Promise<ProbeResult> =>
  new Promise((resolve) => {
    execFile(
      process.execPath,
      ['--input-type=module', '-e', PROBE],
      {
        cwd: packagePath,
        env: {
          ...process.env,
          ...env,
          LINKED_PROBE_MODULE: 'file://' + modulePath,
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
          resolve(JSON.parse(line.slice(MARK.length)));
          return;
        }
        const why =
          err && (err as any).killed
            ? `did not finish loading within ${timeoutMs}ms`
            : String(stderr).trim().split('\n').slice(-4).join('\n') ||
              String(err || 'exited without reporting');
        resolve({error: why, registry: true, unresolved: []});
      },
    );
  });

/** Every compiled module that declares a shape: all of `shapes/`, plus decorated classes elsewhere. */
export const findShapeModules = (libEsm: string): string[] => {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (
        entry.name.endsWith('.js') &&
        !/\.(test|spec|class)\.js$/.test(entry.name)
      ) {
        const rel = path.relative(libEsm, full);
        if (
          rel.split(path.sep)[0] === 'shapes' ||
          declaresShape(fs.readFileSync(full, 'utf8'))
        ) {
          found.push(full);
        }
      }
    }
  };
  if (fs.existsSync(libEsm)) walk(libEsm);
  return found.sort();
};

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

const DEPENDENCY_FIELDS = [
  'dependencies',
  'peerDependencies',
  'optionalDependencies',
];

/**
 * Load each shape module of the package at `packagePath` in isolation and
 * collect load errors and unresolved property value shapes.
 */
export const inspectShapeReferences = async (
  packagePath: string,
  {
    concurrency = Math.min(8, Math.max(1, os.cpus().length - 1)),
    timeoutMs = 60000,
  } = {},
): Promise<ShapeReferenceReport> => {
  const libEsm = path.join(packagePath, 'lib', 'esm');
  const pkgJson = JSON.parse(
    fs.readFileSync(path.join(packagePath, 'package.json'), 'utf8'),
  );
  const modules = findShapeModules(libEsm);
  const report: ShapeReferenceReport = {
    modules: modules.map((m) => path.relative(libEsm, m)),
    loadErrors: [],
    unresolved: [],
    known: [],
  };
  if (modules.length === 0) return report;

  const ownName = runtimePackageName(libEsm, pkgJson);
  // The entry each slug's package is loaded through for the second look. This
  // package's own entry is loaded by path: a package cannot always import
  // itself by name.
  const entries: Record<string, {name: string; specifier: string}> = {};
  for (const field of DEPENDENCY_FIELDS) {
    for (const dep of Object.keys(pkgJson[field] || {})) {
      entries[packageNameToSlug(dep)] = {name: dep, specifier: dep};
    }
  }
  const ownEntry = path.join(
    packagePath,
    pkgJson.module || pkgJson.main || 'lib/esm/index.js',
  );
  for (const name of new Set([ownName, pkgJson.name])) {
    entries[packageNameToSlug(name)] = {
      name,
      specifier: fs.existsSync(ownEntry) ? 'file://' + ownEntry : name,
    };
  }
  const env = {
    LINKED_PROBE_SLUG: packageNameToSlug(ownName),
    LINKED_PROBE_ENTRIES: JSON.stringify(entries),
  };

  const results: ProbeResult[] = new Array(modules.length);
  let next = 0;
  await Promise.all(
    Array.from({length: Math.min(concurrency, modules.length)}, async () => {
      while (next < modules.length) {
        const i = next++;
        results[i] = await runProbe(modules[i], packagePath, env, timeoutMs);
      }
    }),
  );

  // No registry on `globalThis` after loading a module that declares a shape
  // means a core older than 2.22.3, whose registry is module-scoped. A module
  // under `shapes/` that declares none (a store, a helper) registers nothing.
  const stale = results.findIndex(
    (r, i) =>
      !r.error &&
      !r.registry &&
      declaresShape(fs.readFileSync(modules[i], 'utf8')),
  );
  if (stale !== -1) {
    report.skipped =
      `no shape registry on globalThis after loading ${report.modules[stale]}: the ` +
      '@_linked/core it loads is older than 2.22.3, whose registry cannot be inspected from outside';
    return report;
  }

  const byReference = new Map<string, UnresolvedShapeReference>();
  results.forEach((r, i) => {
    const module = report.modules[i];
    if (r.error) {
      report.loadErrors.push({module, error: r.error});
      return;
    }
    for (const u of r.unresolved) {
      const key = `${u.shape}\u0000${u.property}\u0000${u.valueShape}`;
      const existing = byReference.get(key);
      if (existing) existing.modules.push(module);
      else byReference.set(key, {...u, modules: [module]});
    }
  });
  for (const ref of byReference.values()) {
    const isKnown = KNOWN_UNRESOLVED.some(
      (k) =>
        k.package === ownName &&
        ref.shape.endsWith(k.shape) &&
        ref.property === k.property &&
        ref.valueShape.endsWith(k.valueShape),
    );
    (isKnown ? report.known : report.unresolved).push(ref);
  }
  return report;
};

const shortIri = (iri: string) => iri.replace(/^.*\/shape\//, '');

const modulesList = (modules: string[]) =>
  modules.length <= 3
    ? modules.join(', ')
    : `${modules.slice(0, 3).join(', ')} and ${modules.length - 3} more`;

const describeReference = (ref: UnresolvedShapeReference): string => {
  const label = `${shortIri(ref.shape)}.${ref.property} -> ${ref.valueShape}`;
  const fix =
    ref.target === 'registered'
      ? `${ref.targetPackage}'s entry registers it, so the module that declares the property must import the module that declares ${shortIri(ref.valueShape)}`
      : ref.target === 'missing'
        ? `not registered even by ${ref.targetPackage}'s entry: the shape name is wrong or ${ref.targetPackage} does not define it`
        : ref.target === 'not-a-dependency'
          ? `'${slugOf(ref.valueShape)}' is neither this package nor one of its dependencies (an old package name?)`
          : `${ref.targetPackage}'s entry could not be loaded to tell why`;
  return `  ${label}\n    unresolved after loading ${modulesList(ref.modules)}\n    ${fix}`;
};

/**
 * Build step. Load errors and unresolved references fail the build: each is a
 * bug the package would ship, and it only surfaces in a consumer's bundle. The
 * references in {@link KNOWN_UNRESOLVED} warn instead.
 */
export const checkShapeReferences = async (
  packagePath: string,
  options?: Parameters<typeof inspectShapeReferences>[1],
): Promise<true | string | {error: string}> => {
  const report = await inspectShapeReferences(packagePath, options);
  if (report.skipped) return `skipped: ${report.skipped}`;
  const problems: string[] = [];
  if (report.loadErrors.length > 0) {
    problems.push(
      `${report.loadErrors.length} shape module(s) throw when loaded on their own:\n` +
        report.loadErrors
          .map((e) => `  ${e.module}: ${e.error.split('\n').join('\n    ')}`)
          .join('\n'),
    );
  }
  if (report.unresolved.length > 0) {
    problems.push(
      `${report.unresolved.length} property value shape(s) are not registered when the module that ` +
        `declares the property is loaded on its own, so a query traversing them throws ` +
        `"Shape class not found":\n` +
        report.unresolved.map(describeReference).join('\n'),
    );
  }
  if (problems.length > 0) return {error: problems.join('\n')};
  if (report.known.length > 0) {
    return (
      `${report.known.length} known unresolved reference(s), tracked for a fix:\n` +
      report.known.map(describeReference).join('\n')
    );
  }
  return true;
};
