// `create-shape`, `create-component`, `create-set-component` and `create-ontology`
// write a file that imports `../package.js`. Where there is no src/package.ts (a
// new app root registers no package) they refuse instead of writing a broken
// import. An app that does have one, as some hosts do, is served as before.
//
// cli-methods pulls in ora, which is ESM-only.
jest.mock('ora', () => ({__esModule: true, default: () => ({})}));

import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import {
  createComponent,
  createOntology,
  createSetComponent,
  createShape,
} from '../../src/cli-methods';
import {CreatePackageError} from '../../src/utils/createPackageLocation';
import {staleOntologyModules} from '../../src/utils/generateOntology';

describe('create-shape and friends need a src/package.ts', () => {
  let app: string;

  beforeEach(() => {
    app = fs.mkdtempSync(path.join(os.tmpdir(), 'linked-app-root-'));
    fs.outputJsonSync(path.join(app, 'package.json'), {name: 'my-app', linked: {kind: 'app'}});
    fs.ensureDirSync(path.join(app, 'src'));
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    fs.removeSync(app);
    jest.restoreAllMocks();
  });

  const commands: Array<[string, (name: string, basePath: string) => Promise<unknown>]> = [
    ['create-shape', (name, basePath) => createShape(name, basePath)],
    ['create-component', (name, basePath) => createComponent(name, basePath)],
    ['create-set-component', (name, basePath) => createSetComponent(name, basePath)],
    ['create-ontology', (name, basePath) => createOntology(name, undefined, basePath)],
  ];

  for (const [command, run] of commands) {
    test(`${command} refuses at an app root without src/package.ts, and writes nothing`, async () => {
      await expect(run('Thing', app)).rejects.toThrow(CreatePackageError);
      await expect(run('Thing', app)).rejects.toThrow(/inside a package \(packages\/<name>\)/);
      expect(fs.readdirSync(path.join(app, 'src'))).toEqual([]);
    });
  }

  // A host app can keep its shapes at its root, with a real
  // src/package.ts: an app manifest alone is no reason to refuse.
  test('an app WITH src/package.ts is allowed (a host app keeping its shapes at its root)', async () => {
    fs.outputFileSync(
      path.join(app, 'src', 'package.ts'),
      `export const {linkedShape} = linkedPackage('my-app');\n`,
    );
    await createShape('Thing', app);
    expect(fs.existsSync(path.join(app, 'src', 'shapes', 'thing.ts'))).toBe(true);
  });

  test('create-ontology writes the ontology with its Turtle data in a package', async () => {
    fs.outputJsonSync(path.join(app, 'package.json'), {name: 'my-app-ont', linked: {kind: 'ontology'}});
    fs.outputFileSync(
      path.join(app, 'src', 'package.ts'),
      `export const {registerOntologies} = linkedPackage('my-app-ont');\n`,
    );
    fs.outputFileSync(path.join(app, 'src', 'index.ts'), '');
    // The index import is added relative to the working directory.
    jest.spyOn(process, 'cwd').mockReturnValue(app);
    await createOntology('planning', undefined, app);

    const read = (rel: string) => fs.readFileSync(path.join(app, 'src', rel), 'utf8');
    expect(fs.readdirSync(path.join(app, 'src', 'data'))).toEqual(['planning.ttl']);
    expect(read('data/planning.ttl')).toContain(
      '<https://linked.cm/ont/planning/> a owl:Ontology ;\n    vann:preferredNamespacePrefix "planning" ;\n    vann:preferredNamespaceUri "https://linked.cm/ont/planning/" .',
    );
    expect(read('ontologies/index.ts')).toContain(
      `      name: 'planning',\n      namespace: 'https://linked.cm/ont/planning/',\n      terms: planning,\n      data: ['../data/planning.ttl'],\n      suggestedPrefix: 'planning',`,
    );
    expect(read('index.ts')).toBe(`import './ontologies/index.js';\n`);
    expect(fs.readJsonSync(path.join(app, 'package.json')).linkedOntologies).toEqual({
      planning: {namespace: 'https://linked.cm/ont/planning/'},
    });
    // What generate-ontology writes for that data: the first build finds them current.
    expect(await staleOntologyModules(app)).toEqual([]);
    for (const rel of [
      'data/planning.ttl',
      'ontologies/planning.ts',
      'ontologies/index.ts',
    ]) {
      expect([rel, read(rel)]).not.toEqual([rel, expect.stringContaining('${')]);
    }
  });

  test('create-ontology refuses a slug Turtle cannot use before writing anything', async () => {
    fs.outputJsonSync(path.join(app, 'package.json'), {name: 'my-app-ont', linked: {kind: 'ontology'}});
    fs.outputFileSync(
      path.join(app, 'src', 'package.ts'),
      `export const {registerOntologies} = linkedPackage('my-app-ont');\n`,
    );
    jest.spyOn(process, 'cwd').mockReturnValue(app);
    await expect(createOntology('3d', undefined, app)).rejects.toThrow(/start with a lowercase letter/);
    expect(fs.existsSync(path.join(app, 'src', 'data'))).toBe(false);
    expect(fs.readJsonSync(path.join(app, 'package.json')).linkedOntologies).toBeUndefined();
  });

  test('create-shape writes the shape in a package', async () => {
    fs.outputJsonSync(path.join(app, 'package.json'), {name: 'my-app-assets', linked: {kind: 'assets'}});
    fs.outputFileSync(
      path.join(app, 'src', 'package.ts'),
      `export const {linkedShape} = linkedPackage('my-app-assets');\n`,
    );
    await createShape('Thing', app);
    expect(fs.existsSync(path.join(app, 'src', 'shapes', 'thing.ts'))).toBe(true);
    expect(fs.readFileSync(path.join(app, 'src', 'shapes', 'index.ts'), 'utf8')).toContain(
      './thing.js',
    );
    // The template compiles against core: core exports no `NamedNode` (TS2305), so the
    // shape must not import one. It is the getter-only form.
    const shape = fs.readFileSync(path.join(app, 'src', 'shapes', 'thing.ts'), 'utf8');
    expect(shape).not.toMatch(/NamedNode/);
    expect(shape).toContain(`import {Shape} from '@_linked/core/shapes/Shape';`);
    expect(shape).toContain(`import {linkedShape} from '../package.js';`);
    expect(shape).toMatch(/@linkedShape\s+export class Thing extends Shape/);
    expect(shape).not.toContain('${');
  });
});
