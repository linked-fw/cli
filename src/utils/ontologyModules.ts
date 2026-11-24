/**
 * The ontology modules of a package, as text: the one generator `linked generate-ontology` and a
 * host app's ontology builder share.
 *
 * A package gets, in `src/ontologies/`:
 *
 * - `<module>.ts` per ontology (the module defaults to the ontology's name within its package),
 *   the **terms module**: one `export const Term = {id: '<namespace>Term'}` per term, sorted, each
 *   with a one-line JSDoc from its `rdfs:comment` (else `rdfs:label`), and nothing else. It
 *   imports nothing, so `import * as n from '<pkg>/ontologies/<module>'` is a namespace of terms
 *   only and tree-shakes. A namespace function, where code needs one, is core's
 *   `createNameSpace(namespace)`;
 * - `index.ts`, the **index**: imports every ontology module of the package (generated or
 *   written by hand) and registers them all with one `registerOntologies([...], import.meta.url)`
 *   call, each with its name, namespace, terms, data files (relative to the index) and suggested
 *   prefix (its data's `vann:preferredNamespacePrefix`). The package's entry imports it.
 *
 * A term's export name is its local name made a valid identifier by one fixed rule
 * ({@link ontologyIdentifier}). Two terms that the rule gives the same name are refused
 * ({@link OntologyNameCollisionError}); nothing is renamed to resolve them.
 *
 * This module is pure (no Node, no parser), so a browser bundle can import it. Reading terms from
 * Turtle is `ontologyTerms.ts`; reading a package's configuration and files is
 * `generateOntology.ts`.
 *
 * Output is deterministic: the same input gives the same bytes.
 */

/** One term of an ontology: a subject in its namespace. */
export interface OntologyTerm {
  /** The IRI minus the namespace (`Person` for `http://schema.org/Person`). Never empty. */
  localName: string;
  /** `rdfs:label`, when the term has one. */
  label?: string;
  /** `rdfs:comment`, when the term has one. */
  comment?: string;
}

/** What one ontology's terms module, and its entry in the index, are generated from. */
export interface OntologyModuleSpec {
  /** The ontology's name within its package: the name the index registers it under. */
  name: string;
  /**
   * The module's file name without extension (`src/ontologies/<module>.ts`, so the public import
   * path is `<package>/ontologies/<module>`). Defaults to the name.
   */
  module?: string;
  /**
   * The ontology's suggested prefix, registered with it: its `vann:preferredNamespacePrefix`
   * ({@link ontologySuggestedPrefix} in `ontologyTerms.ts` reads it).
   */
  suggestedPrefix: string;
  /** The term namespace (`http://schema.org/`). */
  namespace: string;
  /** The data files, relative to `src/ontologies/` (`../data/schema.ttl`). */
  dataFiles: string[];
  /** The terms, in any order. */
  terms: OntologyTerm[];
}

/** An ontology's name within its package: lowercase letters and digits, single `-`/`_` between. */
export const ONTOLOGY_NAME = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;

/** A suggested prefix: a Turtle prefix name (ASCII), as `@prefix` takes it. */
export const SUGGESTED_PREFIX = /^[A-Za-z](?:[A-Za-z0-9_.-]*[A-Za-z0-9_-])?$/;

/**
 * Reserved words and the names a module (always strict mode) cannot bind: ECMAScript keywords,
 * future reserved words, the literals `null`/`true`/`false`, and `eval`/`arguments`.
 */
export const RESERVED_IDENTIFIERS: ReadonlySet<string> = new Set([
  'arguments',
  'await',
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'debugger',
  'default',
  'delete',
  'do',
  'else',
  'enum',
  'eval',
  'export',
  'extends',
  'false',
  'finally',
  'for',
  'function',
  'if',
  'implements',
  'import',
  'in',
  'instanceof',
  'interface',
  'let',
  'new',
  'null',
  'package',
  'private',
  'protected',
  'public',
  'return',
  'static',
  'super',
  'switch',
  'this',
  'throw',
  'true',
  'try',
  'typeof',
  'var',
  'void',
  'while',
  'with',
  'yield',
  // Bound at module scope by a CommonJS build (`linked build` compiles one for a package that
  // publishes CJS), where tsc refuses them or the emitted module throws.
  '__esModule',
  'exports',
  'module',
  'require',
]);

