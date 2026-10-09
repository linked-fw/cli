// `create-shape`, `create-component`, `create-set-component` and `create-ontology`
// write a file that imports `../package.js`. Where there is no src/package.ts (a
// new app root registers no package) they refuse instead of writing a broken
// import. A linkedApp that does have one, as CN does, is served as before.
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

describe('create-shape and friends need a src/package.ts', () => {
  let app: string;

  beforeEach(() => {
    app = fs.mkdtempSync(path.join(os.tmpdir(), 'linked-app-root-'));
    fs.outputJsonSync(path.join(app, 'package.json'), {name: 'my-app', linkedApp: true});
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
    test(`${command} refuses at a linkedApp root without src/package.ts, and writes nothing`, async () => {
      await expect(run('Thing', app)).rejects.toThrow(CreatePackageError);
      await expect(run('Thing', app)).rejects.toThrow(/inside a package \(packages\/<name>\)/);
      expect(fs.readdirSync(path.join(app, 'src'))).toEqual([]);
    });
  }

  // CN is itself a linkedApp that keeps its shapes at its root, with a real
  // src/package.ts: a linkedApp manifest alone is no reason to refuse.
  test('a linkedApp WITH src/package.ts is allowed (CN keeps its shapes at its root)', async () => {
    fs.outputFileSync(
      path.join(app, 'src', 'package.ts'),
      `export const {linkedShape} = linkedPackage('create-now');\n`,
    );
    await createShape('Thing', app);
    expect(fs.existsSync(path.join(app, 'src', 'shapes', 'thing.ts'))).toBe(true);
  });

  test('create-shape writes the shape in a package', async () => {
    fs.outputJsonSync(path.join(app, 'package.json'), {name: 'my-app-assets', linkedPackage: true});
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
