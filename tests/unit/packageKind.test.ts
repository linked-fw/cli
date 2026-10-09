import {
  decidePackageKind,
  ontologySlugFor,
  packageNameFor,
  scaffoldKinds,
} from '../../src/utils/packageKind';

// `create-package` scaffolds an ontology package (`<name>-ont`), an asset package
// (`<name>-assets`) or both. These pin the decision table and the naming rules.

describe('decidePackageKind', () => {
  it('takes --kind as the complete answer, even on a terminal', () => {
    for (const kind of ['ontology', 'assets', 'both'] as const) {
      expect(decidePackageKind({kind, isTTY: true})).toEqual({
        kind: 'resolved',
        packageKind: kind,
      });
    }
  });

  it('asks only on a terminal, and refuses with the flag to pass otherwise', () => {
    expect(decidePackageKind({isTTY: true})).toEqual({kind: 'ask'});
    const scripted = decidePackageKind({isTTY: false});
    expect(scripted.kind).toBe('refuse');
    expect((scripted as any).message).toMatch(/--kind ontology/);
    expect((scripted as any).message).toMatch(/--kind assets/);
    expect((scripted as any).message).toMatch(/--kind both/);
  });

  it('refuses a kind it does not know', () => {
    const decision = decidePackageKind({kind: 'shapes', isTTY: true});
    expect(decision.kind).toBe('refuse');
    expect((decision as any).message).toMatch(/ontology, assets, both/);
  });

  it('refuses --remote with both: one repository cannot hold two packages', () => {
    const decision = decidePackageKind({
      kind: 'both',
      remote: 'git@github.com:o/r.git',
      isTTY: true,
    });
    expect(decision.kind).toBe('refuse');
    expect((decision as any).message).toMatch(/create-ont-package/);
  });
});

describe('scaffoldKinds', () => {
  it('expands both to the ontology package first, then the asset package', () => {
    expect(scaffoldKinds('both')).toEqual(['ontology', 'assets']);
    expect(scaffoldKinds('ontology')).toEqual(['ontology']);
    expect(scaffoldKinds('assets')).toEqual(['assets']);
  });
});

describe('packageNameFor', () => {
  it('adds the suffix of the kind, keeping the scope', () => {
    expect(packageNameFor('foo', 'ontology')).toBe('foo-ont');
    expect(packageNameFor('foo', 'assets')).toBe('foo-assets');
    expect(packageNameFor('@acme/foo', 'ontology')).toBe('@acme/foo-ont');
    expect(packageNameFor('@acme/foo', 'assets')).toBe('@acme/foo-assets');
  });

  it('never doubles a suffix the name already has', () => {
    expect(packageNameFor('foo-ont', 'ontology')).toBe('foo-ont');
    expect(packageNameFor('foo-assets', 'assets')).toBe('foo-assets');
    expect(packageNameFor('@acme/foo-ont', 'ontology')).toBe('@acme/foo-ont');
  });

  it('does not mistake one suffix for the other', () => {
    expect(packageNameFor('foo-ont', 'assets')).toBe('foo-ont-assets');
    expect(packageNameFor('foo-assets', 'ontology')).toBe('foo-assets-ont');
  });
});

describe('ontologySlugFor', () => {
  it('is the bare package name without -ont', () => {
    expect(ontologySlugFor('foo-ont')).toBe('foo');
    expect(ontologySlugFor('@acme/foo-ont')).toBe('foo');
    expect(ontologySlugFor('lego-planning-ont')).toBe('lego-planning');
  });

  it('leaves a name without the suffix alone', () => {
    expect(ontologySlugFor('foo')).toBe('foo');
  });
});