const ID_START = /[\p{ID_Start}$_]/u;
const ID_CONTINUE = /[\p{ID_Continue}$\u200C\u200D]/u;
const DIGIT = /[0-9]/;

/**
 * The export name of a term: its local name, made a valid identifier by one fixed rule, applied
 * per character and then to the whole name:
 *
 * 1. a character that cannot appear in an identifier becomes `_` (`foo-bar` → `foo_bar`);
 * 2. a leading digit gets a leading `_` (`3DModel` → `_3DModel`);
 * 3. a reserved word gets a trailing `_` (`default` → `default_`).
 *
 * There is no alias map and there are no exceptions. "Can appear in an identifier" is Unicode's
 * `ID_Start`/`ID_Continue` as the running Node's ICU knows them, so a character added in a newer
 * Unicode version could differ between Node versions; no vocabulary in use has one.
 */
export function ontologyIdentifier(localName: string): string {
  const chars = Array.from(localName);
  let name = chars
    .map((ch, i) => {
      if (i === 0) return ID_START.test(ch) || DIGIT.test(ch) ? ch : '_';
      return ID_CONTINUE.test(ch) ? ch : '_';
    })
    .join('');
  if (DIGIT.test(name.charAt(0))) name = '_' + name;
  if (RESERVED_IDENTIFIERS.has(name)) name += '_';
  return name;
}

/** Terms the identifier rule gives one name: `{name, localNames}` per clash, sorted. */
export interface OntologyNameCollision {
  name: string;
  localNames: string[];
}

/** Every export name that more than one of `localNames` maps to. */
export function findOntologyNameCollisions(
  localNames: string[],
): OntologyNameCollision[] {
  const byName = new Map<string, Set<string>>();
  for (const localName of localNames) {
    const name = ontologyIdentifier(localName);
    if (!byName.has(name)) byName.set(name, new Set());
    byName.get(name)!.add(localName);
  }
  return [...byName.entries()]
    .filter(([, set]) => set.size > 1)
    .map(([name, set]) => ({name, localNames: [...set].sort(compare)}))
    .sort((a, b) => compare(a.name, b.name));
}

/** Two or more terms of one ontology would get the same export name. */
export class OntologyNameCollisionError extends Error {
  constructor(
    readonly ontologyName: string,
    readonly collisions: OntologyNameCollision[],
  ) {
    super(
      `The ontology '${ontologyName}' has terms that get the same export name: ` +
        collisions
          .map((c) => `${c.name} (${c.localNames.join(', ')})`)
          .join('; ') +
        '. Rename one of each in the data.',
    );
    this.name = 'OntologyNameCollisionError';
  }
}

/** Code-unit order: locale-independent, so the output does not depend on the machine. */
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** A single-quoted string literal. */
const quote = (value: string): string =>
  `'${value
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
    .replace(/\p{Cs}/gu, '\uFFFD')}'`;

const DOC_MAX = 160;

/**
 * A term's comment or label as one JSDoc line: markup dropped (HTML tags, `[[Term]]` and Markdown
 * links keep their text), whitespace collapsed, cut after the first sentence and at
 * {@link DOC_MAX} characters on a word boundary, and made safe inside `/** … *\/`. Undefined when
 * there is no text, or it only repeats the local name.
 */
