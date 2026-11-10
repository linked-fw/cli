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
 * The other keys are the app's settings: `cssMode`, `syncShapesOnBoot`, `datasetCloneScript`,
 * `publish` and `server` ({@link AppConfig}). They replace the `linked.config.js` module, which is
 * no longer read: an app that still has one is refused ({@link assertNoLegacyConfig}).
 *
 * The schema ships with this package (`schema/app/1.json`). A tool refuses a `schemaVersion` it
 * does not know, and any key the schema does not have.
 */
import fs from 'fs';
import path from 'path';
import type {AppPublishConfig} from '../app-release/types.js';
import type {
  AppServerSettings,
  CssMode,
  LinkedConfig,
  RawQueriesMode,
  RpcExposureMode,
} from '../interfaces.js';
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
  /**
   * CSS processing the server applies for server-side rendering in development: `tailwind`
   * (Tailwind CSS v4) or `postcss` (the default).
   */
  cssMode?: CssMode;
  /**
   * Materialize the app's registered shapes into its data store as SHACL on boot (default
   * true). `false` for a server whose default dataset routes data per context, or an app that
   * manages its own shape and dataset lifecycle.
   */
  syncShapesOnBoot?: boolean;
  /**
   * The npm script that copies the app's data into a dataset named by its one argument; `linked
   * worktree add --dataset` prints it (default `clone-dataset`).
   */
  datasetCloneScript?: string;
  /** What `linked build-app` ships besides the Vite bundle, and where releases go. */
  publish?: AppPublishConfig;
  /** The server's settings. */
  server?: AppServerSettings;
}

/** The order keys are written in. */
const KEYS = [
  '$schema',
  'schemaVersion',
  'prefixes',
  'cssMode',
  'syncShapesOnBoot',
  'datasetCloneScript',
  'publish',
  'server',
] as const;
const SERVER_KEYS = [
  'rpcExposure',
  'rawQueries',
  'apiOnly',
  'cachePaths',
  'cacheTimeout',
] as const;
const PUBLISH_KEYS = ['staticAssets', 'releasePrefix'] as const;

const CSS_MODES: readonly CssMode[] = ['tailwind', 'postcss'];
const RPC_EXPOSURE_MODES: readonly RpcExposureMode[] = ['warn', 'enforce'];
const RAW_QUERIES_MODES: readonly RawQueriesMode[] = ['off', 'session'];

/** A JSON object (not an array, not null). */
const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/** Refuses a key of `object` (at `at`, e.g. `"server"`) that `keys` does not list. */
function checkKeys(
  object: Record<string, unknown>,
  keys: readonly string[],
  where: string,
  at?: string,
): void {
  for (const key of Object.keys(object)) {
    if (!keys.includes(key)) {
      const name = at ? `"${at}" has the key "${key}"` : `has the key "${key}"`;
      throw new Error(
        `${where} ${name}, which schema version ${APP_SCHEMA_VERSION} does not have (${keys.join(', ')}).`,
      );
    }
  }
}

