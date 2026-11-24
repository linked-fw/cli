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
 * `data` names files in `src/data/` and defaults to `["<name>.ttl"]`; `module` names its module
 * and defaults to the name. Each ontology gets `src/ontologies/<module>.ts`, its terms, imported
 * as `<package>/ontologies/<module>`, with the terms of its namespace found in its data files;
 * the package gets one `src/ontologies/index.ts` registering all of them, which its entry
 * (`src/index.ts[x]`) imports (`ontologyModules.ts`). Each ontology's suggested prefix is data:
 * the `vann:preferredNamespacePrefix` of its `owl:Ontology` node, whose
 * `vann:preferredNamespaceUri` must be the configured namespace. The modules are committed;
 * `linked build` fails when one differs from what the data generates, the entry does not import
 * the index, a file it generated and no longer writes (`<module>.data.ts`, `<module>.register.ts`) is left, or
 * the data lacks the vann triples.
 *
 * An entry with `"generated": false` declares an ontology whose module is written by hand (it
 * holds more than the generator writes): no terms module is generated or compared for it, but the
 * index registers it and its data must carry the same vann triples.
 */
import fs from 'fs';
import path from 'path';
import {
  GENERATED_HEADER,
  generateOntologyModules,
  ONTOLOGY_INDEX,
  SUGGESTED_PREFIX,
  type OntologyIndexEntry,
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

/** One ontology of the package, as its data reads. */
export interface OntologyGeneration {
  config: OntologyConfig;
  /** Its `vann:preferredNamespacePrefix`. */
  suggestedPrefix: string;
  termCount: number;
  /** Subjects under the namespace that are not terms of it (`ontologyTermsFromTurtle`). */
  skipped: string[];
}

/** What `linked generate-ontology` makes of a package, and what the build checks. */
export interface PackageOntologies {
  ontologies: OntologyGeneration[];
  /**
   * Path relative to the package → content: the terms module of each generated ontology and
   * the index (`src/ontologies/index.ts`); empty without `linkedOntologies`.
   */
  files: Record<string, string>;
  /**
   * Existing source files to change → their new content: the package entry, which must import
   * the index, and side-effect imports of a removed register module, which become the index.
   */
  edits: Record<string, string>;
  /**
   * Files the generator wrote before (`<module>.data.ts`, `<module>.register.ts`: they carry its
   * header) that the layout no longer has. Never a file written by hand.
   */
  remove: string[];
}

/** The files a package entry may be, in order. */
const ENTRY_FILES = ['src/index.ts', 'src/index.tsx'];

/**
 * The package's ontology modules as its `linkedOntologies` and data generate them: one terms
 * module per generated ontology, one index registering all of them (those written by hand too),
 * the entry's import of the index, and the stale files of the earlier layout. The vann data of
 * every ontology is checked, including one whose module is written by hand.
 */
export async function generatePackageOntologies(
  packagePath: string,
): Promise<PackageOntologies> {
  const pkgJson = JSON.parse(
    fs.readFileSync(path.join(packagePath, 'package.json'), 'utf8'),
  );
  const ontologies: OntologyGeneration[] = [];
  const specs: OntologyModuleSpec[] = [];
  const handWritten: OntologyIndexEntry[] = [];
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
    const {terms, skipped} = read;
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
    const entry: OntologyIndexEntry = {
      name: config.name,
      module: config.module,
      suggestedPrefix,
      namespace: config.namespace,
      dataFiles: config.data.map((file) => `../data/${file}`),
    };
    if (config.generated) specs.push({...entry, terms});
    else handWritten.push(entry);
    ontologies.push({
      config,
      suggestedPrefix,
      termCount: terms.length,
      skipped,
    });
  }
  if (!ontologies.length) return {ontologies, files: {}, edits: {}, remove: []};
  const files = generateOntologyModules(specs, handWritten);
  // A hand-written module may still carry the header of the module it started as.
  const keep = new Set(
    handWritten.map((entry) => `src/ontologies/${entry.module}.ts`),
  );
  const remove = staleGeneratedFiles(packagePath, files).filter(
    (file) => !keep.has(file),
  );
  return {
    ontologies,
    files,
    edits: sourceEdits(packagePath, pkgJson.name, remove),
    remove,
  };
}

/** Files in `src/ontologies/` the generator wrote (they start with its header) that `files` does not hold. */
function staleGeneratedFiles(
  packagePath: string,
  files: Record<string, string>,
): string[] {
  const dir = path.join(packagePath, 'src', 'ontologies');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /\.tsx?$/.test(f) && !/\.d\.ts$/.test(f))
    .map((f) => `src/ontologies/${f}`)
    .filter(
      (file) =>
        !(file in files) &&
        readIfExists(path.join(packagePath, file))?.startsWith(
          GENERATED_HEADER,
        ),
    )
    .sort();
}

/**
 * The source edits the layout needs: every side-effect import of a removed module
 * (`import './ontologies/x.register.js';`), or of a register module that no longer exists (deleted
 * by hand), becomes an import of the index, or goes when the file
 * imports the index already, and the entry imports the index. Throws when the package has no
 * entry (`src/index.ts[x]`).
 */