export function ontologyTermDoc(term: OntologyTerm): string | undefined {
  const raw = term.comment ?? term.label;
  if (!raw) return undefined;
  let text = raw
    // A Turtle that escapes its newlines twice (schema.org's) gives a literal `\n`.
    .replace(/\\[nrt]/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\[\[([^\]]*)\]\]/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/ ([,.;:!?])/g, '$1')
    .trim();
  const sentence = /^(.+?(?<!\b(?:e\.g|i\.e|etc|vs|cf))[.!?])\s/.exec(
    text + ' ',
  );
  if (sentence) text = sentence[1];
  // Lone surrogates would be written as U+FFFD and never compare equal again.
  text = text.replace(/\p{Cs}/gu, '\uFFFD');
  if (Array.from(text).length > DOC_MAX) {
    // By code point, so a cut never splits a surrogate pair.
    const cut = Array.from(text).slice(0, DOC_MAX).join('');
    const space = cut.lastIndexOf(' ');
    text =
      (space > DOC_MAX / 2 ? cut.slice(0, space) : cut).replace(
        /[\s,;:]+$/,
        '',
      ) + '…';
  }
  // `*/` would end the comment; a leading `@` would read as a tag.
  text = text.replace(/\*\//g, '*\\/').replace(/^@/, '\\@');
  if (!text || text === term.localName) return undefined;
  return text;
}

/** The first line of every file the generator writes; only a file starting with it is ever removed. */
export const GENERATED_HEADER = '// Generated by `linked generate-ontology`.';

const GENERATED = (dataFiles: string[]) =>
  `${GENERATED_HEADER} Do not edit: change the data and run it again.\n` +
  `// Data: ${dataFiles
    .map(sourceOfDataFile)
    .join(', ')
    .replace(/\s+/g, ' ')
    .replace(/\p{Cs}/gu, '\uFFFD')}`;

/** The modules' file name: the spec's `module`, else its name; checked like a name. */
function moduleOf(spec: Pick<OntologyModuleSpec, 'name' | 'module'>): string {
  checkName(spec.name);
  const module = spec.module ?? spec.name;
  checkName(module);
  return module;
}

/** Validates a name, so a file name is never derived from something unsafe. */
function checkName(name: string): void {
  if (!ONTOLOGY_NAME.test(name)) {
    throw new Error(
      `${JSON.stringify(name)} cannot name an ontology module: use lowercase letters and digits, with single hyphens or underscores between them.`,
    );
  }
}

/** The terms sorted by export name, with each export name; refuses collisions. */
function namedTerms(
  spec: Pick<OntologyModuleSpec, 'name' | 'terms'>,
): {name: string; term: OntologyTerm}[] {
  const unique = new Map<string, OntologyTerm>();
  // Sorted first, so which of two entries for one term wins does not depend on input order.
  const sorted = [...spec.terms].sort(
    (a, b) =>
      compare(a.localName, b.localName) ||
      compare(a.label ?? '', b.label ?? '') ||
      compare(a.comment ?? '', b.comment ?? ''),
  );
  for (const term of sorted) {
    if (!term.localName) continue;
    // A term listed twice is one term; the first label/comment (in that order) wins.
    const known = unique.get(term.localName);
    unique.set(term.localName, {
      localName: term.localName,
      label: known?.label ?? term.label,
      comment: known?.comment ?? term.comment,
    });
  }
  const collisions = findOntologyNameCollisions([...unique.keys()]);
  if (collisions.length)
    throw new OntologyNameCollisionError(spec.name, collisions);
  return [...unique.values()]
    .map((term) => ({name: ontologyIdentifier(term.localName), term}))
    .sort((a, b) => compare(a.name, b.name));
}

/**
 * `src/ontologies/<module>.ts`: the terms and nothing else, each the `{id}` reference
 * `createNameSpace(namespace)(localName)` returns, written as a literal. It imports nothing.
 */
export function generateOntologyTermsModule(
  spec: Pick<
    OntologyModuleSpec,
    'name' | 'module' | 'namespace' | 'dataFiles' | 'terms'
  >,
): string {
  moduleOf(spec);
  const terms = namedTerms(spec);
  const lines = [GENERATED(spec.dataFiles)];
  for (const {name, term} of terms) {
    lines.push('');
    const doc = ontologyTermDoc(term);
    if (doc) lines.push(`/** ${doc} */`);
    lines.push(
      `export const ${name} = {id: ${quote(spec.namespace + term.localName)}};`,
    );
  }
  // Without terms the file must still be a module, or `import * as terms` from the index fails
  // to compile (TS2306).
  if (!terms.length) lines.push('', 'export {};');
  return lines.join('\n') + '\n';
}

