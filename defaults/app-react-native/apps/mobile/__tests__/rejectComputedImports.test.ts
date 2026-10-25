import { transformSync } from '@babel/core';

import rejectComputedImports from '../babel/rejectComputedImports';

const transform = (code: string, withPlugin = true, parserOpts: Record<string, unknown> = {}) =>
  transformSync(code, {
    babelrc: false,
    configFile: false,
    filename: '/app/node_modules/pkg/lib/load.js',
    cwd: '/app',
    parserOpts,
    plugins: withPlugin ? [rejectComputedImports] : [],
  })!.code;

const REJECTION =
  'Promise.reject(new Error("import() with a computed specifier is not available in React Native (node_modules/pkg/lib/load.js)"))';

describe('rejectComputedImports', () => {
  test('rejects an import of a variable specifier', () => {
    expect(transform('const s = "node:fs/promises"; import(s);')).toBe(
      `const s = "node:fs/promises";\n${REJECTION};`,
    );
  });

  test('rejects an expression or template-with-expressions specifier', () => {
    expect(transform('import(url(p).href);')).toBe(`${REJECTION};`);
    expect(transform('import(`./${name}.js`);')).toBe(`${REJECTION};`);
  });

  test('handles ImportExpression nodes (createImportExpressions)', () => {
    expect(transform('import(s);', true, { createImportExpressions: true })).toBe(`${REJECTION};`);
  });

  test('leaves a static specifier unchanged', () => {
    for (const code of ["import('./a.js');", 'import(`./a.js`);', "import('./a.json', { with: { type: 'json' } });"]) {
      expect(transform(code)).toBe(transform(code, false));
    }
  });

  test('the rejection is a promise that rejects', async () => {
    const code = transform('module.exports = import(s);')!;
    const mod: { exports?: Promise<unknown> } = {};
    new Function('module', code)(mod);
    await expect(mod.exports).rejects.toThrow('not available in React Native');
  });
});
