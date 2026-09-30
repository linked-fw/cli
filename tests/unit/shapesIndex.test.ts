import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  checkShapesIndex,
  checkShapesSideEffects,
} from '../../src/utils/shapesIndex';
// cli-methods pulls in ora, which is ESM-only.
jest.mock('ora', () => ({__esModule: true, default: () => ({})}));
import {addShapeToBarrel} from '../../src/cli-methods';

// Fixtures are compiled packages, loaded by real `node` children against this repo's
// @_linked/core (through a node_modules symlink), as the build step loads them.

const cliRoot = path.resolve(__dirname, '..', '..');
const cliNodeModules = path.join(cliRoot, 'node_modules');

const PKG = `import { linkedPackage } from '@_linked/core/utils/Package';
export const { linkedShape, packageName } = linkedPackage('@test/fixture');
`;

// A shape class as tsc emits it.
const shapeClass = (name: string, pkgModule = '../package.js') => `import { Shape } from '@_linked/core/shapes/Shape';
import { linkedShape } from '${pkgModule}';
var __decorate = function (d, t, k, desc) {
  var c = arguments.length, r = c < 3 ? t : desc;
  for (var i = d.length - 1; i >= 0; i--) r = (c < 3 ? d[i](r) : d[i](t, k, r)) || r;
  return r;
};
let ${name} = class ${name} extends Shape {};
${name}.targetClass = { id: 'http://example.org/${name}' };
${name} = __decorate([
    linkedShape
], ${name});
export { ${name} };
`;

let dir: string;
const write = (file: string, content: string) => {
  const full = path.join(dir, file);
  fs.mkdirSync(path.dirname(full), {recursive: true});
  fs.writeFileSync(full, content);
};
const fixture = (files: Record<string, string>, pkgJson: object = {}) => {
  write(
    'package.json',
    JSON.stringify({
      name: '@test/fixture',
      type: 'module',
      main: 'lib/esm/index.js',
      ...pkgJson,
    }),
  );
  write('lib/esm/package.js', PKG);
  for (const [file, content] of Object.entries(files)) write(file, content);
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'linked-shapes-index-'));
  fs.symlinkSync(cliNodeModules, path.join(dir, 'node_modules'), 'dir');
});
afterEach(() => fs.rmSync(dir, {recursive: true, force: true}));

const twoShapes = {
  'lib/esm/shapes/Person.js': shapeClass('Person'),
  'lib/esm/shapes/Place.js': shapeClass('Place'),
};

describe('checkShapesIndex', () => {
  test('passes when shapes/index registers every shape', async () => {
    fixture({
      ...twoShapes,
      'lib/esm/shapes/index.js': "import './Person.js';\nimport './Place.js';\n",
    });
    expect(await checkShapesIndex(dir)).toBe(true);
  });

  test('fails when shapes/index misses a shape, naming it and the import to add', async () => {
    fixture({
      ...twoShapes,
      'lib/esm/shapes/index.js': "import './Person.js';\n",
    });
    const result = await checkShapesIndex(dir);
    expect(result).toEqual({error: expect.any(String)});
    const error = (result as {error: string}).error;
    expect(error).toContain(
      '1 shape(s) are not registered by loading lib/esm/shapes/index.js on its own',
    );
    expect(error).toContain(`fixture/Place (${path.join('src', 'shapes', 'Place.ts')})`);
    expect(error).toContain("Add to src/shapes/index.ts:\n  import './Place.js';");
    expect(error).not.toContain('Person');
  });

  test('a shape reached only through another module still counts as registered', async () => {
    // Person's module imports Place: the index needs only Person to register both.
    fixture({
      'lib/esm/shapes/Place.js': shapeClass('Place'),
      'lib/esm/shapes/Person.js': "import './Place.js';\n" + shapeClass('Person'),
      'lib/esm/shapes/index.js': "import './Person.js';\n",
    });
    expect(await checkShapesIndex(dir)).toBe(true);
  });

  test('fails when the package has shapes but no shapes/index', async () => {
    fixture({
      ...twoShapes,
      'lib/esm/index.js': "import './shapes/Person.js';\nimport './shapes/Place.js';\n",
    });
    const error = ((await checkShapesIndex(dir)) as {error: string}).error;
    expect(error).toContain(
      'This package declares 2 shape(s) but has no src/shapes/index.ts',
    );
    expect(error).toContain("  import './Person.js';\n  import './Place.js';");
    expect(error).toContain("import it from src/index.ts: import './shapes/index.js';");
  });

  test('a shape declared outside shapes/ must be in the index too', async () => {
    fixture({
      'lib/esm/shapes/Person.js': shapeClass('Person'),
      'lib/esm/components/Card.js': shapeClass('Card'),
      'lib/esm/shapes/index.js': "import './Person.js';\n",
    });
    const error = ((await checkShapesIndex(dir)) as {error: string}).error;
    expect(error).toContain("import '../components/Card.js';");
    expect(error).toContain('belong in src/shapes/');
  });

  test('fails when shapes/index throws on load', async () => {
    fixture({
      ...twoShapes,
      'lib/esm/shapes/index.js':
        "import './Person.js';\nthrow new Error('boom in index');\n",
    });
    const error = ((await checkShapesIndex(dir)) as {error: string}).error;
    expect(error).toContain('lib/esm/shapes/index.js throws when loaded on its own');
    expect(error).toContain('boom in index');
  });

  test('passes a package without shapes', async () => {
    fixture({'lib/esm/utils/x.js': 'export const x = 1;\n'});
    expect(await checkShapesIndex(dir)).toBe(true);
    fs.rmSync(path.join(dir, 'lib'), {recursive: true});
    expect(await checkShapesIndex(dir)).toBe(true);
  });
});

