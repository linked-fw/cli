/**
 * The data file of a new ontology package's one ontology (`src/data/<name>.ttl`): the
 * ontology node with the metadata every ontology carries, and no terms yet.
 *
 *   <namespace> a owl:Ontology ;
 *       dcterms:creator <creator> ;            (when given)
 *       dcterms:description "…"@en ;           (when given)
 *       dcterms:title "…"@en ;
 *       vann:preferredNamespacePrefix "prefix" ;
 *       vann:preferredNamespaceUri "namespace" ;
 *       schema:maintainer <maintainer> ;       (when given; the creator by default)
 *       adms:status <status> .                 (a core:OntologyStatus, core:Draft by default)
 *
 * The layout is deterministic, so a host that rewrites the file through its own Turtle writer
 * changes nothing on the first save: the file's own prefix first, then a fixed list of the
 * prefixes an ontology's terms usually need; one subject, `rdf:type` first and the other
 * predicates by IRI; a full IRI where no declared prefix covers it.
 */
import {coreOntology} from '@_linked/core/ontologies/linked-core';

/** The statuses a new ontology can have: `core:OntologyStatus`'s instances. */
export const ONTOLOGY_STATUSES = [
  'Draft',
  'ReadyForReview',
  'Published',
] as const;
export type OntologyStatus = (typeof ONTOLOGY_STATUSES)[number];

export function isOntologyStatus(value: string): value is OntologyStatus {
  return (ONTOLOGY_STATUSES as readonly string[]).includes(value);
}

/** The metadata a new ontology's data file states. Every field has a default. */
export interface OntologyScaffoldFields {
  /** `dcterms:title`, in English. Default: the ontology name in words (`lego-planning` → `Lego Planning`). */
  title?: string;
  /** `dcterms:description`, in English. Default: none. */
  description?: string;
  /**
   * `vann:preferredNamespacePrefix`, the file's own Turtle prefix, and the `suggestedPrefix` the
   * generated modules register. Default: the ontology name.
   */
  prefix?: string;
  /** `dcterms:creator`: a person's IRI, such as a WebID. Default: none. */
  creator?: string;
  /** `schema:maintainer`: a person's IRI. Default: the creator. */
  maintainer?: string;
  /** `adms:status`. Default: `Draft`. */
  status?: OntologyStatus;
}

const OWL_ONTOLOGY = 'http://www.w3.org/2002/07/owl#Ontology';
const DCTERMS = 'http://purl.org/dc/terms/';
const VANN = 'http://purl.org/vocab/vann/';
const SCHEMA_MAINTAINER = 'http://schema.org/maintainer';
const ADMS_STATUS = 'http://www.w3.org/ns/adms#status';

