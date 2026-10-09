// `create-shape`, `create-component`, `create-set-component` and `create-ontology`
// write a file that imports `../package.js`. An app root registers no package
// (it is a linkedApp, not a linkedPackage), so there they refuse instead of
// writing a broken import.
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

describe('create-shape and friends at an app root', () => {
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
    test(`${command} refuses where there is no src/package.ts, and writes nothing`, async () => {
      await expect(run('Thing', app)).rejects.toThrow(CreatePackageError);
      await expect(run('Thing', app)).rejects.toThrow(/inside a package \(packages\/<name>\)/);
      expect(fs.readdirSync(path.join(app, 'src'))).toEqual([]);
    });
  }

  test('an app is refused by its manifest, even when a template clone still has src/package.ts', async () => {
    fs.outputFileSync(
      path.join(app, 'src', 'package.ts'),
      `export const {linkedShape} = linkedPackage('app');\n`,
    );
    await expect(createShape('Thing', app)).rejects.toThrow(/is a linked app, not a package/);
    expect(fs.existsSync(path.join(app, 'src', 'shapes'))).toBe(false);
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
  });
});