/** `../data/schema.ttl` → `src/data/schema.ttl`, as the header names it. */
function sourceOfDataFile(file: string): string {
  return file.startsWith('../') ? `src/${file.slice(3)}` : file;
}

/**
 * One ontology as the package's index registers it. A generated ontology's terms module is
 * written from its spec; one written by hand (`generated: false`) is only imported.
 */
export interface OntologyIndexEntry {
  /** The ontology's name within its package. */
  name: string;
  /** Its module's file name in `src/ontologies/`, without extension. Defaults to the name. */
  module?: string;
  namespace: string;
  /** Its `vann:preferredNamespacePrefix`. */
  suggestedPrefix: string;
  /** The data files, relative to `src/ontologies/` (`../data/schema.ttl`). */
  dataFiles: string[];
}

/** The index's own bindings, which no module import may take. */
const INDEX_LOCALS = new Set(['registerOntologies']);

/**
 * `src/ontologies/index.ts`: imports every ontology module of the package and registers them all
 * with one `registerOntologies` call (sorted by name). The package's entry imports it.
 */
export function generateOntologyIndexModule(
  entries: OntologyIndexEntry[],
): string {
  const sorted = [...entries].sort((a, b) => compare(a.name, b.name));
  const taken = new Set(INDEX_LOCALS);
  const imports: string[] = [];
  const registrations: string[] = [];
  for (const entry of sorted) {
    const module = moduleOf(entry);
    if (!SUGGESTED_PREFIX.test(entry.suggestedPrefix)) {
      throw new Error(
        `${JSON.stringify(entry.suggestedPrefix)} is not a prefix: start with a letter, then letters, digits, -, _ or . (not last).`,
      );
    }
    let local = ontologyIdentifier(module);
    while (taken.has(local)) local += '_';
    taken.add(local);
    imports.push(`import * as ${local} from './${module}.js';`);
    registrations.push(
      [
        '  {',
        `    name: ${quote(entry.name)},`,
        `    namespace: ${quote(entry.namespace)},`,
        `    terms: ${local},`,
        `    data: [${entry.dataFiles.map(quote).join(', ')}],`,
        `    suggestedPrefix: ${quote(entry.suggestedPrefix)},`,
        '  },',
      ].join('\n'),
    );
  }
  return [
    `${GENERATED_HEADER} Do not edit: change package.json "linkedOntologies" or the data and run it again.`,
    '// Registers every ontology of this package. The package entry imports this module.',
    `import {registerOntologies} from '../package.js';`,
    ...imports,
    '',
    '// Data files are relative to this module (Turtle, copied into `lib/` by the build).',
    'registerOntologies(',
    '  [',
    ...registrations.map((r) => r.replace(/^/gm, '  ')),
    '  ],',
    '  import.meta.url,',
    ');',
    '',
  ].join('\n');
}

/** The path of a package's ontology index, relative to the package. */
export const ONTOLOGY_INDEX = 'src/ontologies/index.ts';

/**
 * Every ontology module of a package, keyed by its path relative to the package: the terms
 * module of each spec (`src/ontologies/<module>.ts`) and the package's index
 * (`src/ontologies/index.ts`), which registers these and every `handWritten` ontology.
 */
export function generateOntologyModules(
  specs: OntologyModuleSpec | OntologyModuleSpec[],
  handWritten: OntologyIndexEntry[] = [],
): Record<string, string> {
  const list = Array.isArray(specs) ? specs : [specs];
  const files: Record<string, string> = {};
  for (const spec of list) {
    files[`src/ontologies/${moduleOf(spec)}.ts`] =
      generateOntologyTermsModule(spec);
  }
  const entries = [...list, ...handWritten];
  const modules = new Set<string>();
  for (const entry of entries) {
    const module = moduleOf(entry);
    if (module === 'index' || modules.has(module)) {
      throw new Error(
        `Two ontologies, or an ontology and the index, use the module src/ontologies/${module}.ts; give one its own "module".`,
      );
    }
    modules.add(module);
  }
  files[ONTOLOGY_INDEX] = generateOntologyIndexModule(entries);
  return files;
}
