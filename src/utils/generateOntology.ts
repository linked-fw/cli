/**
 * `linked generate-ontology` and the build's staleness check: a package's ontology accessor
 * modules, generated from its Turtle.
 *
 * A package declares its ontologies in `package.json`, one entry per ontology, keyed by its name
 * within the package:
 *
 * ```json
 * "linkedOntologies": {
 *   "rdf":  {"namespace": "http://www.w3.org/1999/02/22-rdf-syntax-ns#"},
 *   "rdfs": {"namespace": "http://www.w3.org/2000/01/rdf-schema#"},
 *   "schema": {"namespace": "http://schema.org/", "data": ["schema.ttl", "schema-added.ttl"]}
 * }
 * ```
 *
 * `data` names files in `src/data/` and defaults to `["<name>.ttl"]`; `module` names its modules
 * and defaults to the name. Each ontology gets `src/ontologies/<module>.ts`, `<module>.data.ts`
 * and `<module>.register.ts` (`ontologyModules.ts`), imported as `<package>/ontologies/<module>`,
 * with the terms of its namespace found in its data files. Its suggested prefix is data: the
 * `vann:preferredNamespacePrefix` of its `owl:Ontology` node, whose `vann:preferredNamespaceUri`
 * must be the configured namespace. The modules are committed; `linked build` fails when one
 * differs from what the data generates, or the data lacks the vann triples.
 *
 * An entry with `"generated": false` declares an ontology whose modules are written by hand
 * (they hold more than the generator writes): nothing is generated or compared for it, but its
 * data must carry the same vann triples.
 */
import fs from 'fs';
import path from 'path';
import {
  generateOntologyModules,
  SUGGESTED_PREFIX,
  type OntologyModuleSpec,
} from './ontologyModules.js';
import {
  ONTOLOGIES_KEY,
  readOntologyConfigs,
  type OntologyConfig,
} from './ontologyConfig.js';
import {
  OntologyVannError,
  ontologySuggestedPrefix,
  ontologyTermsFromTurtle,
} from './ontologyTerms.js';

/** One ontology's generated modules, and what was left out. */
export interface OntologyGeneration {
  config: OntologyConfig;
  /**
   * Path relative to the package (`src/ontologies/schema.ts`) → content; empty for an ontology
   * whose modules are written by hand.
   */
  files: Record<string, string>;
  termCount: number;
  /** Subjects under the namespace that are not terms of it (`ontologyTermsFromTurtle`). */
  skipped: string[];
}

/**
 * Every ontology module the package's data generates; none without `linkedOntologies`. The vann
 * data of every ontology is checked, including one whose modules are written by hand.
 */
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
          `${ONTOLOGIES_KEY}.${config.name} names ${name}, which does not exist.`,
        );
      }
      return {name, text: fs.readFileSync(full, 'utf8')};
    });
    const read = await ontologyTermsFromTurtle(sources, config.namespace);
    const {terms, skipped, ontology} = read;
    let suggestedPrefix: string;
    try {
      suggestedPrefix = ontologySuggestedPrefix(read, config.namespace);
    } catch (error) {
      if (!(error instanceof OntologyVannError)) throw error;
      throw new Error(
        vannMessage(
          pkgJson.name,
          config,
          sources.map((s) => s.name),
          error,
        ),
      );
    }
    const spec: OntologyModuleSpec = {
      name: config.name,
      module: config.module,
      suggestedPrefix,
      namespace: config.namespace,
      dataFiles: config.data.map((file) => `../data/${file}`),
      terms,
      ...(ontology === undefined ? {} : {ontology}),
    };
    generations.push({
      config,
      files: config.generated ? generateOntologyModules(spec) : {},
      termCount: terms.length,
      skipped,
    });
  }
  return generations;
}

/**
 * The build's refusal of an ontology without its vann data: what is wrong, and the triples to add
 * (on its `owl:Ontology` node, which it declares too when it has none).
 */
function vannMessage(
  packageName: unknown,
  config: OntologyConfig,
  files: string[],
  error: OntologyVannError,
): string {
  const pkg = typeof packageName === 'string' ? `${packageName}: ` : '';
  const prefix = SUGGESTED_PREFIX.test(config.name) ? config.name : '<prefix>';
  return (
    `${pkg}the ontology "${config.name}" (${files.join(', ')}) has no suggested prefix: ${error.message}. ` +
    `Its owl:Ontology node must carry its suggested prefix and its namespace, for example:\n\n` +
    `  @prefix owl: <http://www.w3.org/2002/07/owl#> .\n` +
    `  @prefix vann: <http://purl.org/vocab/vann/> .\n\n` +
    `  <${error.subject}>${error.noOntologyNode ? ' a owl:Ontology ;' : ''}\n` +
    `    vann:preferredNamespacePrefix "${prefix}" ;\n` +
    `    vann:preferredNamespaceUri "${config.namespace}" .\n\n` +
    `Add it to one of its data files (a new file goes in "${ONTOLOGIES_KEY}".${config.name}.data). ` +
    `For a published vocabulary shipped unedited, put it in src/data/${config.name}-added.ttl, never in the published file.`
  );
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
      `Run \`linked generate-ontology\` and commit the result. ` +
      `If an ontology's modules are written by hand, declare it with "generated": false in "${ONTOLOGIES_KEY}".`,
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
