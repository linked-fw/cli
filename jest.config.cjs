// Jest config for @_linked/cli unit tests.
//
// The cli is now ESM-only (no lib/cjs). Rather than configure jest's ESM mode
// (notoriously fiddly), tests import raw `src/` .ts and let babel-jest
// transpile ESM→CJS. The `moduleNameMapper` below strips the `.js` suffix from
// relative specifiers (src uses the published-output `./foo.js` convention) so
// they resolve back to the `.ts` source.
//
// E2E specs live in tests/e2e/ and run under Playwright (see
// playwright.config.ts), not Jest.
module.exports = {
  testEnvironment: 'node',
  rootDir: '.',
  roots: ['<rootDir>/tests/unit'],
  testMatch: ['**/*.test.{ts,js}'],
  // `@_linked/core` is ESM-only (its export map has no `require` condition) and
  // ships untranspiled ESM, so it is both mapped to its real file path and run
  // through babel like the rest of the sources.
  transformIgnorePatterns: ['/node_modules/(?!@_linked/)'],
  transform: {
    '^.+\\.(t|j)sx?$': [
      'babel-jest',
      {
        configFile: false,
        babelrc: false,
        presets: [
          ['@babel/preset-env', { targets: { node: 'current' } }],
          '@babel/preset-typescript',
        ],
        // Rewrites `import.meta` (a syntax error in CommonJS) so cli-methods.ts loads.
        plugins: [require('path').join(__dirname, 'tests', 'babel-plugin-import-meta.cjs')],
      },
    ],
  },
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
    '^@_linked/core/(.*)$': '<rootDir>/node_modules/@_linked/core/lib/esm/$1.js',
    '^@_linked/core$': '<rootDir>/node_modules/@_linked/core/lib/esm/index.js',
  },
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json'],
};
