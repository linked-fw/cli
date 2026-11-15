/**
 * The metadata flags of `linked create-package`, read into what `buildPackageFiles` takes:
 * `--author` as a `package.json` person, `--status` as an ontology status, and the ontology
 * fields together. Pure: nothing is asked or written.
 */
import type {PackagePerson} from './packageFiles.js';
import {
  ONTOLOGY_STATUSES,
  type OntologyScaffoldFields,
} from './ontologyScaffoldTurtle.js';

/** The metadata flags, as the command line passes them. */
export interface PackageMetadataFlags {
  title?: string;
  description?: string;
  prefix?: string;
  creator?: string;
  maintainer?: string;
  status?: string;
  author?: string;
}

/**
 * npm's one-line person, `Name <email> (url)`, each part optional:
 *
 *   parsePackagePerson('Ann Lovelace <ann@example.org> (https://example.org/ann)')
 *   // → {name: 'Ann Lovelace', email: 'ann@example.org', url: 'https://example.org/ann'}
 *
 * A bare IRI (`https://example.org/ann#me`) is the url.
 */
export function parsePackagePerson(value: string): PackagePerson {
  const text = value.trim();
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\S+$/.test(text) && !text.includes('<')) {
    return {url: text};
  }
  const email = /<([^>]*)>/.exec(text)?.[1]?.trim();
  const url = /\(([^)]*)\)/.exec(text)?.[1]?.trim();
  const name = text
    .replace(/<[^>]*>/, '')
    .replace(/\([^)]*\)/, '')
    .trim();
  const person: PackagePerson = {};
  if (name) person.name = name;
  if (email) person.email = email;
  if (url) person.url = url;
  if (!Object.keys(person).length) {
    throw new Error(
      `--author ${JSON.stringify(value)} names no one: use "Name <email> (url)".`,
    );
  }
  return person;
}

/** `--status`, case-insensitive (`draft`, `ReadyForReview`, `published`). */
export function ontologyStatusFlag(
  value: string,
): OntologyScaffoldFields['status'] {
  const status = ONTOLOGY_STATUSES.find(
    (s) =>
      s.toLowerCase() ===
      value
        .trim()
        .toLowerCase()
        .replace(/[-_\s]/g, ''),
  );
  if (!status) {
    throw new Error(
      `--status must be one of ${ONTOLOGY_STATUSES.join(', ')}, not ${JSON.stringify(value)}.`,
    );
  }
  return status;
}

/** The ontology fields the flags give (absent ones left to their defaults). */
export function ontologyFieldsFromFlags(
  flags: PackageMetadataFlags,
): OntologyScaffoldFields {
  const fields: OntologyScaffoldFields = {};
  if (flags.title !== undefined) fields.title = flags.title;
  if (flags.description !== undefined) fields.description = flags.description;
  if (flags.prefix !== undefined) fields.prefix = flags.prefix;
  if (flags.creator !== undefined) fields.creator = flags.creator;
  if (flags.maintainer !== undefined) fields.maintainer = flags.maintainer;
  if (flags.status !== undefined)
    fields.status = ontologyStatusFlag(flags.status);
  return fields;
}
