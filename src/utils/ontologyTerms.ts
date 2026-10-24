/**
 * The terms of an ontology, read from its Turtle: every named subject in the namespace, with its
 * `rdfs:label` and `rdfs:comment`.
 *
 * Kept apart from `ontologyModules.ts` (which is pure and safe in a browser bundle) because it
 * parses with `n3`. `n3` is loaded by a variable specifier, so bundling the generator does not
 * pull it in and its typings are not needed to compile the cli.
 */
import type {OntologyTerm} from './ontologyModules.js';

const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';
const LABEL = `${RDFS}label`;
const COMMENT = `${RDFS}comment`;

/** The part of `n3` this module uses. */
interface N3Term {
  termType: string;
  value: string;
  language?: string;
}
interface N3Module {
  Parser: new (options?: {baseIRI?: string; format?: string}) => {
    parse(
      input: string,
    ): {subject: N3Term; predicate: N3Term; object: N3Term}[];
  };
}

let n3: Promise<N3Module> | undefined;
const loadN3 = (): Promise<N3Module> => {
  const specifier = 'n3';
  return (n3 ??= import(
    /* @vite-ignore */ /* webpackIgnore: true */ specifier
  ) as Promise<N3Module>);
};

/** One Turtle document and the name it is reported under. */
export interface TurtleSource {
  /** Names the document in errors (`src/data/schema.ttl`). */
  name: string;
  text: string;
}

/** A quad as n3 (or any RDF/JS parser) gives it; only these fields are read. */
export interface OntologyQuad {
  subject: N3Term;
  predicate: N3Term;
  object: N3Term;
}

export interface OntologyTermsResult {
  /** The terms, sorted by local name. */
  terms: OntologyTerm[];
  /**
   * Subjects that start with the namespace but are not a term of it: the remainder contains
   * `/`, `#` or `?` (a deeper path, not a local name). Sorted.
   */
  skipped: string[];
}

/**
 * The terms in `namespace` among the subjects of `quads`. Pure: a browser that parses Turtle
 * itself gets the same selection `linked build` checks against.
 *
 * A subject is a term when its IRI is the namespace followed by a non-empty local name without
 * `/`, `#` or `?`; the namespace IRI itself (the ontology) and blank nodes are not terms. Of
 * several labels or comments, the English one wins, then one without a language, then by
 * language tag and value, so the result does not depend on statement order.
 */
export function ontologyTermsFromQuads(
  quads: Iterable<OntologyQuad>,
  namespace: string,
): OntologyTermsResult {
  type Literal = {value: string; language: string};
  const subjects = new Map<string, {labels: Literal[]; comments: Literal[]}>();
  const skipped = new Set<string>();
  for (const {subject, predicate, object} of quads) {
    if (
      subject.termType !== 'NamedNode' ||
      !subject.value.startsWith(namespace)
    ) {
      continue;
    }
    const localName = subject.value.slice(namespace.length);
    if (!localName) continue;
    if (/[/#?]/.test(localName)) {
      skipped.add(subject.value);
      continue;
    }
    let entry = subjects.get(localName);
    if (!entry) subjects.set(localName, (entry = {labels: [], comments: []}));
    if (object.termType !== 'Literal') continue;
    const literal = {value: object.value, language: object.language ?? ''};
    if (predicate.value === LABEL) entry.labels.push(literal);
    else if (predicate.value === COMMENT) entry.comments.push(literal);
  }
  const terms = [...subjects.entries()]
    .sort(([a], [b]) => compare(a, b))
    .map(([localName, {labels, comments}]) => {
      const term: OntologyTerm = {localName};
      const label = pick(labels);
      const comment = pick(comments);
      if (label !== undefined) term.label = label;
      if (comment !== undefined) term.comment = comment;
      return term;
    });
  return {terms, skipped: [...skipped].sort(compare)};
}

/**
 * {@link ontologyTermsFromQuads} over parsed Turtle. `n3` is loaded on first use; a browser
 * bundle passes its own statically imported `Parser` (`{Parser}` from `n3`) instead, since a
 * bare dynamic import does not resolve there.
 */
export async function ontologyTermsFromTurtle(
  sources: TurtleSource[],
  namespace: string,
  options: {Parser?: N3Module['Parser']} = {},
): Promise<OntologyTermsResult> {
  const Parser = options.Parser ?? (await loadN3()).Parser;
  const quads: OntologyQuad[] = [];
  for (const source of sources) {
    try {
      // A loop, not `push(...)`: schema.org has more quads than a call takes arguments.
      for (const quad of new Parser({format: 'text/turtle'}).parse(source.text))
        quads.push(quad);
    } catch (error) {
      throw new Error(
        `Could not parse ${source.name}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return ontologyTermsFromQuads(quads, namespace);
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const rank = (language: string): number =>
  language.toLowerCase() === 'en'
    ? 0
    : language.toLowerCase().startsWith('en-')
      ? 1
      : language
        ? 3
        : 2;

/** The literal a doc line uses: English first, then no language, then any; ties by value. */
function pick(
  literals: {value: string; language: string}[],
): string | undefined {
  if (!literals.length) return undefined;
  return [...literals].sort(
    (a, b) =>
      rank(a.language) - rank(b.language) ||
      compare(a.language, b.language) ||
      compare(a.value, b.value),
  )[0].value;
}