function sourceEdits(
  packagePath: string,
  packageName: unknown,
  remove: string[],
): Record<string, string> {
  const indexPath = path.join(packagePath, ONTOLOGY_INDEX.replace(/\.ts$/, ''));
  const removed = new Set(
    remove.map((file) => path.join(packagePath, file.replace(/\.tsx?$/, ''))),
  );
  const edits: Record<string, string> = {};
  const entry = ENTRY_FILES.find((file) =>
    fs.existsSync(path.join(packagePath, file)),
  );
  if (!entry) {
    const pkg = typeof packageName === 'string' ? `${packageName}: ` : '';
    throw new Error(
      `${pkg}no ${ENTRY_FILES.join(' or ')} to import ./ontologies/index.js, which registers the package's ontologies.`,
    );
  }
  for (const file of sourceFiles(packagePath)) {
    const full = path.join(packagePath, file);
    const text = readIfExists(full)!;
    const importsIndex = (line: string) =>
      sideEffectImport(line, full) === indexPath;
    let hasIndex = text.split('\n').some(importsIndex);
    const lines: string[] = [];
    for (const line of text.split('\n')) {
      const target = sideEffectImport(line, full);
      if (
        target === undefined ||
        !(removed.has(target) || isMissingRegisterModule(packagePath, target))
      ) {
        lines.push(line);
        continue;
      }
      if (hasIndex) continue;
      hasIndex = true;
      const spec = /(['"])([^'"]+)\1/.exec(line)![2];
      lines.push(line.replace(spec, spec.replace(/[^/]+$/, 'index.js')));
    }
    if (file === entry && !hasIndex) {
      lines.unshift(`import './ontologies/index.js';`);
    }
    const next = lines.join('\n');
    if (next !== text) edits[file] = next;
  }
  return edits;
}

/**
 * Whether `target` (an import's path without extension) is a `<name>.register` module in the
 * package's `src/ontologies/` with no source file: a register module deleted by hand, which the
 * index replaces like one the generator removes.
 */
function isMissingRegisterModule(packagePath: string, target: string): boolean {
  return (
    path.dirname(target) === path.join(packagePath, 'src', 'ontologies') &&
    target.endsWith('.register') &&
    !['.ts', '.tsx', '.js'].some((ext) => fs.existsSync(target + ext))
  );
}

/** The package's TypeScript sources, outside `src/ontologies/`, relative to the package. */
function sourceFiles(packagePath: string): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const entry of fs.readdirSync(path.join(packagePath, rel), {
      withFileTypes: true,
    })) {
      const child = `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && child !== 'src/ontologies')
          walk(child);
      } else if (/\.tsx?$/.test(entry.name) && !/\.d\.ts$/.test(entry.name)) {
        out.push(child);
      }
    }
  };
  if (fs.existsSync(path.join(packagePath, 'src'))) walk('src');
  return out.sort();
}

/**
 * The absolute path, without extension, a relative side-effect import line
 * (`import './x.js';`) of `file` loads; undefined for any other line.
 */
function sideEffectImport(line: string, file: string): string | undefined {
  const match = /^\s*import\s+(['"])(\.{1,2}\/[^'"]*)\1\s*;?\s*$/.exec(line);
  if (!match) return undefined;
  return path
    .resolve(path.dirname(file), match[2])
    .replace(/\.(?:js|ts|tsx)$/, '');
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

/**
 * Writes the package's ontology modules and source edits and removes the stale generated files;
 * returns the paths changed, removed ones included.
 */
export async function writePackageOntologies(
  packagePath: string,
  generated?: PackageOntologies,
): Promise<string[]> {
  const {files, edits, remove} =
    generated ?? (await generatePackageOntologies(packagePath));
  const changed: string[] = [];
  for (const [file, content] of Object.entries({...files, ...edits})) {
    const full = path.join(packagePath, file);
    if (readIfExists(full) === content) continue;
    fs.mkdirSync(path.dirname(full), {recursive: true});
    fs.writeFileSync(full, content);
    changed.push(file);
  }
  for (const file of remove) {
    fs.rmSync(path.join(packagePath, file));
    changed.push(file);
  }
  return changed.sort();
}

/**
 * What differs from what the data generates: modules missing or changed, source files to edit
 * (the entry's import of the index, imports of removed modules) and stale generated files.
 */
export async function staleOntologyModules(
  packagePath: string,
  generated?: PackageOntologies,
): Promise<string[]> {
  const {files, edits, remove} =
    generated ?? (await generatePackageOntologies(packagePath));
  const stale = Object.entries(files)
    .filter(
      ([file, content]) =>
        readIfExists(path.join(packagePath, file)) !== content,
    )
    .map(([file]) => file);
  return [...stale, ...Object.keys(edits), ...remove].sort();
}

/**
 * The build step: an error naming what is stale, else success. A package without
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
      `If an ontology's module is written by hand, declare it with "generated": false in "${ONTOLOGIES_KEY}".`,
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