/** The prefixes the file declares after its own, in this order. */
const FIXED_PREFIXES: ReadonlyArray<readonly [string, string]> = [
  ['rdf', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'],
  ['rdfs', 'http://www.w3.org/2000/01/rdf-schema#'],
  ['owl', 'http://www.w3.org/2002/07/owl#'],
  ['xsd', 'http://www.w3.org/2001/XMLSchema#'],
  ['dcterms', DCTERMS],
  ['skos', 'http://www.w3.org/2004/02/skos/core#'],
  ['schema', 'http://schema.org/'],
  ['vann', VANN],
];

/** A Turtle prefix name the file can declare (and a `suggestedPrefix`). */
export const ONTOLOGY_PREFIX = /^[A-Za-z][A-Za-z0-9_-]*$/;
/** A local name written after a prefix. */
const LOCAL = /^[A-Za-z0-9_][A-Za-z0-9_-]*$/;
/** An absolute IRI with nothing an IRI never holds (RFC 3987). */
const ABSOLUTE_IRI = /^[A-Za-z][A-Za-z0-9+.-]*:[^\x00-\x20<>"{}|^`\\]+$/;

/** `lego-planning` → `Lego Planning`. */
export function ontologyTitleFor(name: string): string {
  return name
    .split(/[-_]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * The fields with their defaults filled in. Throws on a prefix that is not a Turtle prefix
 * name, a creator or maintainer that is not an absolute IRI, or an unknown status.
 */
export function resolveOntologyFields(
  name: string,
  fields: OntologyScaffoldFields = {},
): Required<Pick<OntologyScaffoldFields, 'title' | 'prefix' | 'status'>> &
  Pick<OntologyScaffoldFields, 'description' | 'creator' | 'maintainer'> {
  const title = fields.title?.trim() || ontologyTitleFor(name);
  const description = fields.description?.trim() || undefined;
  const prefix = fields.prefix || name;
  if (!ONTOLOGY_PREFIX.test(prefix)) {
    throw new Error(
      `${JSON.stringify(prefix)} is not a prefix: start with a letter, then letters, digits, hyphens or underscores.`,
    );
  }
  const creator = fields.creator || undefined;
  const maintainer = fields.maintainer || creator;
  for (const [role, iri] of [
    ['creator', creator],
    ['maintainer', maintainer],
  ] as const) {
    if (iri !== undefined && !ABSOLUTE_IRI.test(iri)) {
      throw new Error(
        `The ${role} ${JSON.stringify(iri)} is not an IRI: give a person's IRI, such as https://example.org/profile/card#me.`,
      );
    }
  }
  const status = fields.status ?? 'Draft';
  if (!isOntologyStatus(status)) {
    throw new Error(
      `${JSON.stringify(status)} is not an ontology status: use one of ${ONTOLOGY_STATUSES.join(', ')}.`,
    );
  }
  return {title, description, prefix, creator, maintainer, status};
}

/** A Turtle string literal. */
function quoted(value: string): string {
  const escapes: Record<string, string> = {
    '\\': '\\\\',
    '"': '\\"',
    '\n': '\\n',
    '\r': '\\r',
    '\t': '\\t',
    '\b': '\\b',
    '\f': '\\f',
  };
  return `"${value.replace(/[\\"\n\r\t\b\f]/g, (c) => escapes[c])}"`;
}

/**
 * The Turtle of the ontology `name` in `namespace`, with `fields` (defaults filled in by
 * {@link resolveOntologyFields}).
 */
export function ontologyScaffoldTurtle(
  name: string,
  namespace: string,
  fields: OntologyScaffoldFields = {},
): string {
  const {title, description, prefix, creator, maintainer, status} =
    resolveOntologyFields(name, fields);
  const prefixes: Array<readonly [string, string]> = [
    [prefix, namespace],
    ...FIXED_PREFIXES.filter(([p, ns]) => p !== prefix && ns !== namespace),
  ];
  const iri = (value: string): string => {
    for (const [p, ns] of prefixes) {
      if (value.startsWith(ns)) {
        const local = value.slice(ns.length);
        if (local === '' || LOCAL.test(local)) return `${p}:${local}`;
      }
    }
    return `<${value}>`;
  };
  const english = (value: string) => `${quoted(value)}@en`;

  const statements: Array<[string, string]> = [
    [DCTERMS + 'title', english(title)],
    [VANN + 'preferredNamespacePrefix', quoted(prefix)],
    [VANN + 'preferredNamespaceUri', quoted(namespace)],
    [ADMS_STATUS, iri(coreOntology[status].id)],
  ];
  if (creator) statements.push([DCTERMS + 'creator', iri(creator)]);
  if (description)
    statements.push([DCTERMS + 'description', english(description)]);
  if (maintainer) statements.push([SCHEMA_MAINTAINER, iri(maintainer)]);
  statements.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  const lines = [
    `    a ${iri(OWL_ONTOLOGY)}`,
    ...statements.map(([p, o]) => `    ${iri(p)} ${o}`),
  ];
  return [
    ...prefixes.map(([p, ns]) => `@prefix ${p}: <${ns}> .`),
    '',
    `${iri(namespace)}\n${lines.join(' ;\n')} .`,
    '',
  ].join('\n');
}
