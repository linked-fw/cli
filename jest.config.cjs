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
const fs = require('fs');
const path = require('path');

// `@_linked/core` cannot be found with require.resolve(): it is ESM-only, so its
// export map has no `require` condition and not even `./package.json` is
// exported. And it is not necessarily in ./node_modules — when this repo is
// checked out inside the create_now yarn workspace, the dependency is hoisted to
// the workspace root. So walk the node_modules chain the way node does, and
// derive the on-disk layout from the package's own export map rather than
// assuming `lib/esm`.
function resolveLinkedCore() {
  let dir = __dirname;
  for (;;) {
    const candidate = path.join(dir, 'node_modules', '@_linked', 'core');
    const manifest = path.join(candidate, 'package.json');
    if (fs.existsSync(manifest)) {
      const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8'));
      const wildcard = pkg.exports && pkg.exports['./*'] && pkg.exports['./*'].import;
      const index = pkg.exports && pkg.exports['.'] && pkg.exports['.'].import;
      return {
        dir: candidate,
        // e.g. './lib/esm/*.js' -> '<dir>/lib/esm/$1.js' for moduleNameMapper
        subpath: path.join(candidate, (wildcard || './lib/esm/*.js').replace('*', '$1')),
        index: path.join(candidate, index || './lib/esm/index.js'),
      };
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(
        '[@_linked/cli jest] cannot find @_linked/core in any node_modules directory above ' +
          __dirname +
          ' — run an install first.',
      );
    }
    dir = parent;
  }
}

const core = resolveLinkedCore();

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
    '^@_linked/core/(.*)$': core.subpath,
    '^@_linked/core$': core.index,
  },
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json'],
};
