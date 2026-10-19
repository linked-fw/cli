import {linkedModuleCopies} from '../e2e/helpers/moduleCopies.js';

// The browser check of the dual-copy e2e (cli report 021) fails on what this
// returns: any @_linked script module the page requested in two forms.
const O = 'http://localhost:4500';

describe('linkedModuleCopies', () => {
  test('a module requested plain and with ?v is two copies (report 018)', () => {
    expect(
      linkedModuleCopies([
        `${O}/node_modules/@_linked/shape-ui/src/hostContext.tsx`,
        `${O}/node_modules/@_linked/shape-ui/src/hostContext.tsx?v=b4fad9c9`,
        `${O}/node_modules/@_linked/shape-ui/src/index.ts`,
      ]),
    ).toEqual([
      {
        module: '@_linked/shape-ui/src/hostContext.tsx',
        urls: [
          '/node_modules/@_linked/shape-ui/src/hostContext.tsx',
          '/node_modules/@_linked/shape-ui/src/hostContext.tsx?v=b4fad9c9',
        ],
      },
    ]);
  });

  test('one form per module, requested any number of times, is one copy', () => {
    expect(
      linkedModuleCopies([
        `${O}/node_modules/@_linked/shape-ui/src/hostContext.tsx`,
        `${O}/node_modules/@_linked/shape-ui/src/hostContext.tsx`,
        `${O}/node_modules/@_linked/core/lib/esm/index.js?v=1`,
        `${O}/node_modules/@_linked/core/lib/esm/index.js?v=1`,
      ]),
    ).toEqual([]);
  });

  test('the HMR timestamp does not make a second form', () => {
    expect(
      linkedModuleCopies([
        `${O}/node_modules/@_linked/react/lib/esm/a.js?v=1`,
        `${O}/node_modules/@_linked/react/lib/esm/a.js?v=1&t=1700000000`,
      ]),
    ).toEqual([]);
  });

  test('the same file from two paths is two copies', () => {
    const copies = linkedModuleCopies([
      `${O}/node_modules/@_linked/core/lib/esm/utils/LinkedStorage.js`,
      `${O}/@fs/work/packages-local/_linked-core/lib/esm/utils/LinkedStorage.js`,
    ]);
    expect(copies.map((c) => c.module)).toEqual([
      '@_linked/core/lib/esm/utils/LinkedStorage.js',
    ]);
    expect(copies[0].urls).toHaveLength(2);
  });

  test('a nested node_modules copy is keyed by its innermost package', () => {
    const copies = linkedModuleCopies([
      `${O}/node_modules/@_linked/react/lib/esm/a.js`,
      `${O}/node_modules/@_linked/schema/node_modules/@_linked/react/lib/esm/a.js`,
    ]);
    expect(copies.map((c) => c.module)).toEqual([
      '@_linked/react/lib/esm/a.js',
    ]);
  });

  test('a package from the optimizer and file by file is two copies (cli#272)', () => {
    const copies = linkedModuleCopies([
      `${O}/node_modules/.vite/deps/_linked_shape-ui_components_InstanceView.js?v=1`,
      `${O}/node_modules/@_linked/shape-ui/src/index.ts`,
    ]);
    expect(copies).toEqual([
      {
        module: '@_linked/shape-ui',
        urls: [
          '/node_modules/.vite/deps/_linked_shape-ui_components_InstanceView.js?v=1',
          '/node_modules/@_linked/shape-ui/src/index.ts',
        ],
      },
    ]);
  });

  test('an optimized package with no files served is one copy', () => {
    expect(
      linkedModuleCopies([
        `${O}/node_modules/.vite/deps/_linked_core.js?v=1`,
        `${O}/node_modules/.vite/deps/_linked_core_utils_LinkedStorage.js?v=1`,
      ]),
    ).toEqual([]);
  });

  test('CSS, non-linked modules and unparsable URLs are ignored', () => {
    expect(
      linkedModuleCopies([
        `${O}/node_modules/@_linked/shape-ui/src/table.module.css`,
        `${O}/node_modules/@_linked/shape-ui/src/table.module.css?direct`,
        `${O}/node_modules/react/index.js`,
        `${O}/node_modules/react/index.js?v=1`,
        'not a url',
      ]),
    ).toEqual([]);
  });
});
