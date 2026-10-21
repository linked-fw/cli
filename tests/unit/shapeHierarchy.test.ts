import fs from 'fs';
import os from 'os';
import path from 'path';

// ora is ESM-only, which Jest's CommonJS loader cannot require.
jest.mock('ora', () => ({__esModule: true, default: () => ({})}));

import {planBuildSteps} from '../../src/cli-methods.js';
import {
  checkShapeHierarchyStep,
  collectShapeCheckInputs,
  runShapeHierarchyCheck,
} from '../../src/utils/shapeHierarchy';
import {fixtureNodeModules} from '../fixtureNodeModules';

// Each fixture is a compiled package (lib/esm written the way tsc emits it, with its Turtle data
// copied beside it), checked by a real `node` child against this repository's @_linked/core,
// exactly as the build step checks a package's output.

const FX = 'http://example.org/fx#';
const DEP = 'http://example.org/dep#';

const pkgModule = (name: string, mirrors?: string) =>
  `import { linkedPackage } from '@_linked/core/utils/Package';
export const { linkedShape, linkedOntology, packageName } = linkedPackage('${name}'${
    mirrors ? `, { mirrors: '${mirrors}' }` : ''
  });
`;

const ontologyModule = (ns: string, prefix: string) =>
  `import { createNameSpace } from '@_linked/core/utils/NameSpace';
import { loadOntologyFiles } from '@_linked/core/ontology/loadOntologyFiles';
export const dataFiles = ['../data/${prefix}.ttl'];
export const loadData = () => loadOntologyFiles(import.meta.url, dataFiles);
export var ns = createNameSpace('${ns}');
export var _self = ns('');
`;

const registerModule = (prefix: string) =>
  `import * as terms from './${prefix}.js';
import { dataFiles, loadData, ns } from './${prefix}.js';
import { linkedOntology } from '../package.js';
linkedOntology(terms, ns, '${prefix}', loadData, dataFiles);
`;

const turtle = (ns: string, prefix: string, body: string) =>
  `@prefix ${prefix}: <${ns}> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .

<${ns}> a owl:Ontology .
${body}
`;

type Prop = {name: string; path: string; cls?: string};

