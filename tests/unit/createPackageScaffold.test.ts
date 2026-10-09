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
    for (const pkg of ['planning-ont', 'planning-assets']) {
      expect([pkg, JSON.parse(read(tmp, pkg, 'package.json')).linkedPackage]).toEqual([pkg, true]);
    }
  });

  // The asset package of a pair depends on its ontology package only where npm
  // workspaces link the two: anywhere else `npm install` would look the
  // unpublished `-ont` package up in the registry and fail with E404.
  describe('the dependency of --kind both on its ontology package', () => {
    const logged = () => (console.log as jest.Mock).mock.calls.map((c) => c.join(' ')).join('\n');
    beforeEach(() => (console.log as jest.Mock).mockClear());

    test('--location packages: the asset package depends on the ontology package', async () => {
      fs.outputJsonSync(path.join(tmp, 'package.json'), {name: 'my-app', linkedApp: true});
      await createPackage('@acme/planning', undefined, tmp, {
        kind: 'both',
        location: 'packages',
        skipInstall: true,
      });
      const ont = JSON.parse(read(tmp, 'packages', 'planning-ont', 'package.json'));
      const assets = JSON.parse(read(tmp, 'packages', 'planning-assets', 'package.json'));
      expect(assets.dependencies['@acme/planning-ont']).toBe(`^${ont.version}`);
      expect(assets.devDependencies?.['@acme/planning-ont']).toBeUndefined();
      expect(assets.peerDependencies?.['@acme/planning-ont']).toBeUndefined();
      // The dependency runs one way: the ontology package depends on no asset package.
      expect(ont.dependencies['@acme/planning-assets']).toBeUndefined();
      expect(logged()).not.toMatch(/npm install @acme\/planning-ont/);
    });

    test('--location packages-local: no dependency, and one line says how to add it', async () => {
      fs.outputJsonSync(path.join(tmp, 'package.json'), {name: 'my-app', linkedApp: true});
      await createPackage('@acme/planning', undefined, tmp, {
        kind: 'both',
        location: 'packages-local',
        skipInstall: true,
      });
      const assetsDir = fs
        .readdirSync(path.join(tmp, 'packages-local'))
        .find((d) => d.endsWith('planning-assets'));
      const assets = JSON.parse(read(tmp, 'packages-local', assetsDir, 'package.json'));
      expect(assets.dependencies['@acme/planning-ont']).toBeUndefined();
      expect(logged()).toMatch(/once @acme\/planning-ont is published.*npm install @acme\/planning-ont/);
    });

    test('standalone: no dependency, and one line says how to add it', async () => {
      await createPackage('@acme/planning', undefined, tmp, {kind: 'both', skipInstall: true});
      const assets = JSON.parse(read(tmp, 'planning-assets', 'package.json'));
      expect(assets.dependencies['@acme/planning-ont']).toBeUndefined();
      expect(logged()).toMatch(/once @acme\/planning-ont is published.*npm install @acme\/planning-ont/);
    });
  });

  test('an asset package created on its own depends on no ontology package', async () => {
    await createPackage('planning', undefined, tmp, {kind: 'assets', skipInstall: true});
    const assets = JSON.parse(read(tmp, 'planning-assets', 'package.json'));
    expect(Object.keys(assets.dependencies).filter((d) => d.endsWith('-ont'))).toEqual([]);
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
    for (const pkg of ['planning-ont', 'planning-assets']) {
      expect([pkg, JSON.parse(read(tmp, pkg, 'package.json')).linkedPackage]).toEqual([pkg, true]);
    }
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

  // A package created inside an app mints under the app's root, not linked.cm.
  describe('the base URI of a package created inside an app', () => {
    const savedEnv = process.env.LINKED_BASE_URI;
    let warn: jest.SpyInstance;
    beforeEach(() => {
      delete process.env.LINKED_BASE_URI;
      fs.outputJsonSync(path.join(tmp, 'package.json'), {name: 'my-app', linkedApp: true});
      warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      (console.log as jest.Mock).mockClear();
    });
    afterEach(() => {
      if (savedEnv === undefined) delete process.env.LINKED_BASE_URI;
      else process.env.LINKED_BASE_URI = savedEnv;
      warn.mockRestore();
    });
    const logged = () =>
      [...(console.log as jest.Mock).mock.calls, ...warn.mock.calls].map((c) => c.join(' ')).join('\n');

    test("comes from the app's .env and is declared in src/package.ts", async () => {
      fs.writeFileSync(path.join(tmp, '.env'), 'LINKED_BASE_URI=https://acme.id.create.now\n');
      await createPackage('planning', undefined, tmp, {
        kind: 'both',
        location: 'packages',
        skipInstall: true,
      });
      const ont = path.join(tmp, 'packages', 'planning-ont');
      const assets = path.join(tmp, 'packages', 'planning-assets');
      expect(read(assets, 'src/package.ts')).toContain(
        `linkedPackage('planning-assets', {baseUri: "https://acme.id.create.now/"})`,
      );
      expect(read(ont, 'src/package.ts')).toContain(
        `linkedPackage('planning-ont', {baseUri: "https://acme.id.create.now/"})`,
      );
      // The ontology's terms mint {baseUri}ont/{ontologySlug}/{Term}.
      expect(read(ont, 'src/ontologies/planning.ts')).toContain(
        `createNameSpace('https://acme.id.create.now/ont/planning/')`,
      );
      for (const pkg of [ont, assets]) {
        expect([pkg, fs.readJsonSync(path.join(pkg, 'package.json')).linkedPackage]).toEqual([pkg, true]);
      }
      expect(logged()).toMatch(/https:\/\/acme\.id\.create\.now\/ \(from \.env\)/);
    });

    test('--base-uri wins over the env file', async () => {
      fs.writeFileSync(path.join(tmp, '.env'), 'LINKED_BASE_URI=https://env.example.org/\n');
      await createPackage('planning', undefined, tmp, {
        kind: 'assets',
        location: 'packages',
        skipInstall: true,
        baseUri: 'https://flag.example.org',
      });
      expect(read(tmp, 'packages', 'planning-assets', 'src/package.ts')).toContain(
        `{baseUri: "https://flag.example.org/"}`,
      );
    });

    test('without a source there is no baseUri, no warning, and one line says where it mints', async () => {
      await createPackage('planning', undefined, tmp, {
        kind: 'assets',
        location: 'packages',
        skipInstall: true,
      });
      expect(read(tmp, 'packages', 'planning-assets', 'src/package.ts')).toContain(
        `linkedPackage('planning-assets')`,
      );
      expect(warn).not.toHaveBeenCalled();
      expect(logged()).not.toMatch(/No base URI/);
      expect(logged()).toContain(
        'Shapes and terms in planning-assets mint under https://linked.cm/. ' +
          'They resolve once the package is published (npx linked publish, coming soon).',
      );
    });

    test('a malformed root is refused before anything is written', async () => {
      await expect(
        createPackage('planning', undefined, tmp, {
          kind: 'assets',
          location: 'packages',
          skipInstall: true,
          baseUri: 'not-a-uri',
        }),
      ).rejects.toThrow(/--base-uri must be an absolute/);
      expect(exists(tmp, 'packages')).toBe(false);
    });
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
