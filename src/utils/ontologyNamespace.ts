import {packageNameToSlug} from './shapeReferences.js';

/**
 * The root every first-party and community ontology publishes under (arch-02): an ontology's
 * namespace is `https://linked.cm/ont/{ontologySlug}/`, next to the package's shapes at
 * `https://linked.cm/shape/{publicSlug}/`. It replaces the legacy `http://lincd.org/ont/` root.
 */
export const LINKED_ONTOLOGY_ROOT = 'https://linked.cm/ont/';

/**
 * The default namespace for a scaffolded ontology: `https://linked.cm/ont/{slug}/`.
 *
 * `name` is a package name or an ontology prefix. It is reduced the way core derives a package's
 * publicSlug — the npm scope is dropped and the rest kebab-cased — so a package's own ontology
 * (`@_linked/server` → `https://linked.cm/ont/server/`) shares the slug of its shapes.
 *
 * Private packages do not use this root: they publish under a workspace-scoped one
 * (`https://{workspaceSlug}.id.create.now/ont/{ontologySlug}/`), which the caller passes as the
 * explicit `uriBase` of `create-package` / `create-ontology`.
 */
export function defaultOntologyNamespace(name: string): string {
  const slug = packageNameToSlug(name);
  if (!slug) {
    throw new Error(`Cannot derive an ontology slug from '${name}'`);
  }
  return `${LINKED_ONTOLOGY_ROOT}${slug}/`;
}

/** A namespace ends in `/` or `#`; a bare base gets the `/` it needs. */
export function asNamespace(uriBase: string): string {
  return /[/#]$/.test(uriBase) ? uriBase : `${uriBase}/`;
}
