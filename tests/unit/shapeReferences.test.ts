import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  checkShapeReferences,
  findShapeModules,
  inspectShapeReferences,
} from '../../src/utils/shapeReferences';

// Each fixture is a compiled package: lib/esm written the way tsc emits it, loaded
// by a real `node` child against this repo's @_linked/core (reached through a
// node_modules symlink), exactly as the build step loads a package's output.

const cliNodeModules = path.resolve(__dirname, '..', '..', 'node_modules');

const PKG = `import { linkedPackage } from '@_linked/core/utils/Package';
export const { linkedShape, packageName } = linkedPackage('@test/fixture');
`;

// A shape class as tsc emits it, with one object property naming its value shape.
const shapeClass = (
  name: string,
  {
    extendsFrom,
    shape,
    imports = '',
  }: {extendsFrom?: string; shape?: string; imports?: string},
) => `import { Shape } from '@_linked/core/shapes/Shape';
import { objectProperty } from '@_linked/core/shapes/SHACL';
import { linkedShape } from '../package.js';
${imports}
var __decorate = function (d, t, k, desc) {
  var c = arguments.length, r = c < 3 ? t : desc;
  for (var i = d.length - 1; i >= 0; i--) r = (c < 3 ? d[i](r) : d[i](t, k, r)) || r;
  return r;
};
let ${name} = class ${name} extends ${extendsFrom || 'Shape'} {
  get ref() { return undefined; }
};
${name}.targetClass = { id: 'http://example.org/${name}' };
${
  shape
    ? `__decorate([
    objectProperty({ path: { id: 'http://example.org/ref${name}' }, shape: ${shape} })
], ${name}.prototype, "ref", Object.getOwnPropertyDescriptor(${name}.prototype, "ref"));`
    : ''
}
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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'linked-shape-refs-'));
  fs.symlinkSync(cliNodeModules, path.join(dir, 'node_modules'), 'dir');
});
afterEach(() => fs.rmSync(dir, {recursive: true, force: true}));

// Thing.image names ImageObject by [package, name], because ImageObject extends
// Thing and Thing's module cannot import it — @_linked/schema before its fix.
const broken = () =>
  fixture({
    'lib/esm/shapes/Thing.js': shapeClass('Thing', {
      shape: "['@test/fixture', 'ImageObject']",
    }),
    'lib/esm/shapes/ImageObject.js': shapeClass('ImageObject', {
      extendsFrom: 'Thing',
      imports: "import { Thing } from './Thing.js';",
    }),
    'lib/esm/index.js':
      "import './shapes/Thing.js';\nimport './shapes/ImageObject.js';\n",
  });

describe('checkShapeReferences', () => {
  test('fails when loading a module on its own leaves a by-name value shape unregistered', async () => {
    broken();
    const result = await checkShapeReferences(dir);
    expect(result).toEqual({error: expect.any(String)});
    const error = (result as {error: string}).error;
    expect(error).toContain(
      'fixture/Thing.ref -> https://linked.cm/shape/fixture/ImageObject',
    );
    expect(error).toContain('unresolved after loading shapes/Thing.js');
    // ImageObject's own module loads Thing, and ImageObject with it.
    expect(error).not.toContain('shapes/ImageObject.js');
    // The package's entry registers it, so the fix is an import, not a rename.
    expect(error).toContain("@test/fixture's entry registers it");
  });

  test('passes once the public module registers what its properties name', async () => {
    // @_linked/schema's fix: the class lives in a `.class` module, the public
    // module re-exports it and imports the named shape, and the ancestor chain
    // imports only `.class` modules.
    fixture({
      'lib/esm/shapes/Thing.class.js': shapeClass('Thing', {
        shape: "['@test/fixture', 'ImageObject']",
      }),
      'lib/esm/shapes/Thing.js':
        "export * from './Thing.class.js';\nimport './ImageObject.class.js';\n",
      'lib/esm/shapes/ImageObject.class.js': shapeClass('ImageObject', {
        extendsFrom: 'Thing',
        imports: "import { Thing } from './Thing.class.js';",
      }),
      'lib/esm/shapes/ImageObject.js':
        "export * from './ImageObject.class.js';\n",
      'lib/esm/index.js':
        "import './shapes/Thing.js';\nimport './shapes/ImageObject.js';\n",
    });
    expect(await checkShapeReferences(dir)).toBe(true);
    // `.class` modules are the checked modules' internals, not entry points.
    expect((await inspectShapeReferences(dir)).modules).toEqual([
      path.join('shapes', 'ImageObject.js'),
      path.join('shapes', 'Thing.js'),
    ]);
  });

  test('fails when a shape module throws on load, naming the module and the error', async () => {
    fixture({
      'lib/esm/shapes/Thing.js': shapeClass('Thing', {}),
      'lib/esm/shapes/Broken.js':
        "import './Thing.js';\nthrow new ReferenceError(\"Cannot access 'DefinedTerm' before initialization\");\n",
    });
    const result = await checkShapeReferences(dir);
    const error = (result as {error: string}).error;
    expect(error).toContain('1 shape module(s) throw when loaded on their own');
    expect(error).toContain(
      "shapes/Broken.js: ReferenceError: Cannot access 'DefinedTerm' before initialization",
    );
  });

  test('names a reference to a package that is not a dependency', async () => {
    // @_linked/sioc still naming shapes under its old package name.
    fixture(
      {
        'lib/esm/shapes/Space.js': shapeClass('Space', {
          shape: "['lincd-sioc', 'Usergroup']",
        }),
      },
      {dependencies: {'@_linked/core': '*'}},
    );
    const error = ((await checkShapeReferences(dir)) as {error: string}).error;
    expect(error).toContain(
      'fixture/Space.ref -> https://linked.cm/shape/lincd-sioc/Usergroup',
    );
    expect(error).toContain(
      "'lincd-sioc' is neither this package nor one of its dependencies",
    );
  });

  test('names a reference the target package does not define', async () => {
    fixture({
      'lib/esm/shapes/Thing.js': shapeClass('Thing', {
        shape: "['@test/fixture', 'Nope']",
      }),
      'lib/esm/index.js': "import './shapes/Thing.js';\n",
    });
    const report = await inspectShapeReferences(dir);
    expect(report.unresolved).toEqual([
      expect.objectContaining({
        property: 'ref',
        target: 'missing',
        modules: [path.join('shapes', 'Thing.js')],
      }),
    ]);
  });

  test('stubs asset imports, which a consumer bundler resolves and node cannot', async () => {
    fixture({
      'lib/esm/shapes/Thing.js':
        "import styles from './Thing.module.css';\nexport const cls = styles.root;\n" +
        shapeClass('Thing', {}),
      'lib/esm/shapes/Thing.module.css': '.root { color: red; }\n',
    });
    expect(await checkShapeReferences(dir)).toBe(true);
  });

  test("warns rather than fails for core's known PropertyShape.in -> List", async () => {
    // Loading core's package module registers PropertyShape, whose `in` names
    // List by [package, name]; List is registered only by core's entry.
    fixture({
      'lib/esm/package.js':
        "import { linkedPackage } from '@_linked/core/utils/Package';\nexport const { linkedShape } = linkedPackage('@_linked/core');\n",
      'lib/esm/shapes/Thing.js': shapeClass('Thing', {}),
    });
    const result = await checkShapeReferences(dir);
    expect(typeof result).toBe('string');
    expect(result).toContain(
      'core/PropertyShape.in -> https://linked.cm/shape/core/List',
    );
  });

  test('passes when there is nothing to check', async () => {
    fixture({});
    expect(await checkShapeReferences(dir)).toBe(true);
    fs.rmSync(path.join(dir, 'lib'), {recursive: true});
    expect(await checkShapeReferences(dir)).toBe(true);
  });
});

describe('findShapeModules', () => {
  test('takes all of shapes/ and decorated shapes elsewhere, but not .class, test or other modules', () => {
    fixture({
      'lib/esm/shapes/A.js': 'export {};\n',
      'lib/esm/shapes/A.class.js': 'export {};\n',
      'lib/esm/shapes/A.test.js': 'export {};\n',
      'lib/esm/components/B.js': shapeClass('B', {}),
      'lib/esm/utils/C.js': 'export const c = 1;\n',
    });
    const lib = path.join(dir, 'lib', 'esm');
    expect(findShapeModules(lib).map((f) => path.relative(lib, f))).toEqual([
      path.join('components', 'B.js'),
      path.join('shapes', 'A.js'),
    ]);
  });
});
