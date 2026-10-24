/**
 * `linked generate-ontology` and the build's staleness check: a package's ontology accessor
 * modules, generated from its Turtle.
 *
 * A package declares its ontologies in `package.json`, one entry per prefix:
 *
 * ```json
 * "linkedOntologies": {
 *   "rdf":  {"namespace": "http://www.w3.org/1999/02/22-rdf-syntax-ns#"},
 *   "rdfs": {"namespace": "http://www.w3.org/2000/01/rdf-schema#"},
 *   "schema": {"namespace": "http://schema.org/", "data": ["schema.ttl", "schema-added.ttl"]}
 * }
 * ```
 *
 * `data` names files in `src/data/` and defaults to `["<prefix>.ttl"]`. Each prefix gets
 * `src/ontologies/<prefix>.ts`, `<prefix>.data.ts` and `<prefix>.register.ts`
 * (`ontologyModules.ts`), with the terms of its namespace found in its data files. The modules
 * are committed; `linked build` fails when one differs from what the data generates.
 */
import fs from 'fs';
import path from 'path';
import {
  generateOntologyModules,
  ONTOLOGY_PREFIX,
  type OntologyModuleSpec,
} from './ontologyModules.js';
import {ontologyTermsFromTurtle} from './ontologyTerms.js';

/** One `linkedOntologies` entry, validated. */
export interface OntologyConfig {
  prefix: string;
  namespace: string;
  /** File names in `src/data/`. */
  data: string[];
}

/** The `package.json` key. */
export const ONTOLOGIES_KEY = 'linkedOntologies';

/**
 * The package's `linkedOntologies`, sorted by prefix; empty when it has none. Throws, naming the
 * entry, on anything malformed.
 */
export function readOntologyConfigs(
  pkgJson: Record<string, unknown>,
): OntologyConfig[] {
  const raw = pkgJson[ONTOLOGIES_KEY];
  if (raw === undefined) return [];
  const where = `package.json "${ONTOLOGIES_KEY}"`;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(
      `${where} must be an object of {"<prefix>": {"namespace": "<IRI>"}}.`,
    );
  }
  return Object.entries(raw as Record<string, unknown>)
    .map(([prefix, entry]): OntologyConfig => {
      const at = `${where}.${prefix}`;
      if (!ONTOLOGY_PREFIX.test(prefix)) {
        throw new Error(
          `${at}: the prefix must be letters and digits, with single hyphens or underscores between them.`,
        );
      }
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new Error(`${at} must be an object with a "namespace".`);
      }
      const {namespace, data} = entry as {namespace?: unknown; data?: unknown};
      if (
        typeof namespace !== 'string' ||
        !/^[a-z][a-z0-9+.-]*:\S+$/i.test(namespace)
      ) {
        throw new Error(
          `${at}.namespace must be an IRI, such as "https://example.org/ont/".`,
        );
      }
      const files = data === undefined ? [`${prefix}.ttl`] : data;
      if (
        !Array.isArray(files) ||
        !files.length ||
        files.some(
          (f) =>
            typeof f !== 'string' ||
            !/^[A-Za-z0-9_][A-Za-z0-9._-]*\.ttl$/.test(f),
        )
      ) {
        throw new Error(
          `${at}.data must list one or more .ttl file names in src/data/.`,
        );
      }
      return {prefix, namespace, data: files as string[]};
    })
    .sort((a, b) => (a.prefix < b.prefix ? -1 : a.prefix > b.prefix ? 1 : 0));
}

/** One ontology's generated modules, and what was left out. */
export interface OntologyGeneration {
  config: OntologyConfig;
  /** Path relative to the package (`src/ontologies/schema.ts`) → content. */
  files: Record<string, string>;
  termCount: number;
  /** Subjects under the namespace that are not terms of it (`ontologyTermsFromTurtle`). */
  skipped: string[];
}

/** Every ontology module the package's data generates; none without `linkedOntologies`. */
export async function generatePackageOntologies(
  packagePath: string,
): Promise<OntologyGeneration[]> {
  const pkgJson = JSON.parse(
    fs.readFileSync(path.join(packagePath, 'package.json'), 'utf8'),
  );
  const generations: OntologyGeneration[] = [];
  for (const config of readOntologyConfigs(pkgJson)) {
    const sources = config.data.map((file) => {
      const name = `src/data/${file}`;
      const full = path.join(packagePath, 'src', 'data', file);
      if (!fs.existsSync(full)) {
        throw new Error(
          `${ONTOLOGIES_KEY}.${config.prefix} names ${name}, which does not exist.`,
        );
      }
      return {name, text: fs.readFileSync(full, 'utf8')};
    });
    const {terms, skipped} = await ontologyTermsFromTurtle(
      sources,
      config.namespace,
    );
    const spec: OntologyModuleSpec = {
      prefix: config.prefix,
      namespace: config.namespace,
      dataFiles: config.data.map((file) => `../data/${file}`),
      terms,
    };
    generations.push({
      config,
      files: generateOntologyModules(spec),
      termCount: terms.length,
      skipped,
    });
  }
  return generations;
}

/** Writes every generated module; returns the paths whose content changed. */
export async function writePackageOntologies(
  packagePath: string,
  generations?: OntologyGeneration[],
): Promise<string[]> {
  const changed: string[] = [];
  for (const {files} of generations ??
    (await generatePackageOntologies(packagePath))) {
    for (const [file, content] of Object.entries(files)) {
      const full = path.join(packagePath, file);
      if (readIfExists(full) === content) continue;
      fs.mkdirSync(path.dirname(full), {recursive: true});
      fs.writeFileSync(full, content);
      changed.push(file);
    }
  }
  return changed;
}

/** The generated modules that are missing or differ from what the data generates. */
export async function staleOntologyModules(
  packagePath: string,
  generations?: OntologyGeneration[],
): Promise<string[]> {
  const stale: string[] = [];
  for (const {files} of generations ??
    (await generatePackageOntologies(packagePath))) {
    for (const [file, content] of Object.entries(files)) {
      if (readIfExists(path.join(packagePath, file)) !== content)
        stale.push(file);
    }
  }
  return stale;
}

/**
 * The build step: an error naming the stale modules, else success. A package without
 * `linkedOntologies` passes untouched.
 */
export async function checkOntologyModulesStep(
  packagePath: string,
): Promise<true | {info: string} | {error: string}> {
  let stale: string[];
  try {
    const pkgJson = JSON.parse(
      fs.readFileSync(path.join(packagePath, 'package.json'), 'utf8'),
    );
    if (!readOntologyConfigs(pkgJson).length) return true;
    stale = await staleOntologyModules(packagePath);
  } catch (error) {
    return {error: error instanceof Error ? error.message : String(error)};
  }
  if (!stale.length) return true;
  return {
    error:
      `${stale.join(', ')} ${stale.length === 1 ? 'is' : 'are'} not what the ontology data generates. ` +
      `Run \`linked generate-ontology\` and commit the result.`,
  };
}

/** A file's text with CRLF read as LF (a Windows checkout's line endings), else undefined. */
function readIfExists(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  } catch {
    return undefined;
  }
}
