import {execFileSync} from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  collectShapesTurtleInputs,
  generateShapesTurtle,
  SHAPES_TURTLE_PATH,
  writeShapesTurtleStep,
} from '../../src/utils/shapesTurtle';
import {fixtureNodeModules} from '../fixtureNodeModules';

// Each fixture is a compiled package (lib/esm written the way tsc emits it), whose shapes.ttl a
// real `node` child generates with this repository's @_linked/core, as the build step does.

const FX = 'http://example.org/fx#';

const pkgModule = (name: string) =>
  `import { linkedPackage } from '@_linked/core/utils/Package';
export const { linkedShape, linkedOntology, packageName } = linkedPackage('${name}');
`;

// A shape class as tsc emits it.
const shapeClass = (
  name: string,
  {cls, extendsFrom, imports = '', props = []}: {
    cls: string;
    extendsFrom?: string;
    imports?: string;
    props?: {name: string; path: string}[];
  },
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
${props.map((p) => `  get ${p.name}() { return undefined; }`).join('\n')}
};
${name}.targetClass = { id: '${cls}' };
${props
  .map(
    (p) => `__decorate([
    objectProperty({ path: { id: '${p.path}' } })
], ${name}.prototype, "${p.name}", Object.getOwnPropertyDescriptor(${name}.prototype, "${p.name}"));`,
  )
  .join('\n')}
