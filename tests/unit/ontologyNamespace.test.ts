import {
  asNamespace,
  defaultOntologyNamespace,
  LINKED_ONTOLOGY_ROOT,
} from '../../src/utils/ontologyNamespace';

// arch-02: a first-party ontology lives at https://linked.cm/ont/{ontologySlug}/, and a
// package's own ontology takes the package's publicSlug — the slug its shapes use.
describe('defaultOntologyNamespace', () => {
  it('uses the linked.cm root, not the legacy lincd.org one', () => {
    expect(LINKED_ONTOLOGY_ROOT).toBe('https://linked.cm/ont/');
    expect(defaultOntologyNamespace('foo')).toBe('https://linked.cm/ont/foo/');
  });

  it('drops the npm scope, like the shape slug', () => {
    expect(defaultOntologyNamespace('@_linked/server')).toBe('https://linked.cm/ont/server/');
    expect(defaultOntologyNamespace('@_linked/server-utils')).toBe(
      'https://linked.cm/ont/server-utils/',
    );
    expect(defaultOntologyNamespace('@linked.cm/blog')).toBe('https://linked.cm/ont/blog/');
  });

  it('kebab-cases the rest', () => {
    expect(defaultOntologyNamespace('My_Ontology')).toBe('https://linked.cm/ont/my-ontology/');
  });

  it('refuses a name with no slug in it', () => {
    expect(() => defaultOntologyNamespace('@scope/')).toThrow();
  });
});

describe('asNamespace', () => {
  it('appends a slash only when the base has no terminator', () => {
    expect(asNamespace('https://acme.id.create.now/ont/crm')).toBe(
      'https://acme.id.create.now/ont/crm/',
    );
    expect(asNamespace('https://acme.id.create.now/ont/crm/')).toBe(
      'https://acme.id.create.now/ont/crm/',
    );
    expect(asNamespace('http://example.org/vocab#')).toBe('http://example.org/vocab#');
  });
});