/** The settings of a parsed file, checked: each one only when present. */
function readSettings(
  json: Record<string, unknown>,
  where: string,
): Omit<AppConfig, '$schema' | 'schemaVersion' | 'prefixes'> {
  const oneOf = <T extends string>(
    value: unknown,
    allowed: readonly T[],
    name: string,
  ): T => {
    if (!allowed.includes(value as T)) {
      throw new Error(
        `${where}: "${name}" must be ${allowed.map((a) => `"${a}"`).join(' or ')}, not ${JSON.stringify(value)}.`,
      );
    }
    return value as T;
  };
  const ofType = <T>(value: unknown, type: string, name: string): T => {
    if (typeof value !== type) {
      throw new Error(`${where}: "${name}" must be a ${type}.`);
    }
    return value as T;
  };
  const strings = (value: unknown, name: string): string[] => {
    if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
      throw new Error(`${where}: "${name}" must be a list of strings.`);
    }
    return [...value];
  };
  const out: Omit<AppConfig, '$schema' | 'schemaVersion' | 'prefixes'> = {};
  if (json.cssMode !== undefined) {
    out.cssMode = oneOf(json.cssMode, CSS_MODES, 'cssMode');
  }
  if (json.syncShapesOnBoot !== undefined) {
    out.syncShapesOnBoot = ofType(json.syncShapesOnBoot, 'boolean', 'syncShapesOnBoot');
  }
  if (json.datasetCloneScript !== undefined) {
    out.datasetCloneScript = ofType(json.datasetCloneScript, 'string', 'datasetCloneScript');
  }
  if (json.publish !== undefined) {
    if (!isObject(json.publish)) {
      throw new Error(`${where}: "publish" must be an object.`);
    }
    checkKeys(json.publish, PUBLISH_KEYS, where, 'publish');
    const publish: AppPublishConfig = {};
    if (json.publish.staticAssets !== undefined) {
      publish.staticAssets = strings(json.publish.staticAssets, 'publish.staticAssets');
    }
    if (json.publish.releasePrefix !== undefined) {
      publish.releasePrefix = ofType(
        json.publish.releasePrefix,
        'string',
        'publish.releasePrefix',
      );
    }
    out.publish = publish;
  }
  if (json.server !== undefined) {
    if (!isObject(json.server)) {
      throw new Error(`${where}: "server" must be an object.`);
    }
    const server = json.server;
    checkKeys(server, SERVER_KEYS, where, 'server');
    const settings: AppServerSettings = {};
    if (server.rpcExposure !== undefined) {
      settings.rpcExposure = oneOf(server.rpcExposure, RPC_EXPOSURE_MODES, 'server.rpcExposure');
    }
    if (server.rawQueries !== undefined) {
      settings.rawQueries = oneOf(server.rawQueries, RAW_QUERIES_MODES, 'server.rawQueries');
    }
    if (server.apiOnly !== undefined) {
      settings.apiOnly = ofType(server.apiOnly, 'boolean', 'server.apiOnly');
    }
    if (server.cachePaths !== undefined) {
      settings.cachePaths = strings(server.cachePaths, 'server.cachePaths');
    }
    if (server.cacheTimeout !== undefined) {
      const timeout = ofType<number>(server.cacheTimeout, 'number', 'server.cacheTimeout');
      if (!Number.isFinite(timeout) || timeout < 0) {
        throw new Error(`${where}: "server.cacheTimeout" must be a number of milliseconds, 0 or more.`);
      }
      settings.cacheTimeout = timeout;
    }
    out.server = settings;
  }
  return out;
}

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
  checkKeys(json, KEYS, where);
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
    ...readSettings(json, where),
  };
}

/** The app's `linked.app.json`, checked; undefined when it has none. */
export function readAppConfig(appRoot: string): AppConfig | undefined {
  const file = path.join(appRoot, APP_CONFIG_FILE);
  if (!fs.existsSync(file)) return undefined;
  return parseAppConfig(fs.readFileSync(file, 'utf8'), file);
}

/**
 * The text of a `linked.app.json`, two-space JSON: `$schema`, `schemaVersion`, `prefixes`, then
 * every setting the config has, in the schema's order.
 */
export function serializeAppConfig(config: AppConfig): string {
  const out: Record<string, unknown> = {
    $schema: config.$schema ?? APP_SCHEMA_URL,
    schemaVersion: config.schemaVersion,
    prefixes: config.prefixes,
  };
  for (const key of KEYS) {
    if (!(key in out) && config[key] !== undefined) out[key] = config[key];
  }
  return JSON.stringify(out, null, 2) + '\n';
}

/**
 * The app's settings module, which this cli no longer reads (current name first, then the legacy
 * one).
 */
export const LEGACY_CONFIG_FILES = ['linked.config.js', 'lincd.config.js'];

/**
 * Refuses an app that still has a `linked.config.js` (or `lincd.config.js`): its settings would be
 * silently ignored. The error says how to move them into `linked.app.json`.
 */
