/**
 * `linked.app.json`: an app's declarative settings, JSON, at the app root. Apps only; a package
 * never has one.
 *
 * ```json
 * {
 *   "$schema": "https://linked.cm/schema/app/1.json",
 *   "schemaVersion": 1,
 *   "prefixes": {"schema": "https://schema.org/", "rdfs": "http://www.w3.org/2000/01/rdf-schema#"}
 * }
 * ```
 *
 * `prefixes` is the app's prefix map: its server, its browser bundle and its store queries all use
 * it. Tools only add to it ({@link addMissingPrefixes}, `linked prefixes`): when an ontology the
 * app has installed has a namespace not in the map, its suggested prefix is added, or `<prefix>_2`,
 * `_3`, … when taken. A tool never changes or removes an entry; that is the app owner's.
 *
 * The schema ships with this package (`schema/app/1.json`). A tool refuses a `schemaVersion` it
 * does not know, and any key the schema does not have.
 */
import fs from 'fs';
import path from 'path';
import {
  discoverInstalledLinkedPackages,
  linkedKind,
} from '../installed-packages.js';
import {readOntologyConfigs} from './ontologyConfig.js';
import {
  OntologyVannError,
  ontologySuggestedPrefix,
  ontologyTermsFromTurtle,
} from './ontologyTerms.js';

/** The file, at the app root. */
export const APP_CONFIG_FILE = 'linked.app.json';

/** The schema version this cli reads and writes. */
export const APP_SCHEMA_VERSION = 1;

/** The `$schema` of a version 1 file. */
export const APP_SCHEMA_URL = 'https://linked.cm/schema/app/1.json';

/**
 * A prefix in the app's map: a Turtle and SPARQL prefix name that is also a JavaScript
 * identifier.
 */
export const PREFIX_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;

/** What a prefix maps to: an absolute IRI. */
const NAMESPACE_IRI = /^[A-Za-z][A-Za-z0-9+.-]*:\S+$/;

/** A version 1 `linked.app.json`. */
export interface AppConfig {
  $schema?: string;
  schemaVersion: typeof APP_SCHEMA_VERSION;
  /** Prefix → namespace IRI. */
  prefixes: Record<string, string>;
}

const KEYS = new Set(['$schema', 'schemaVersion', 'prefixes']);

/**
 * The parsed and checked text of a `linked.app.json`; `where` names it in errors. Refuses a
 * missing or unknown `schemaVersion`, an unknown key, a prefix outside {@link PREFIX_NAME} and a
 * namespace that is not an IRI.
 */
export function parseAppConfig(
  text: string,
  where: string = APP_CONFIG_FILE,
): AppConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `${where} is not JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${where} must hold a JSON object.`);
  }
  const json = raw as Record<string, unknown>;
  if (json.schemaVersion === undefined) {
    throw new Error(
      `${where} has no "schemaVersion". Add "schemaVersion": ${APP_SCHEMA_VERSION}.`,
    );
  }
  if (json.schemaVersion !== APP_SCHEMA_VERSION) {
    throw new Error(
      `${where} has "schemaVersion": ${JSON.stringify(json.schemaVersion)}, which this @_linked/cli does not know (it reads version ${APP_SCHEMA_VERSION}). Update @_linked/cli.`,
    );
  }
  for (const key of Object.keys(json)) {
    if (!KEYS.has(key)) {
      throw new Error(
        `${where} has the key "${key}", which schema version ${APP_SCHEMA_VERSION} does not have (${[...KEYS].join(', ')}).`,
      );
    }
  }
  if (json.$schema !== undefined && typeof json.$schema !== 'string') {
    throw new Error(`${where}: "$schema" must be a string.`);
  }
  const prefixes = json.prefixes ?? {};
  if (!prefixes || typeof prefixes !== 'object' || Array.isArray(prefixes)) {
    throw new Error(
      `${where}: "prefixes" must be an object of {"<prefix>": "<namespace IRI>"}.`,
    );
  }
  for (const [prefix, namespace] of Object.entries(prefixes)) {
    if (!PREFIX_NAME.test(prefix)) {
      throw new Error(
        `${where}: the prefix "${prefix}" must start with a letter, then letters, digits or _.`,
      );
    }
    if (typeof namespace !== 'string' || !NAMESPACE_IRI.test(namespace)) {
      throw new Error(
        `${where}: the prefix "${prefix}" must map to a namespace IRI, such as "https://example.org/ont/".`,
      );
    }
  }
  return {
    ...(json.$schema === undefined ? {} : {$schema: json.$schema as string}),
    schemaVersion: APP_SCHEMA_VERSION,
    prefixes: {...(prefixes as Record<string, string>)},
  };
}

