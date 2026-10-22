import fs from 'fs';
import os from 'os';
import path from 'path';

// ora is ESM-only, which Jest's CommonJS loader cannot require.
jest.mock('ora', () => ({__esModule: true, default: () => ({})}));

import {depCheck} from '../../src/cli-methods.js';

// depCheck scans a package's sources with depcheck and reports the imports
// package.json does not list. `react` is left out of that report on purpose.

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'linked-depcheck-'));
});
afterEach(() => fs.rmSync(dir, {recursive: true, force: true}));

const fixture = (source: string) => {
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({name: '@test/depcheck', version: '1.0.0', type: 'module'}),
  );
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'index.ts'), source);
};

describe('depCheck', () => {
  test('reports every missing dependency when react is not among them', async () => {
    fixture("import {Parser} from 'n3';\nexport const p = new Parser();\n");
    const result = await depCheck(dir);
    expect(typeof result).toBe('string');
    expect(result).toContain('- n3');
  });

  test('leaves react out of the report and keeps the rest', async () => {
    fixture(
      "import React from 'react';\nimport {Parser} from 'n3';\nexport const a = [React, Parser];\n",
    );
    const result = await depCheck(dir);
    expect(result).toContain('- n3');
    expect(result).not.toContain('- react');
  });

  test("never reports the package's own name, imported from its tests", async () => {
    fixture("import {Parser} from 'n3';\nexport const p = new Parser();\n");
    fs.mkdirSync(path.join(dir, 'tests'));
    fs.writeFileSync(
      path.join(dir, 'tests', 'index.test.ts'),
      "import {p} from '@test/depcheck/index';\nimport {q} from '@test/depcheck';\nexport const a = [p, q];\n",
    );
    const result = await depCheck(dir);
    expect(result).toContain('- n3');
    expect(result).not.toContain('@test/depcheck');
  });

  test('passes when its own name is the only missing dependency', async () => {
    fixture("import {p} from '@test/depcheck/index';\nexport const a = p;\n");
    expect(await depCheck(dir)).toBe(true);
  });

  test('passes when react is the only missing dependency', async () => {
    fixture("import React from 'react';\nexport const a = React;\n");
    expect(await depCheck(dir)).toBe(true);
  });
});
