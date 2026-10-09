// `create-package` writes an ontology package, an asset package or both. These
// scaffold into a temp directory with the install skipped and prove the tree,
// the package.json and the ontology namespace of each kind.
//
// cli-methods pulls in ora, which is ESM-only.
jest.mock('ora', () => ({__esModule: true, default: () => ({})}));

import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import {createPackage} from '../../src/cli-methods';
import {CreatePackageError} from '../../src/utils/createPackageLocation';

const read = (...parts: string[]) => fs.readFileSync(path.join(...parts), 'utf8');
const exists = (...parts: string[]) => fs.existsSync(path.join(...parts));

// Every file under a folder, relative, sorted: the tree a scaffold wrote.
const tree = (root: string): string[] => {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, {withFileTypes: true})) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else out.push(path.relative(root, full));
    }
  };
  walk(root);
  return out.sort();
};

describe('createPackage kinds', () => {
  let tmp: string;
  let ttyDescriptors: PropertyDescriptor[];

  beforeAll(() => {
    // The tests are scripted calls: no terminal, so nothing is ever prompted.
    ttyDescriptors = [process.stdin, process.stdout].map(
      (stream) => Object.getOwnPropertyDescriptor(stream, 'isTTY') ?? {value: undefined, configurable: true},
    );
    for (const stream of [process.stdin, process.stdout]) {
      Object.defineProperty(stream, 'isTTY', {value: false, configurable: true});
    }
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterAll(() => {
    [process.stdin, process.stdout].forEach((stream, i) =>
      Object.defineProperty(stream, 'isTTY', ttyDescriptors[i]),
    );
    jest.restoreAllMocks();
  });

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'linked-create-package-'));
  });

  afterEach(() => {
    fs.removeSync(tmp);
  });

  test('an ontology package holds one ontology and nothing else', async () => {
    await createPackage('planning', undefined, tmp, {kind: 'ontology', skipInstall: true});
    const pkg = path.join(tmp, 'planning-ont');

    expect(tree(pkg)).toEqual([
      '.gitignore',
      '.npmignore',
      'package.json',
      'src/data/planning.json',
      'src/data/planning.json.d.ts',
      'src/index.ts',
      'src/ontologies/planning.register.ts',
      'src/ontologies/planning.ts',
      'src/package.ts',
      'tsconfig-esm.json',
      'tsconfig.json',
    ]);

    const manifest = JSON.parse(read(pkg, 'package.json'));
    expect(manifest.name).toBe('planning-ont');
    expect(manifest.linkedPackage).toBe(true);
    expect(manifest.files).toEqual(['lib', 'CHANGELOG.md']);

    // The package is `planning-ont`; the ontology slug is `planning`.
    expect(read(pkg, 'src/package.ts')).toContain(`linkedPackage('planning-ont')`);
    expect(read(pkg, 'src/ontologies/planning.ts')).toContain(
      `createNameSpace('https://linked.cm/ont/planning/')`,
    );
    expect(read(pkg, 'src/ontologies/planning.register.ts')).toContain(
      `linkedOntology(terms, ns, 'planning', loadData, '../data/planning.json')`,
    );
    expect(read(pkg, 'src/index.ts')).toContain(`./ontologies/planning.register.js`);
    expect(read(pkg, 'src/index.ts')).not.toContain(`import './shapes`);
    expect(JSON.parse(read(pkg, 'src/data/planning.json'))['@context'].planning).toBe(
      'https://linked.cm/ont/planning/',
    );

    // No `${...}` placeholder survives.
    for (const file of tree(pkg)) {
      expect([file, read(pkg, file)]).not.toEqual([file, expect.stringContaining('${')]);
    }
  });

  test('an explicit uri_base is the ontology namespace, as before', async () => {
    await createPackage('planning', 'https://acme.id.create.now/ont/planning', tmp, {
      kind: 'ontology',
      skipInstall: true,
    });
    expect(read(tmp, 'planning-ont', 'src/ontologies/planning.ts')).toContain(
      `createNameSpace('https://acme.id.create.now/ont/planning/')`,
    );
  });

  test('an asset package holds shapes, components and a backend, and no ontology', async () => {
    await createPackage('planning', undefined, tmp, {kind: 'assets', skipInstall: true});
    const pkg = path.join(tmp, 'planning-assets');

    expect(tree(pkg)).toEqual([
      '.gitignore',
      '.npmignore',
      'package.json',
      'src/backend.ts',
      'src/index.ts',
      'src/package.ts',
      'src/shapes/index.ts',
      'src/types.ts',
      'tsconfig-esm.json',
      'tsconfig.json',
    ]);

    const manifest = JSON.parse(read(pkg, 'package.json'));
    expect(manifest.name).toBe('planning-assets');
    expect(manifest.linkedPackage).toBe(true);
    expect(manifest.files).toEqual(['lib', 'CHANGELOG.md']);

    expect(read(pkg, 'src/package.ts')).toContain(`linkedPackage('planning-assets')`);
    expect(read(pkg, 'src/index.ts')).toContain(`./shapes/index.js`);
    expect(read(pkg, 'src/index.ts')).not.toContain('ontolog');
    expect(read(pkg, 'src/backend.ts')).toContain(`./shapes/index.js`);
    for (const file of tree(pkg)) {
      expect([file, read(pkg, file)]).not.toEqual([file, expect.stringContaining('${')]);
    }
  });

  test('both creates the pair', async () => {
    await createPackage('@acme/planning', undefined, tmp, {kind: 'both', skipInstall: true});
    expect(exists(tmp, 'planning-ont', 'src', 'ontologies', 'planning.ts')).toBe(true);
    expect(exists(tmp, 'planning-assets', 'src', 'shapes', 'index.ts')).toBe(true);
    expect(JSON.parse(read(tmp, 'planning-ont', 'package.json')).name).toBe('@acme/planning-ont');
    expect(JSON.parse(read(tmp, 'planning-assets', 'package.json')).name).toBe(
      '@acme/planning-assets',
    );
  });

  test('a name that already carries the suffix is not doubled', async () => {
    await createPackage('planning-ont', undefined, tmp, {kind: 'ontology', skipInstall: true});
    await createPackage('planning-assets', undefined, tmp, {kind: 'assets', skipInstall: true});
    expect(exists(tmp, 'planning-ont-ont')).toBe(false);
    expect(exists(tmp, 'planning-assets-assets')).toBe(false);
    expect(JSON.parse(read(tmp, 'planning-ont', 'package.json')).name).toBe('planning-ont');
    expect(read(tmp, 'planning-ont', 'src/ontologies/planning.ts')).toContain(
      `createNameSpace('https://linked.cm/ont/planning/')`,
    );
    expect(JSON.parse(read(tmp, 'planning-assets', 'package.json')).name).toBe(
      'planning-assets',
    );
  });

  test('inside an app, --location packages wires the app even when the install is skipped', async () => {
    fs.outputJsonSync(path.join(tmp, 'package.json'), {name: 'my-app', linkedApp: true});
    await createPackage('planning', undefined, tmp, {
      kind: 'both',
      location: 'packages',
      skipInstall: true,
    });
    expect(exists(tmp, 'packages', 'planning-ont', 'src', 'package.ts')).toBe(true);
    expect(exists(tmp, 'packages', 'planning-assets', 'src', 'package.ts')).toBe(true);
    const app = fs.readJsonSync(path.join(tmp, 'package.json'));
    expect(app.workspaces).toEqual(['packages/*']);
    expect(app.dependencies).toEqual({'planning-ont': '^1.0.0', 'planning-assets': '^1.0.0'});
  });

  test('without --kind and without a terminal it refuses and names the flag', async () => {
    await expect(createPackage('planning', undefined, tmp, {skipInstall: true})).rejects.toThrow(
      CreatePackageError,
    );
    await expect(createPackage('planning', undefined, tmp, {skipInstall: true})).rejects.toThrow(
      /--kind ontology/,
    );
    expect(fs.readdirSync(tmp)).toEqual([]);
  });

  test('an unknown --kind is refused before anything is written', async () => {
    await expect(
      createPackage('planning', undefined, tmp, {kind: 'shapes' as any, skipInstall: true}),
    ).rejects.toThrow(/--kind must be one of/);
    expect(fs.readdirSync(tmp)).toEqual([]);
  });
});
