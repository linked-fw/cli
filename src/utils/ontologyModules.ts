/**
 * The accessor modules of an ontology, as text: the one generator `linked generate-ontology` and
 * create-now's ontology builder share.
 *
 * An ontology with prefix `<p>` gets three sibling modules in `src/ontologies/`:
 *
 * - `<p>.ts`, the **terms module**: one `export const Term = ns('Term')` per term, sorted, each
 *   with a one-line JSDoc from its `rdfs:comment` (else `rdfs:label`), and nothing else, so
 *   `import * as p from '<pkg>/ontologies/<p>'` is a namespace of terms only and tree-shakes
 *   (every initializer is annotated pure);
 * - `<p>.data.ts`, the **data module**: `ns`, `dataFiles`, `loadData`, `_ontologyResource` (the
 *   ontology's IRI as its `owl:Ontology` declares it, else the namespace) and the
 *   `Prefix.add` registration of the prefix;
 * - `<p>.register.ts`, the **register module**: the `linkedOntology` call, which needs the terms
 *   module's whole namespace and so cannot live in it (see the comment it carries).
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

/** What the three modules of one ontology are generated from. */
export interface OntologyModuleSpec {
  /** The registered prefix, which is also the modules' file name (`src/ontologies/<prefix>.ts`). */
  prefix: string;
  /** The term namespace (`http://schema.org/`). */
  namespace: string;
  /** The data files `loadData` reads, relative to `src/ontologies/` (`../data/schema.ttl`). */
  dataFiles: string[];
  /** The terms, in any order. */
  terms: OntologyTerm[];
  /**
   * The ontology's own IRI, as its data declares it with `a owl:Ontology`
   * (`ontologyTermsFromQuads` finds it). Defaults to the namespace.
   */
  ontology?: string;
}