${name} = __decorate([
    linkedShape
], ${name});
export { ${name} };
`;

const animal = shapeClass('Animal', {
  cls: `${FX}Animal`,
  props: [{name: 'owner', path: `${FX}owner`}],
});
const dog = shapeClass('Dog', {
  cls: `${FX}Dog`,
  extendsFrom: 'Animal',
  imports: "import { Animal } from './Animal.js';",
  props: [{name: 'breed', path: `${FX}breed`}],
});

let dir: string;
const write = (file: string, content: string) => {
  const full = path.join(dir, file);
  fs.mkdirSync(path.dirname(full), {recursive: true});
  fs.writeFileSync(full, content);
};

/** The package `@test/fixture`, with `shapes` (name → module source) and an index of them. */
const fixture = ({
  shapes,
  pkgJson = {},
  index = true,
}: {
  shapes: Record<string, string>;
  pkgJson?: object;
  index?: boolean;
}) => {
  write(
    'package.json',
    JSON.stringify({
      name: '@test/fixture',
      version: '1.0.0',
      type: 'module',
      linkedPackage: true,
      main: 'lib/esm/index.js',
      files: ['lib'],
      dependencies: {'@_linked/core': '*'},
      ...pkgJson,
    }),
  );
  write('lib/esm/package.js', pkgModule('@test/fixture'));
  write('lib/esm/index.js', "export * from './package.js';\n");
  for (const [name, source] of Object.entries(shapes)) {
    write(`lib/esm/shapes/${name}.js`, source);
  }
  if (index && Object.keys(shapes).length) {
    write(
      'lib/esm/shapes/index.js',
      Object.keys(shapes)
        .map((name) => `import './${name}.js';`)
        .join('\n') + '\n',
    );
  }
};

const target = () => path.join(dir, SHAPES_TURTLE_PATH);

/** The files `npm pack --dry-run` would put in the tarball. */
const packedFiles = (): string[] => {
  const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: dir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // An array of one entry before npm 11, an object keyed by package name since.
  const parsed = JSON.parse(out);
  const entry = Array.isArray(parsed) ? parsed[0] : Object.values<any>(parsed)[0];
  return entry.files.map((f: {path: string}) => f.path);
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'linked-shapes-turtle-'));
  fixtureNodeModules(dir);
});
afterEach(() => fs.rmSync(dir, {recursive: true, force: true}));

describe('Writing shapes.ttl', () => {
  test("a package with shapes gets lib/esm/data/shapes.ttl, in core's fixed form", async () => {
    fixture({shapes: {Animal: animal, Dog: dog}});
    expect(await writeShapesTurtleStep(dir)).toEqual({info: 'lib/esm/data/shapes.ttl'});
    const text = fs.readFileSync(target(), 'utf8');
    expect(text).toMatch(/^@prefix core: <https:\/\/linked\.cm\/ont\/core\/> \.\n/);
    expect(text.endsWith('\n')).toBe(true);
    const subjects = text
      .split('\n')
      .filter((l) => /^<[^>]+>$/.test(l))
      .map((l) => l.slice(1, -1));
    expect(subjects).toContain('https://linked.cm/shape/fixture/Animal');
    expect(subjects).toContain('https://linked.cm/shape/fixture/Dog');
    expect([...subjects].sort()).toEqual(subjects);
    // Declared shapes: Dog holds its own property shape and the link to Animal, not a copy of owner.
    expect(text).toContain('<https://linked.cm/shape/fixture/Dog/breed>');
    expect(text).not.toContain('<https://linked.cm/shape/fixture/Dog/owner>');
    expect(text).toMatch(/core:isExtending <https:\/\/linked\.cm\/shape\/fixture\/Animal>/);
  });

  test('the same package gives the same bytes on every run', async () => {
    fixture({shapes: {Dog: dog, Animal: animal}});
    await writeShapesTurtleStep(dir);
    const first = fs.readFileSync(target());
    await writeShapesTurtleStep(dir);
    expect(fs.readFileSync(target()).equals(first)).toBe(true);
  });

  test('without shapes/index, every shape module is loaded', async () => {
    fixture({shapes: {Animal: animal, Dog: dog}, index: false});
    const outcome = await generateShapesTurtle(dir);
    expect('turtle' in outcome && outcome.turtle).toContain('<https://linked.cm/shape/fixture/Dog>');
  });

  test('npm pack lists data/shapes.ttl for a package with shapes and omits it without', async () => {
    fixture({shapes: {Animal: animal}});
    await writeShapesTurtleStep(dir);
    expect(packedFiles()).toContain('lib/esm/data/shapes.ttl');

    fs.rmSync(path.join(dir, 'lib', 'esm', 'shapes'), {recursive: true});
    expect(await writeShapesTurtleStep(dir)).toBe(true);
    expect(packedFiles()).not.toContain('lib/esm/data/shapes.ttl');
  }, 60000);

  test('a package with no shapes gets no file, and an earlier one is removed', async () => {
    fixture({shapes: {}});
    write(SHAPES_TURTLE_PATH, 'stale\n');
    expect(collectShapesTurtleInputs(dir)).toEqual({skip: true});
    expect(await writeShapesTurtleStep(dir)).toBe(true);
    expect(fs.existsSync(target())).toBe(false);
  });

  test('shape modules that register nothing for the package give no file', async () => {
    fixture({shapes: {}});
    write('lib/esm/shapes/helpers.js', 'export const x = 1;\n');
    expect(await generateShapesTurtle(dir)).toEqual({turtle: undefined});
    expect(await writeShapesTurtleStep(dir)).toBe(true);
    expect(fs.existsSync(target())).toBe(false);
  });

  test('a package without a @_linked/core dependency is skipped quietly', async () => {
    fixture({shapes: {Animal: animal}, pkgJson: {dependencies: {}}});
    expect(await writeShapesTurtleStep(dir)).toBe(true);
    expect(fs.existsSync(target())).toBe(false);
  });

  test('a core without shapes/shapesToTurtle warns and writes nothing', async () => {
    fixture({shapes: {Animal: animal}});
    // An installed core of its own, older than the generator.
    fs.rmSync(path.join(dir, 'node_modules', '@_linked', 'core'));
    write(
      'node_modules/@_linked/core/package.json',
      JSON.stringify({name: '@_linked/core', version: '2.37.0', type: 'module'}),
    );
    write(SHAPES_TURTLE_PATH, 'stale\n');
    expect(await writeShapesTurtleStep(dir)).toBe(
      'skipped: the @_linked/core this package resolves (2.37.0) has no shapes/shapesToTurtle',
    );
    expect(fs.existsSync(target())).toBe(false);
  });

  test('a shape module that throws fails the step and names it', async () => {
    fixture({shapes: {Animal: animal}});
    write('lib/esm/shapes/Broken.js', "throw new Error('boom');\n");
    write('lib/esm/shapes/index.js', "import './Animal.js';\nimport './Broken.js';\n");
    const result = (await writeShapesTurtleStep(dir)) as {error: string};
    expect(result.error).toMatch(/^loading file:.*shapes\/index\.js: Error: boom/);
    expect(fs.existsSync(target())).toBe(false);
  });
});

describe("core's own shapes.ttl", () => {
  // The core this repository resolves; in a checkout of core its golden file is what
  // `packageShapesTurtle('@_linked/core')` returns in process.
  const resolveCore = () => {
    let from = path.resolve(__dirname, '..', '..');
    for (;;) {
      const candidate = path.join(from, 'node_modules', '@_linked', 'core');
      if (fs.existsSync(path.join(candidate, 'package.json'))) return fs.realpathSync(candidate);
      const parent = path.dirname(from);
      if (parent === from) throw new Error('no @_linked/core');
      from = parent;
    }
  };
  const core = resolveCore();
  const golden = path.join(core, 'src', 'tests', 'fixtures', 'core-shapes.ttl');
  const hasGenerator = fs.existsSync(path.join(core, 'lib', 'esm', 'shapes', 'shapesToTurtle.js'));

  (hasGenerator && fs.existsSync(golden) ? test : test.skip)(
    "is byte-identical to core's in-process generation (its golden file)",
    async () => {
      const outcome = await generateShapesTurtle(core);
      expect('turtle' in outcome).toBe(true);
      expect((outcome as {turtle: string}).turtle).toBe(fs.readFileSync(golden, 'utf8'));
    },
    60000,
  );
});
