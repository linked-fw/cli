/**
 * The metadata flags of `linked create-package`, `create-ont-package` and `create-ontology`, read
 * into what `buildPackageFiles` takes: `--author-name`, `--author-email` and `--author-url` as a
 * `package.json` person, `--status` as an ontology status, and the ontology fields together.
 * Pure: nothing is asked or written.
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
  authorName?: string;
  authorEmail?: string;
  authorUrl?: string;
}

/** `package.json` `author` from `--author-name`, `--author-email` and `--author-url`. */
export function authorFromFlags(flags: PackageMetadataFlags): PackagePerson {
  const author: PackagePerson = {};
  if (flags.authorName?.trim()) author.name = flags.authorName.trim();
  if (flags.authorEmail?.trim()) {
    const email = flags.authorEmail.trim();
    if (!/^[^\s@<>()]+@[^\s@<>()]+$/.test(email)) {
      throw new Error(`--author-email ${JSON.stringify(flags.authorEmail)} is not an email address.`);
    }
    author.email = email;
  }
  if (flags.authorUrl?.trim()) {
    const url = flags.authorUrl.trim();
    if (!/^[A-Za-z][A-Za-z0-9+.-]*:\S+$/.test(url)) {
      throw new Error(`--author-url ${JSON.stringify(flags.authorUrl)} is not a URL.`);
    }
    author.url = url;
  }
  return author;
}

/** `--status`, case-insensitive (`draft`, `ready-for-review`, `Published`). */
export function ontologyStatusFlag(value: string): OntologyScaffoldFields['status'] {
  const status = ONTOLOGY_STATUSES.find(
    (s) => s.toLowerCase() === value.trim().toLowerCase().replace(/[-_\s]/g, ''),
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
  if (flags.status !== undefined) fields.status = ontologyStatusFlag(flags.status);
  return fields;
}