/** A prefix that names an ontology's modules: letters and digits, single `-`/`_` between. */
export const ONTOLOGY_PREFIX = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/i;

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
  // The keys core's `linkedOntology` adds to the registered terms, which would overwrite a term.
  '_data',
  '_load',
  '_ns',
  '_prefix',
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
    readonly prefix: string,
    readonly collisions: OntologyNameCollision[],
  ) {
    super(
      `The ontology '${prefix}' has terms that get the same export name: ` +
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

const GENERATED = (dataFiles: string[]) =>
  `// Generated by \`linked generate-ontology\`. Do not edit: change the data and run it again.\n` +
  `// Data: ${dataFiles
    .map(sourceOfDataFile)
    .join(', ')
    .replace(/\s+/g, ' ')
    .replace(/\p{Cs}/gu, '\uFFFD')}`;

/** Validates a spec's prefix, so a file name is never derived from something unsafe. */
function checkPrefix(prefix: string): void {
  if (!ONTOLOGY_PREFIX.test(prefix)) {
    throw new Error(
      `${JSON.stringify(prefix)} cannot name an ontology module: use letters and digits, with single hyphens or underscores between them.`,
    );
  }
}

/** The terms sorted by export name, with each export name; refuses collisions. */
function namedTerms(
  spec: OntologyModuleSpec,
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
    throw new OntologyNameCollisionError(spec.prefix, collisions);
  return [...unique.values()]
    .map((term) => ({name: ontologyIdentifier(term.localName), term}))
    .sort((a, b) => compare(a.name, b.name));
}

/** `src/ontologies/<prefix>.ts`: the terms, and nothing else. */
export function generateOntologyTermsModule(spec: OntologyModuleSpec): string {
  checkPrefix(spec.prefix);
  const terms = namedTerms(spec);
  // The namespace function's local binding must not be a term's name.
  const names = new Set(terms.map((t) => t.name));
  let nsLocal = 'ns';
  while (names.has(nsLocal)) nsLocal += '_';
  const importNs = nsLocal === 'ns' ? 'ns' : `ns as ${nsLocal}`;
  const lines = [
    GENERATED(spec.dataFiles),
    // No import without terms: an unused one fails under `noUnusedLocals`.
    ...(terms.length
      ? [`import {${importNs}} from './${spec.prefix}.data.js';`]
      : []),
  ];
  for (const {name, term} of terms) {
    lines.push('');
    const doc = ontologyTermDoc(term);
    if (doc) lines.push(`/** ${doc} */`);
    lines.push(
      `export const ${name} = /*#__PURE__*/ ${nsLocal}(${quote(term.localName)});`,
    );
  }
  // Without terms the file must still be a module, or `import * as terms` from the register
  // module fails to compile (TS2306).
  if (!terms.length) lines.push('', 'export {};');
  return lines.join('\n') + '\n';
}

/** `../data/schema.ttl` → `src/data/schema.ttl`, as the header names it. */
function sourceOfDataFile(file: string): string {
  return file.startsWith('../') ? `src/${file.slice(3)}` : file;
}

/** `src/ontologies/<prefix>.data.ts`: the namespace, the data files and the prefix. */
export function generateOntologyDataModule(
  spec: Omit<OntologyModuleSpec, 'terms'>,
): string {
  checkPrefix(spec.prefix);
  return [
    GENERATED(spec.dataFiles),
    `import {Prefix} from '@_linked/core/utils/Prefix';`,
    `import {createNameSpace} from '@_linked/core/utils/NameSpace';`,
    `import {loadOntologyFiles} from '@_linked/core/ontology/loadOntologyFiles';`,
    '',
    '/** The ontology data, relative to this module (Turtle, copied into `lib/` by the build). */',
    `export const dataFiles = [${spec.dataFiles.map(quote).join(', ')}];`,
    '',
    '/** Reads the ontology data (server only). */',
    'export const loadData = () => loadOntologyFiles(import.meta.url, dataFiles);',
    '',
    "/** The namespace: `ns('Term')` is the `{id}` reference of any term, listed or not. */",
    `export const ns = createNameSpace(${quote(spec.namespace)});`,
    `Prefix.add(${quote(spec.prefix)}, ${quote(spec.namespace)});`,
    '',
    ...(spec.ontology === undefined || spec.ontology === spec.namespace
      ? [
          '/** The ontology itself (its namespace IRI). */',
          "export const _ontologyResource = ns('');",
        ]
      : [
          '/** The ontology itself, as its data declares it (`a owl:Ontology`). */',
          `export const _ontologyResource = {id: ${quote(spec.ontology)}};`,
        ]),
    '',
  ].join('\n');
}

/** `src/ontologies/<prefix>.register.ts`: the `linkedOntology` registration. */
export function generateOntologyRegisterModule(
  spec: Pick<OntologyModuleSpec, 'prefix'>,
): string {
  checkPrefix(spec.prefix);
  const p = spec.prefix;
  return [
    `// Generated by \`linked generate-ontology\`. Do not edit.`,
    '/**',
    ' * Registers this ontology.',
    ' *',
    ` * Kept out of \`${p}.ts\` because registration needs that module's whole export namespace, and`,
    ' * a module cannot import itself once a bundler is involved: Rollup treats a static',
    ' * self-reference as a circular import and elides it, so the binding is undefined at runtime',
    ' * and the app dies at boot with `_this is not defined`. From a sibling module the same import',
    ' * is ordinary and survives.',
    ' */',
    `import * as terms from './${p}.js';`,
    `import {dataFiles, loadData, ns} from './${p}.data.js';`,
    `import {linkedOntology} from '../package.js';`,
    '',
    `linkedOntology(terms, ns, ${quote(p)}, loadData, dataFiles);`,
    '',
  ].join('\n');
}

/**
 * The three modules of one ontology, keyed by their path relative to the package
 * (`src/ontologies/<prefix>.ts`, `.data.ts`, `.register.ts`).
 */
export function generateOntologyModules(
  spec: OntologyModuleSpec,
): Record<string, string> {
  const dir = 'src/ontologies';
  return {
    [`${dir}/${spec.prefix}.ts`]: generateOntologyTermsModule(spec),
    [`${dir}/${spec.prefix}.data.ts`]: generateOntologyDataModule(spec),
    [`${dir}/${spec.prefix}.register.ts`]: generateOntologyRegisterModule(spec),
  };
}