/** The app's `linked.app.json`, checked; undefined when it has none. */
export function readAppConfig(appRoot: string): AppConfig | undefined {
  const file = path.join(appRoot, APP_CONFIG_FILE);
  if (!fs.existsSync(file)) return undefined;
  return parseAppConfig(fs.readFileSync(file, 'utf8'), file);
}

/** The text of a `linked.app.json`: `$schema`, `schemaVersion`, `prefixes`, two-space JSON. */
export function serializeAppConfig(config: AppConfig): string {
  return (
    JSON.stringify(
      {
        $schema: config.$schema ?? APP_SCHEMA_URL,
        schemaVersion: config.schemaVersion,
        prefixes: config.prefixes,
      },
      null,
      2,
    ) + '\n'
  );
}

/** The text of a new app's `linked.app.json`, with an empty map. */
export function newAppConfigText(): string {
  return serializeAppConfig({schemaVersion: APP_SCHEMA_VERSION, prefixes: {}});
}

/** An ontology the app has installed, as the prefix builder needs it. */
export interface AppOntology {
  packageName: string;
  /** The ontology's name within its package. */
  name: string;
  namespace: string;
  /** Its `vann:preferredNamespacePrefix`. */
  suggestedPrefix: string;
}

/** One entry a builder run added. */
export interface AddedPrefix {
  prefix: string;
  namespace: string;
  /** The ontology it was added for. */
  packageName: string;
  name: string;
}

/**
 * A suggested prefix as a map name: every character outside `[A-Za-z0-9_]` becomes `_`
 * (`server-utils` → `server_utils`), and a name not starting with a letter gets a leading `p`.
 */
export function prefixCandidate(suggestedPrefix: string): string {
  const name = suggestedPrefix.replace(/[^A-Za-z0-9_]/g, '_');
  return /^[A-Za-z]/.test(name) ? name : `p${name}`;
}

/**
 * The map with a prefix added for every ontology whose namespace it does not map yet: its
 * suggested prefix ({@link prefixCandidate}), or `<prefix>_2`, `_3`, … when taken. Existing
 * entries are kept as they are, in their order; the new ones follow, in the order given.
 */
export function addMissingPrefixes(
  prefixes: Record<string, string>,
  ontologies: AppOntology[],
): {prefixes: Record<string, string>; added: AddedPrefix[]} {
  const next = {...prefixes};
  const mapped = new Set(Object.values(next));
  const added: AddedPrefix[] = [];
  for (const ontology of ontologies) {
    if (mapped.has(ontology.namespace)) continue;
    const base = prefixCandidate(ontology.suggestedPrefix);
    let prefix = base;
    for (let n = 2; prefix in next; n++) prefix = `${base}_${n}`;
    next[prefix] = ontology.namespace;
    mapped.add(ontology.namespace);
    added.push({
      prefix,
      namespace: ontology.namespace,
      packageName: ontology.packageName,
      name: ontology.name,
    });
  }
  return {prefixes: next, added};
}

/** Code-unit order: locale-independent. */
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Every ontology the app has installed: those its own `package.json` declares and those of every
 * linked package it depends on (recursively), each with the suggested prefix its data states.
 * Sorted by package name, then ontology name. Throws, naming the package, when an ontology's data
 * cannot be found or has no suggested prefix.
 */