export function assertNoLegacyConfig(appRoot: string): void {
  const file = LEGACY_CONFIG_FILES.find((name) =>
    fs.existsSync(path.join(appRoot, name)),
  );
  if (!file) return;
  throw new Error(
    `${path.join(appRoot, file)} is no longer read: an app's settings live in ${APP_CONFIG_FILE}. Move them there and delete ${file}:

` +
      `  {
` +
      `    "$schema": "${APP_SCHEMA_URL}",
` +
      `    "schemaVersion": ${APP_SCHEMA_VERSION},
` +
      `    "prefixes": {},
` +
      `    "cssMode": "tailwind",
` +
      `    "syncShapesOnBoot": true,
` +
      `    "datasetCloneScript": "clone-dataset",
` +
      `    "publish": {"staticAssets": ["fonts/**"], "releasePrefix": "releases"},
` +
      `    "server": {"rpcExposure": "enforce", "rawQueries": "off", "apiOnly": false, "cachePaths": ["/"], "cacheTimeout": 300000}
` +
      `  }

` +
      `Keep only the keys you set. Values are JSON: a value computed from the environment becomes the variable ` +
      `(LINKED_RPC_EXPOSURE wins over "server.rpcExposure"). \`webpack\` and \`server.multiCore\` are gone; ` +
      `\`server.loadAppComponent\` and \`server.loadRoutes\` are not settings (the server loads src/App and src/routes). ` +
      `Run \`linked prefixes\` to fill "prefixes".`,
  );
}

/**
 * The app's settings: its `linked.app.json` (none: no settings). Refuses an app that still has a
 * `linked.config.js`, and an invalid file.
 */
export function readAppSettings(appRoot: string): AppConfig | undefined {
  assertNoLegacyConfig(appRoot);
  return readAppConfig(appRoot);
}

/**
 * The configuration the cli gives the app's `LinkedServer`, from the app's settings: `cssMode`,
 * `syncShapesOnBoot` and `server`. `LINKED_RPC_EXPOSURE` in `env`, when set, wins over
 * `server.rpcExposure` (a value other than `warn` or `enforce` is refused). Returns a new object
 * each time; the caller adds the server's load hooks to it.
 */
export function linkedServerConfig(
  appRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): LinkedConfig & {server: NonNullable<LinkedConfig['server']>} {
  const settings = readAppSettings(appRoot);
  const server: NonNullable<LinkedConfig['server']> = {...settings?.server};
  const fromEnv = env.LINKED_RPC_EXPOSURE;
  if (fromEnv !== undefined && fromEnv !== '') {
    if (!RPC_EXPOSURE_MODES.includes(fromEnv as RpcExposureMode)) {
      throw new Error(
        `LINKED_RPC_EXPOSURE must be ${RPC_EXPOSURE_MODES.map((m) => `"${m}"`).join(' or ')}, not ${JSON.stringify(fromEnv)}.`,
      );
    }
    server.rpcExposure = fromEnv as RpcExposureMode;
  }
  return {
    ...(settings?.cssMode === undefined ? {} : {cssMode: settings.cssMode}),
    ...(settings?.syncShapesOnBoot === undefined
      ? {}
      : {syncShapesOnBoot: settings.syncShapesOnBoot}),
    server,
  };
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

/**
 * The module the browser bundle evaluates first: it loads the app's map into core. A core older
 * than `Prefix.load` (its packages still register their own prefixes) is left as it is.
 */
export function appPrefixesModuleCode(
  prefixes: Record<string, string>,
): string {
  return (
    `import {Prefix} from '${PREFIX_MODULE}';\n` +
    `if (typeof Prefix.load === 'function') Prefix.load(${JSON.stringify(prefixes)});\n` +
    `else console.warn(${JSON.stringify(OLD_CORE_WARNING)});\n`
  );
}

/** What loading says when the app's core predates `Prefix.load`. */
export const OLD_CORE_WARNING = `[linked] ${APP_CONFIG_FILE}: the @_linked/core this app loads has no Prefix.load, so its prefix map is not loaded (its packages register their own prefixes). Update @_linked/core to use the map.`;

/**
 * Loads the app's prefix map (its `linked.app.json`) into core, through `importModule` (the
 * runtime's own import, so it is the app's copy of core). Returns the map, or undefined when the
 * app has no `linked.app.json` or its core predates `Prefix.load` (it warns then). Throws when the
 * file is invalid.
 */
export async function loadAppPrefixes(
  appRoot: string,
  importModule: (specifier: string) => Promise<Record<string, any>>,
): Promise<Record<string, string> | undefined> {
  const config = readAppConfig(appRoot);
  if (!config) return undefined;
  const {Prefix} = await importModule(PREFIX_MODULE);
  if (typeof Prefix?.load !== 'function') {
    console.warn(OLD_CORE_WARNING);
    return undefined;
  }
  Prefix.load(config.prefixes);
  return config.prefixes;
}