describe('checkShapesSideEffects', () => {
  const withShapes = (sideEffects: unknown, extra: Record<string, string> = {}) =>
    fixture(
      {
        'lib/esm/shapes/index.js': "import './Person.js';\n",
        'lib/esm/shapes/Person.js': 'export {};\n',
        ...extra,
      },
      sideEffects === undefined ? {} : {sideEffects},
    );

  test('passes when sideEffects is absent or true', () => {
    withShapes(undefined);
    expect(checkShapesSideEffects(dir)).toBe(true);
    withShapes(true);
    expect(checkShapesSideEffects(dir)).toBe(true);
  });

  test('fails on sideEffects: false, saying what to write instead', () => {
    withShapes(false);
    const error = (checkShapesSideEffects(dir) as {error: string}).error;
    expect(error).toContain('"sideEffects": false');
    expect(error).toContain(
      '"sideEffects": ["lib/esm/shapes/index.js", "lib/esm/shapes/*.js"]',
    );
  });

  test('fails on a list that leaves shape modules out, naming them', () => {
    withShapes(['*.css']);
    const error = (checkShapesSideEffects(dir) as {error: string}).error;
    expect(error).toContain('does not cover 2 shape module(s)');
    expect(error).toContain('  lib/esm/shapes/Person.js');
    expect(error).toContain('  lib/esm/shapes/index.js');
  });

  test('passes the standard list, and ./-prefixed or slash-less patterns', () => {
    withShapes(['lib/esm/shapes/index.js', 'lib/esm/shapes/*.js', '*.css']);
    expect(checkShapesSideEffects(dir)).toBe(true);
    withShapes(['./lib/esm/shapes/**']);
    expect(checkShapesSideEffects(dir)).toBe(true);
    withShapes(['*.js']);
    expect(checkShapesSideEffects(dir)).toBe(true);
  });

  test('a single-level glob misses nested shape folders', () => {
    withShapes(['lib/esm/shapes/*.js'], {
      'lib/esm/shapes/geo/Point.js': 'export {};\n',
    });
    const error = (checkShapesSideEffects(dir) as {error: string}).error;
    expect(error).toContain('  lib/esm/shapes/geo/Point.js');
    expect(error).toContain('lib/esm/shapes/**/*.js');
  });

  test('ignores sideEffects when there are no shape modules', () => {
    fixture({'lib/esm/index.js': 'export {};\n'}, {sideEffects: false});
    expect(checkShapesSideEffects(dir)).toBe(true);
  });
});

describe('create-shape registers the shape in src/shapes/index.ts', () => {
  test.each([
    ['a package', 'index.ts'],
    ['an app', 'index.tsx'],
  ])('in %s', (_, entry) => {
    write(`src/${entry}`, "import './package.js';\n");
    write('src/backend.ts', 'export class Backend {}\n');
    const barrel = addShapeToBarrel('person', dir);
    addShapeToBarrel('place', dir);
    addShapeToBarrel('person', dir);
    expect(barrel).toBe(path.join(dir, 'src', 'shapes', 'index.ts'));
    const body = fs.readFileSync(barrel, 'utf8');
    const code = body.split('\n').filter((l) => l.trim() && !l.startsWith('//'));
    expect(code.sort()).toEqual(["import './person.js';", "import './place.js';"]);
    expect(fs.readFileSync(path.join(dir, 'src', entry), 'utf8')).toContain(
      "import './shapes/index.js';",
    );
    expect(fs.readFileSync(path.join(dir, 'src', 'backend.ts'), 'utf8')).toContain(
      "import './shapes/index.js';",
    );
  });
});

describe('the package template follows the standard', () => {
  const template = path.join(cliRoot, 'defaults', 'package', 'src');
  test('shapes/index.ts holds side-effect imports only, and the entry imports it', () => {
    const barrel = fs.readFileSync(path.join(template, 'shapes', 'index.ts'), 'utf8');
    const code = barrel.split('\n').filter((l) => l.trim() && !l.trim().startsWith('//'));
    expect(code.every((l) => /^import '\.{1,2}\/[^']+\.js';$/.test(l))).toBe(true);
    expect(barrel).not.toMatch(/\bexport\b/);
    const entry = fs.readFileSync(path.join(template, 'index.ts'), 'utf8');
    expect(entry).toContain("import './shapes/index.js';");
    expect(entry).not.toMatch(/['"]\.\/shapes\/(?!index)/);
  });

  test('package.json does not declare shape modules side-effect-free', () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(cliRoot, 'defaults', 'package', 'package.json'), 'utf8'),
    );
    expect(pkg.sideEffects).toBeUndefined();
  });
});