// A shape class as tsc emits it.
const shapeClass = (
  name: string,
  {
    cls,
    extendsFrom,
    imports = '',
    props = [],
    options,
  }: {cls?: string; extendsFrom?: string; imports?: string; props?: Prop[]; options?: string},
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
${cls ? `${name}.targetClass = { id: '${cls}' };` : ''}
${props
  .map(
    (p) => `__decorate([
    objectProperty({ path: { id: '${p.path}' }${p.cls ? `, class: { id: '${p.cls}' }` : ''} })
], ${name}.prototype, "${p.name}", Object.getOwnPropertyDescriptor(${name}.prototype, "${p.name}"));`,
  )
  .join('\n')}
${name} = __decorate([
    linkedShape${options ? `(${options})` : ''}
], ${name});
export { ${name} };
`;

let dir: string;
const write = (file: string, content: string) => {
  const full = path.join(dir, file);
  fs.mkdirSync(path.dirname(full), {recursive: true});
  fs.writeFileSync(full, content);
};

/**
 * The package `@test/fixture` with ontology `fx`: `shapes` (name → module source), `data` (the
 * body of `fx.ttl`), and the package.json fields to merge.
 */
const fixture = ({
  shapes,
  data,
  mirrors,
  pkgJson = {},
}: {
  shapes: Record<string, string>;
  data?: string;
  mirrors?: string;
  pkgJson?: object;
}) => {
  write(
    'package.json',
    JSON.stringify({
      name: '@test/fixture',
      type: 'module',
      linkedPackage: true,
      main: 'lib/esm/index.js',
      dependencies: {'@_linked/core': '*'},
      ...pkgJson,
    }),
  );
  write('lib/esm/package.js', pkgModule('@test/fixture', mirrors));
  for (const [name, source] of Object.entries(shapes)) {
    write(`lib/esm/shapes/${name}.js`, source);
  }
  write(
    'lib/esm/shapes/index.js',
    Object.keys(shapes)
      .map((name) => `import './${name}.js';`)
      .join('\n') + '\n',
  );
  if (data !== undefined) {
    write('lib/esm/ontologies/fx.js', ontologyModule(FX, 'fx'));
    write('lib/esm/ontologies/fx.register.js', registerModule('fx'));
    write('lib/esm/data/fx.ttl', turtle(FX, 'fx', data));
  }
};

/**
 * An installed `@_linked/fixture-dep` with the shape `Animal` (class dep:Animal) and, unless
 * `register` is false, ontology data stating `dep:Dog rdfs:subClassOf dep:Animal`.
 */
const dependency = ({register = true} = {}) => {
  const root = 'node_modules/@_linked/fixture-dep';
  write(
    `${root}/package.json`,
    JSON.stringify({
      name: '@_linked/fixture-dep',
      type: 'module',
      linkedPackage: true,
      main: 'lib/esm/index.js',
      exports: {'./*': './lib/esm/*.js'},
      dependencies: {'@_linked/core': '*'},
    }),
  );
  write(`${root}/lib/esm/package.js`, pkgModule('@_linked/fixture-dep'));
  write(`${root}/lib/esm/shapes/Animal.js`, shapeClass('Animal', {cls: `${DEP}Animal`}));
  write(`${root}/lib/esm/ontologies/dep.js`, ontologyModule(DEP, 'dep'));
  if (register) {
    write(`${root}/lib/esm/ontologies/dep.register.js`, registerModule('dep'));
  }
  write(
    `${root}/lib/esm/data/dep.ttl`,
    turtle(DEP, 'dep', 'dep:Dog rdfs:subClassOf dep:Animal .\n'),
  );
};

const withDependency = {dependencies: {'@_linked/core': '*', '@_linked/fixture-dep': '*'}};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'linked-shape-hierarchy-'));
  fixtureNodeModules(dir);
});
afterEach(() => fs.rmSync(dir, {recursive: true, force: true}));

const findingsOf = async () => {
  const outcome = await runShapeHierarchyCheck(dir);
  if (!('findings' in outcome)) throw new Error('no findings: ' + JSON.stringify(outcome));
  return outcome.findings;
};

const animal = shapeClass('Animal', {cls: `${FX}Animal`});
const dogExtendingAnimal = shapeClass('Dog', {
  cls: `${FX}Dog`,
  extendsFrom: 'Animal',
  imports: "import { Animal } from './Animal.js';",
});

describe('the shape hierarchy check, one fixture per finding kind', () => {
  test('a package whose shapes agree with its data passes', async () => {
    fixture({
      shapes: {Animal: animal, Dog: dogExtendingAnimal},
      data: 'fx:Dog rdfs:subClassOf fx:Animal .\n',
    });
    expect(await findingsOf()).toEqual([]);
    expect(await checkShapeHierarchyStep(dir)).toBe(true);
  });

  test('extends-without-subclass: an extends the data does not back fails the build', async () => {
    fixture({shapes: {Animal: animal, Dog: dogExtendingAnimal}, data: ''});
    expect(await findingsOf()).toEqual([
      expect.objectContaining({
        kind: 'extends-without-subclass',
        severity: 'error',
        shape: 'https://linked.cm/shape/fixture/Dog',
        iri: `${FX}Dog`,
      }),
    ]);
    const result = (await checkShapeHierarchyStep(dir)) as {error: string};
    expect(result.error).toMatch(/^1 error:\n {2}error extends-without-subclass fixture\/Dog: Dog extends Animal/);
  });

  test('subclass-without-extends: a subclass whose shape does not extend its superclass shape', async () => {
    fixture({
      shapes: {Animal: animal, Dog: shapeClass('Dog', {cls: `${FX}Dog`})},
      data: 'fx:Dog rdfs:subClassOf fx:Animal .\n',
    });
    expect(await findingsOf()).toEqual([
      expect.objectContaining({
        kind: 'subclass-without-extends',
        severity: 'error',
        shape: 'https://linked.cm/shape/fixture/Dog',
        iri: `${FX}Animal`,
      }),
    ]);
    expect(await checkShapeHierarchyStep(dir)).toEqual({error: expect.any(String)});
  });

  test('borrowed-target-class: a shape that inherits its parent class', async () => {
    fixture({
      shapes: {
        Animal: animal,
        Pet: shapeClass('Pet', {
          extendsFrom: 'Animal',
          imports: "import { Animal } from './Animal.js';",
        }),
      },
      data: '',
    });
    expect(await findingsOf()).toEqual([
      expect.objectContaining({
        kind: 'borrowed-target-class',
        severity: 'error',
        shape: 'https://linked.cm/shape/fixture/Pet',
      }),
    ]);
  });

  test('borrowed-target-class: sharedTargetClass exempts the shape', async () => {
    fixture({
      shapes: {
        Animal: animal,
        Pet: shapeClass('Pet', {
          extendsFrom: 'Animal',
          imports: "import { Animal } from './Animal.js';",
          options: '{sharedTargetClass: true}',
        }),
      },
      data: '',
    });
    expect(await findingsOf()).toEqual([]);
  });

  test('mirror-undefined-term: a mirror package uses a term its data does not define', async () => {
    fixture({
      mirrors: FX,
      shapes: {
        Dog: shapeClass('Dog', {
          cls: `${FX}Dog`,
          props: [{name: 'friend', path: `${FX}friend`}],
        }),
      },
      data: 'fx:Dog a rdfs:Class .\n',
    });
    expect(await findingsOf()).toEqual([
      expect.objectContaining({
        kind: 'mirror-undefined-term',
        severity: 'error',
        shape: 'https://linked.cm/shape/fixture/Dog',
        iri: `${FX}friend`,
      }),
    ]);
  });

  test('override-not-tightened: a widening override warns and the build passes', async () => {
    fixture({
      shapes: {
        Shelter: shapeClass('Shelter', {
          cls: `${FX}Shelter`,
          props: [{name: 'resident', path: `${FX}resident`, cls: `${FX}Animal`}],
        }),
        Garage: shapeClass('Garage', {
          cls: `${FX}Garage`,
          extendsFrom: 'Shelter',
          imports: "import { Shelter } from './Shelter.js';",
          props: [{name: 'resident', path: `${FX}resident`, cls: `${FX}Vehicle`}],
        }),
      },
      data: 'fx:Garage rdfs:subClassOf fx:Shelter .\n',
    });
    expect(await findingsOf()).toEqual([
      expect.objectContaining({
        kind: 'override-not-tightened',
        severity: 'warning',
        shape: 'https://linked.cm/shape/fixture/Garage',
      }),
    ]);
    const result = await checkShapeHierarchyStep(dir);
    expect(typeof result).toBe('string');
    expect(result).toMatch(/^1 warning:\n {2}warning override-not-tightened fixture\/Garage: /);
  });
});

describe("the dependencies' ontology data and scope", () => {
  // Hound extends the dependency's Animal; only the dependency's data states dep:Dog ⊑ dep:Animal.
  const hound = () =>
    fixture({
      pkgJson: withDependency,
      shapes: {
        Hound: shapeClass('Hound', {
          cls: `${FX}Hound`,
          extendsFrom: 'Animal',
          imports: "import { Animal } from '@_linked/fixture-dep/shapes/Animal';",
        }),
      },
      data: 'fx:Hound rdfs:subClassOf <http://example.org/dep#Dog> .\n',
    });

  test("a dependency's register module is loaded, so its data backs an extends", async () => {
    dependency();
    hound();
    expect(collectShapeCheckInputs(dir)).toMatchObject({
      packageDirs: expect.arrayContaining([
        fs.realpathSync(dir),
        fs.realpathSync(path.join(dir, 'node_modules/@_linked/fixture-dep')),
      ]),
      expectRegistered: ['@test/fixture', '@_linked/fixture-dep'],
      dependencies: {
        '@test/fixture': ['@_linked/core', '@_linked/fixture-dep'],
        '@_linked/fixture-dep': ['@_linked/core'],
      },
    });
    expect(await findingsOf()).toEqual([]);
  });

  test("without the dependency's data the same extends fails", async () => {
    dependency({register: false});
    hound();
    expect((await findingsOf()).map((f) => f.kind)).toEqual(['extends-without-subclass']);
  });

  // Dog ⊑ dep:Animal in the package's own data; Dog does not extend the dependency's Animal.
  const dog = (pkgJson: object) =>
    fixture({
      pkgJson,
      shapes: {
        Dog: shapeClass('Dog', {
          cls: `${FX}Dog`,
          imports: "import '@_linked/fixture-dep/shapes/Animal';",
        }),
      },
      data: 'fx:Dog rdfs:subClassOf <http://example.org/dep#Animal> .\n',
    });

  test('a superclass shape in a dependency is in scope: an error', async () => {
    dependency();
    dog(withDependency);
    expect(await findingsOf()).toEqual([
      expect.objectContaining({kind: 'subclass-without-extends', severity: 'error'}),
    ]);
  });

  test('a superclass shape in a package that is not a dependency is out of scope: a warning', async () => {
    dependency();
    dog({});
    expect(await findingsOf()).toEqual([
      expect.objectContaining({kind: 'subclass-without-extends', severity: 'warning'}),
    ]);
  });
});

describe('skipping', () => {
  test('a package without shapes passes quietly', async () => {
    write('package.json', JSON.stringify({name: '@test/none', dependencies: {'@_linked/core': '*'}}));
    write('lib/esm/index.js', 'export {};\n');
    expect(await checkShapeHierarchyStep(dir)).toBe(true);
  });

  test('a package without a core dependency passes quietly', async () => {
    fixture({shapes: {Animal: animal, Dog: dogExtendingAnimal}, data: '', pkgJson: {dependencies: {}}});
    expect(await runShapeHierarchyCheck(dir)).toEqual({skip: true});
    expect(await checkShapeHierarchyStep(dir)).toBe(true);
  });

  test('a core without the check warns and skips', async () => {
    fixture({shapes: {Animal: animal, Dog: dogExtendingAnimal}, data: ''});
    const core = path.join(dir, 'node_modules', '@_linked', 'core');
    fs.unlinkSync(core);
    write('node_modules/@_linked/core/package.json', JSON.stringify({name: '@_linked/core', version: '2.0.0'}));
    expect(await checkShapeHierarchyStep(dir)).toBe(
      'skipped: the @_linked/core this package resolves (2.0.0) has no shapes/checkShapeHierarchy',
    );
  });

  test('--skip-shape-check prints the reason and does not run the check', async () => {
    fixture({shapes: {Animal: animal, Dog: dogExtendingAnimal}, data: ''});
    expect(await checkShapeHierarchyStep(dir, {skip: 'pending the data fix'})).toBe(
      'skipped: pending the data fix',
    );
    const step = planBuildSteps({}, dir, {skipShapeCheck: 'pending the data fix'}).find(
      (s) => s.name === 'Checking shape hierarchy',
    )!;
    expect(await step.apply()).toBe('skipped: pending the data fix');
  });

  test('a register module that throws fails the step and quotes the warning', async () => {
    fixture({shapes: {Animal: animal}, data: ''});
    write('lib/esm/ontologies/fx.register.js', "throw new Error('register boom');\n");
    const result = (await checkShapeHierarchyStep(dir)) as {error: string};
    expect(result.error).toMatch(/the ontology register modules of @test\/fixture threw/);
    expect(result.error).toMatch(/register boom/);
  });

  test('a module that throws while loading fails the step and names it', async () => {
    fixture({
      shapes: {Animal: animal, Broken: "throw new Error('boom');\n"},
      data: '',
    });
    const result = (await checkShapeHierarchyStep(dir)) as {error: string};
    expect(result.error).toMatch(/boom/);
  });
});
