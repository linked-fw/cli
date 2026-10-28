// `linkedKind` is the one way anything decides what a package.json is: its
// `linked.kind`, or, for a package published before it, the retired
// `linkedPackage` / `linkedApp` flags.
import {
  isLinkedPackageJson,
  LINKED_KINDS,
  linkedKind,
} from '../../src/installed-packages';

describe('linkedKind', () => {
  test.each(LINKED_KINDS)('reads linked.kind "%s"', (kind) => {
    expect(linkedKind({name: 'x', linked: {kind}})).toBe(kind);
  });

  test('keeps the rest of the linked object out of it', () => {
    expect(linkedKind({linked: {serverOnly: ['a'], kind: 'library'}})).toBe(
      'library',
    );
  });

  test.each([
    ['no linked object', {name: 'x'}],
    ['a linked object without kind', {linked: {serverOnly: []}}],
    ['a non-string kind', {linked: {kind: 1}}],
    ['an unknown kind', {linked: {kind: 'package'}}],
    ['linked that is not an object', {linked: 'ontology'}],
    ['null', null],
    ['a string', 'ontology'],
  ])('undefined for %s', (_label, json) => {
    expect(linkedKind(json)).toBeUndefined();
  });

  test('a package.json without linked.kind is read by the retired flags', () => {
    expect(linkedKind({name: 'x', linkedPackage: true})).toBe('library');
    expect(linkedKind({name: 'x', linkedApp: true})).toBe('app');
    expect(linkedKind({linked: {serverOnly: []}, linkedPackage: true})).toBe(
      'library',
    );
    expect(linkedKind({linked: {kind: 'ontology'}, linkedPackage: true})).toBe(
      'ontology',
    );
    expect(linkedKind({name: 'x', linkedPackage: 'yes'})).toBeUndefined();
  });

  test('a linked package is any kind but app', () => {
    expect(isLinkedPackageJson({linked: {kind: 'ontology'}})).toBe(true);
    expect(isLinkedPackageJson({linked: {kind: 'assets'}})).toBe(true);
    expect(isLinkedPackageJson({linked: {kind: 'library'}})).toBe(true);
    expect(isLinkedPackageJson({linked: {kind: 'app'}})).toBe(false);
    expect(isLinkedPackageJson({linkedPackage: true})).toBe(true);
    expect(isLinkedPackageJson({linkedApp: true})).toBe(false);
    expect(isLinkedPackageJson(undefined)).toBe(false);
  });
});