export async function appOntologies(appRoot: string): Promise<AppOntology[]> {
  const appJson = JSON.parse(
    fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8'),
  );
  const packages = [
    {
      name: String(appJson.name ?? path.basename(appRoot)),
      root: appRoot,
      json: appJson,
    },
    ...(await discoverInstalledLinkedPackages(appRoot)).map((p) => ({
      name: p.name,
      root: p.realRoot,
      json: p.json,
    })),
  ];
  const found: AppOntology[] = [];
  const seen = new Set<string>();
  for (const pkg of packages) {
    let configs;
    try {
      configs = readOntologyConfigs(pkg.json);
    } catch (error) {
      throw new Error(
        `${pkg.name}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    for (const config of configs) {
      // One package installed twice (two copies) is read once.
      const key = `${pkg.name}\0${config.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const sources = config.data.map((file) => {
        const full = [
          path.join(pkg.root, 'src', 'data', file),
          path.join(pkg.root, 'lib', 'esm', 'data', file),
        ].find((candidate) => fs.existsSync(candidate));
        if (!full) {
          throw new Error(
            `${pkg.name}: the data file ${file} of the ontology "${config.name}" is in neither src/data/ nor lib/esm/data/ of ${pkg.root}.`,
          );
        }
        return {
          name: path.relative(pkg.root, full),
          text: fs.readFileSync(full, 'utf8'),
        };
      });
      const read = await ontologyTermsFromTurtle(sources, config.namespace);
      let suggestedPrefix: string;
      try {
        suggestedPrefix = ontologySuggestedPrefix(read, config.namespace);
      } catch (error) {
        if (!(error instanceof OntologyVannError)) throw error;
        throw new Error(
          `${pkg.name}: the ontology "${config.name}" has no suggested prefix: ${error.message}.`,
        );
      }
      found.push({
        packageName: pkg.name,
        name: config.name,
        namespace: config.namespace,
        suggestedPrefix,
      });
    }
  }
  return found.sort(
    (a, b) => compare(a.packageName, b.packageName) || compare(a.name, b.name),
  );
}

/**
 * `linked prefixes`: adds a prefix to the app's `linked.app.json` for every installed ontology
 * whose namespace it does not map, creating the file when the app has none. Never changes or
 * removes an entry. Throws when `appRoot` is not an app.
 */
export async function refreshAppPrefixes(appRoot: string): Promise<{
  file: string;
  created: boolean;
  added: AddedPrefix[];
}> {
  const pkgFile = path.join(appRoot, 'package.json');
  const json = fs.existsSync(pkgFile)
    ? JSON.parse(fs.readFileSync(pkgFile, 'utf8'))
    : undefined;
  if (linkedKind(json) !== 'app') {
    throw new Error(
      `${appRoot} is not a linked app (its package.json has no "linked": {"kind": "app"}). ${APP_CONFIG_FILE} belongs to an app; a package never has one.`,
    );
  }
  const file = path.join(appRoot, APP_CONFIG_FILE);
  const existing = readAppConfig(appRoot);
  const config: AppConfig = existing ?? {
    $schema: APP_SCHEMA_URL,
    schemaVersion: APP_SCHEMA_VERSION,
    prefixes: {},
  };
  const {prefixes, added} = addMissingPrefixes(
    config.prefixes,
    await appOntologies(appRoot),
  );
  if (!existing || added.length) {
    fs.writeFileSync(file, serializeAppConfig({...config, prefixes}));
  }
  return {file, created: !existing, added};
}

/**
 * The app `dir` belongs to: `dir` itself or the nearest folder above it whose `package.json` is
 * an app, within one git repository (the search stops at a folder holding `.git`, so a package
 * checkout nested inside an app's folder belongs to no app). Undefined when there is none.
 */
export function findAppRoot(dir: string): string | undefined {
  let current = path.resolve(dir);
  while (true) {
    const pkgFile = path.join(current, 'package.json');
    if (fs.existsSync(pkgFile)) {
      try {
        if (linkedKind(JSON.parse(fs.readFileSync(pkgFile, 'utf8'))) === 'app')
          return current;
      } catch {
        // An unreadable package.json is no app.
      }
    }
    if (fs.existsSync(path.join(current, '.git'))) return undefined;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/** The core module that holds the prefix map. */
export const PREFIX_MODULE = '@_linked/core/utils/Prefix';

/** The module the browser bundle evaluates first: it loads the app's map into core. */
export function appPrefixesModuleCode(
  prefixes: Record<string, string>,
): string {
  return (
    `import {Prefix} from '${PREFIX_MODULE}';\n` +
    `Prefix.load(${JSON.stringify(prefixes)});\n`
  );
}

/**
 * Loads the app's prefix map (its `linked.app.json`) into core, through `importModule` (the
 * runtime's own import, so it is the app's copy of core). Returns the map, or undefined when the
 * app has no `linked.app.json`. Throws when the file is invalid or core cannot load a map.
 */
export async function loadAppPrefixes(
  appRoot: string,
  importModule: (specifier: string) => Promise<Record<string, any>>,
): Promise<Record<string, string> | undefined> {
  const config = readAppConfig(appRoot);
  if (!config) return undefined;
  const {Prefix} = await importModule(PREFIX_MODULE);
  if (typeof Prefix?.load !== 'function') {
    throw new Error(
      `${APP_CONFIG_FILE}: the @_linked/core this app loads has no Prefix.load, so its prefix map cannot be loaded. Update @_linked/core.`,
    );
  }
  Prefix.load(config.prefixes);
  return config.prefixes;
}
