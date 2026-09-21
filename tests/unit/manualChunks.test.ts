import {chunkForModuleId} from '../../src/vite-config';

// Getting this grouping wrong does not fail the build. It produces a bundle
// that throws on load in the browser, which is only visible by opening the
// built app — so it is asserted here instead.

const nm = (specifier: string) => `/app/node_modules/${specifier}/index.js`;

describe('chunkForModuleId', () => {
  test('React and everything that must initialise with it share one chunk', () => {
    // react-router-dom re-exports react-router, and react-router imports
    // @remix-run/router. Leaving either in `vendor` puts an import edge from
    // react-vendor into vendor, while vendor's top-level React.createContext
    // calls point back — a cycle Rollup resolves by running vendor first, so
    // React is still undefined when vendor's module body executes.
    for (const pkg of [
      'react',
      'react-dom',
      'react-router',
      'react-router-dom',
      '@remix-run/router',
      'scheduler',
    ]) {
      expect(chunkForModuleId(nm(pkg))).toBe('react-vendor');
    }
  });

  test('an unrelated dependency still lands in the catch-all vendor chunk', () => {
    expect(chunkForModuleId(nm('zod'))).toBe('vendor');
    expect(chunkForModuleId(nm('js-cookie'))).toBe('vendor');
  });

  test('the isolated heavy dependencies keep their own chunks', () => {
    expect(chunkForModuleId(nm('@monaco-editor/react'))).toBe('monaco');
    expect(chunkForModuleId(nm('recharts'))).toBe('viz');
    expect(chunkForModuleId(nm('framer-motion'))).toBe('motion');
  });

  test('linked framework workspaces group together', () => {
    expect(chunkForModuleId('/app/packages/core/src/index.ts')).toBe('linked');
    expect(chunkForModuleId('/app/packages/auth/src/index.ts')).toBe('linked');
  });

  test('app source is left to Rollup', () => {
    expect(chunkForModuleId('/app/src/pages/Home.tsx')).toBeUndefined();
  });
});
