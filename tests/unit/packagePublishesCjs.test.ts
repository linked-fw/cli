import {packagePublishesCjs} from '../../src/package-manifest';

// A second full tsc pass ran for every package, including the many that are
// "type": "module" with an import-only exports map. The output landed in
// lib/cjs where nothing could resolve it.

describe('packagePublishesCjs', () => {
  test('true when main points at a CJS build', () => {
    expect(packagePublishesCjs({main: 'lib/cjs/index.js'})).toBe(true);
  });

  test('true when any exports entry declares a require condition', () => {
    expect(
      packagePublishesCjs({
        exports: {'.': {import: './lib/esm/index.js', require: './lib/cjs/index.js'}},
      })
    ).toBe(true);
  });

  test('false for an ESM-only package', () => {
    expect(
      packagePublishesCjs({
        type: 'module',
        main: 'lib/esm/index.js',
        exports: {'.': {types: './lib/esm/index.d.ts', import: './lib/esm/index.js'}},
      })
    ).toBe(false);
  });

  test('false for a manifest with neither field, and for nothing at all', () => {
    expect(packagePublishesCjs({})).toBe(false);
    expect(packagePublishesCjs(null)).toBe(false);
  });

  test('a string exports entry is not mistaken for a condition map', () => {
    expect(packagePublishesCjs({exports: {'./tokens.css': './src/tokens.css'}})).toBe(false);
  });
});
