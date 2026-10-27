// `linkedKind` is the one way anything decides what a package.json is: its
// `linked.kind`. The retired `linkedPackage` / `linkedApp` flags are not read.
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
    ['the old linkedPackage flag alone', {name: 'x', linkedPackage: true}],
    ['the old linkedApp flag alone', {name: 'x', linkedApp: true}],
    ['null', null],
    ['a string', 'ontology'],
  ])('undefined for %s', (_label, json) => {
    expect(linkedKind(json)).toBeUndefined();
  });

  test('a linked package is any kind but app', () => {
    expect(isLinkedPackageJson({linked: {kind: 'ontology'}})).toBe(true);
    expect(isLinkedPackageJson({linked: {kind: 'assets'}})).toBe(true);
    expect(isLinkedPackageJson({linked: {kind: 'library'}})).toBe(true);
    expect(isLinkedPackageJson({linked: {kind: 'app'}})).toBe(false);
    expect(isLinkedPackageJson({linkedPackage: true})).toBe(false);
    expect(isLinkedPackageJson(undefined)).toBe(false);
  });
});
