import fs from 'fs';
import os from 'os';
import path from 'path';
import {checkShapeNames, findRenameableShapes} from '../../src/utils/shapeNames';

// A compiled shape without an explicit name is exposed to a bundler renaming its
// class — and so changing its IRI — when its module holds text that makes Vite
// run esbuild over it. See src/utils/shapeNames.ts.

// Shaped like @_linked/server's lib/esm/shapes/LinkedServer.js.
const unnamed = (extra: string) => `import { linkedShape } from '../package.js';
let LinkedServer = class LinkedServer {
  start() { ${extra} }
};
LinkedServer = __decorate([
    linkedShape,
    __metadata("design:paramtypes", [Object])
], LinkedServer);
export { LinkedServer };
`;

describe('findRenameableShapes', () => {
  test('an unnamed shape in a module that reads process.env is exposed', () => {
    expect(findRenameableShapes(unnamed('return process.env.NODE_ENV;'), 'a.js')).toEqual([
      {file: 'a.js', className: 'LinkedServer'},
    ]);
  });

  test('import.meta.env is a trigger too', () => {
    expect(findRenameableShapes(unnamed('return import.meta.env.MODE;'))).toHaveLength(1);
  });

  test('a module with no trigger is not exposed', () => {
    expect(findRenameableShapes(unnamed('return 1;'))).toEqual([]);
  });

  test('an explicit name removes the exposure', () => {
    const named = unnamed('return process.env.NODE_ENV;').replace(
      '    linkedShape,',
      "    linkedShape({ name: 'LinkedServer' }),",
    );
    expect(findRenameableShapes(named)).toEqual([]);
  });

  test('options without a name do not count as naming it', () => {
    const optioned = unnamed('return process.env.NODE_ENV;').replace(
      '    linkedShape,',
      '    linkedShape({ dependent: true }),',
    );
    expect(findRenameableShapes(optioned)).toHaveLength(1);
  });

  test('a class decorated with something else is not a shape', () => {
    const other = unnamed('return process.env.NODE_ENV;').replace('    linkedShape,', '    observable,');
    expect(findRenameableShapes(other)).toEqual([]);
  });
});

describe('checkShapeNames', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'linked-shape-names-'));
  });
  afterEach(() => fs.rmSync(dir, {recursive: true, force: true}));

  test('warns, naming the class and file, for exposed shapes in lib/esm', async () => {
    const file = path.join(dir, 'lib', 'esm', 'shapes', 'LinkedServer.js');
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(file, unnamed('return process.env.NODE_ENV;'));
    const result = await checkShapeNames(dir);
    expect(typeof result).toBe('string');
    expect(result).toContain('LinkedServer (shapes/LinkedServer.js)');
  });

  test('passes when nothing is exposed or there is no lib/esm', async () => {
    expect(await checkShapeNames(dir)).toBe(true);
    const file = path.join(dir, 'lib', 'esm', 'Plain.js');
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(file, unnamed('return 1;'));
    expect(await checkShapeNames(dir)).toBe(true);
  });
});
