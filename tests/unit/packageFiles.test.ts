// `buildPackageFiles` is what `create-package` writes, as data. The command
// writes exactly these files, so a host committing a package elsewhere (Create
// Now, through the GitHub API) gets the same package as `linked create-package`.
//
// cli-methods pulls in ora, which is ESM-only.
jest.mock('ora', () => ({__esModule: true, default: () => ({})}));

import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import {createPackage} from '../../src/cli-methods';
import {buildPackageFiles} from '../../src/utils/packageFiles';

// Every file under a folder: relative `/`-path → content.
const files = (root: string): Record<string, string> => {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, {withFileTypes: true})) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else
        out[path.relative(root, full).split(path.sep).join('/')] =
          fs.readFileSync(full, 'utf8');
    }
  };
  walk(root);
  return out;
};

describe('buildPackageFiles', () => {
  let tmp: string;
  let ttyDescriptors: PropertyDescriptor[];

  beforeAll(() => {
    ttyDescriptors = [process.stdin, process.stdout].map(
      (stream) =>
        Object.getOwnPropertyDescriptor(stream, 'isTTY') ?? {
          value: undefined,
          configurable: true,
        },
    );
    for (const stream of [process.stdin, process.stdout]) {
      Object.defineProperty(stream, 'isTTY', {
        value: false,
        configurable: true,
      });
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
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'linked-package-files-'));
  });

  afterEach(() => {
    fs.removeSync(tmp);
  });

  test.each(['ontology', 'assets'] as const)(
    'a %s package: create-package writes exactly these files',
    async (kind) => {
      await createPackage('@acme/lego-planning', undefined, tmp, {
        kind,
        skipInstall: true,
      });
      const name =
        kind === 'ontology'
          ? '@acme/lego-planning-ont'
          : '@acme/lego-planning-assets';
      const written = files(path.join(tmp, name.split('/')[1]));
      expect(buildPackageFiles(name, kind)).toEqual(written);
    },
  );

  test('with an explicit uri_base, as create-package takes it', async () => {
    const uriBase = 'https://acme.id.create.now/ont/planning';
    await createPackage('planning', uriBase, tmp, {
      kind: 'ontology',
      skipInstall: true,
    });
    expect(buildPackageFiles('planning-ont', 'ontology', {uriBase})).toEqual(
      files(path.join(tmp, 'planning-ont')),
    );
  });

  test('inside an app with a root and the pair: baseUri and dependencies cover it', async () => {
    fs.outputJsonSync(path.join(tmp, 'package.json'), {
      name: 'my-app',
      linkedApp: true,
    });
    await createPackage('planning', undefined, tmp, {
      kind: 'both',
      location: 'packages',
      baseUri: 'https://acme.id.create.now',
      skipInstall: true,
    });
    const baseUri = 'https://acme.id.create.now/';
    expect(buildPackageFiles('planning-ont', 'ontology', {baseUri})).toEqual(
      files(path.join(tmp, 'packages', 'planning-ont')),
    );
    expect(
      buildPackageFiles('planning-assets', 'assets', {
        baseUri,
        dependencies: {'planning-ont': '^1.0.0'},
      }),
    ).toEqual(files(path.join(tmp, 'packages', 'planning-assets')));
  });

  test('an ontology package: dotfiles restored, the example ontology named after its slug', () => {
    const out = buildPackageFiles('planning-ont', 'ontology', {
      baseUri: 'https://acme.example/',
    });
    expect(Object.keys(out)).toEqual([
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
    expect(out['src/package.ts']).toContain(
      `linkedPackage('planning-ont', {baseUri: "https://acme.example/"})`,
    );
    expect(out['src/ontologies/planning.ts']).toContain(
      `createNameSpace('https://acme.example/ont/planning/')`,
    );
    for (const [file, content] of Object.entries(out)) {
      expect([file, content]).not.toEqual([
        file,
        expect.stringContaining('${'),
      ]);
    }
  });

  test('dependencies are added to the template manifest, which keeps its own', () => {
    const pkg = JSON.parse(
      buildPackageFiles('planning-assets', 'assets', {
        dependencies: {'planning-ont': '^1.0.0'},
      })['package.json'],
    );
    expect(pkg.name).toBe('planning-assets');
    expect(pkg.dependencies['planning-ont']).toBe('^1.0.0');
    expect(pkg.dependencies['@_linked/core']).toBeDefined();
  });

  test('nothing is written', () => {
    const cwd = process.cwd();
    process.chdir(tmp);
    try {
      buildPackageFiles('planning-ont', 'ontology');
      buildPackageFiles('planning-assets', 'assets');
    } finally {
      process.chdir(cwd);
    }
    expect(fs.readdirSync(tmp)).toEqual([]);
  });
});
