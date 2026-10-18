import {isBundled, packageNameOf} from '../../src/utils/ssrBundled';

describe('packageNameOf', () => {
  it('keeps the scope and name of a scoped specifier', () => {
    expect(packageNameOf('@_linked/server')).toBe('@_linked/server');
    expect(
      packageNameOf('@_linked/server/shapes/quadstores/RemoteDataset'),
    ).toBe('@_linked/server');
  });

  it('keeps the first segment of an unscoped specifier', () => {
    expect(packageNameOf('ulid')).toBe('ulid');
    expect(packageNameOf('lodash/merge')).toBe('lodash');
  });
});

describe('isBundled', () => {
  it('matches a string entry by equality', () => {
    expect(isBundled('@_linked/server', ['@_linked/server'])).toBe(true);
    expect(isBundled('@_linked/server-utils', ['@_linked/server'])).toBe(false);
  });

  it('tests a RegExp entry against the name', () => {
    const standalone = [/^@_linked\/(?!(core|cli)$)/];
    expect(isBundled('@_linked/server', standalone)).toBe(true);
    expect(isBundled('@_linked/fuseki', standalone)).toBe(true);
    expect(isBundled('@_linked/core', standalone)).toBe(false);
    expect(isBundled('@_linked/cli', standalone)).toBe(false);
  });

  it('matches the package name, not a subpath', () => {
    expect(
      isBundled('@_linked/server', ['@_linked/server/shapes/LinkedServer']),
    ).toBe(false);
  });

  it('bundles nothing for an empty list', () => {
    expect(isBundled('@_linked/server', [])).toBe(false);
  });
});
