// `linked generate-ontology`: an ontology package's accessor modules generated from its Turtle,
// and the `linked build` step that fails when the committed modules are stale.
import fs from 'fs-extra';
import os from 'os';
import path from 'path';

// ora is ESM-only, which Jest's CommonJS loader cannot require.
jest.mock('ora', () => ({__esModule: true, default: () => ({})}));

import {
  findOntologyNameCollisions,
  generateOntologyModules,
  generateOntologyTermsModule,
  ontologyIdentifier,
  OntologyNameCollisionError,
  ontologyTermDoc,
} from '../../src/utils/ontologyModules.js';
import {
  ontologyIriOf,
  ontologyTermsFromQuads,
  ontologyTermsFromTurtle,
} from '../../src/utils/ontologyTerms.js';
import {
  checkOntologyModulesStep,
  generatePackageOntologies,
  readOntologyConfigs,
  staleOntologyModules,
  writePackageOntologies,
} from '../../src/utils/generateOntology.js';
import {planBuildSteps} from '../../src/cli-methods.js';

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'ontology-generator');

describe('the identifier rule', () => {
  test.each([
    ['Person', 'Person'],
    ['givenName', 'givenName'],
    ['account_of', 'account_of'],
    // a reserved word gets a trailing _
    ['default', 'default_'],
    ['yield', 'yield_'],
    ['class', 'class_'],
    ['eval', 'eval_'],
    // bound by a CommonJS build, or overwritten by core's linkedOntology
    ['__esModule', '__esModule_'],
    ['exports', 'exports_'],
    ['require', 'require_'],
    ['module', 'module_'],
    ['_data', '_data_'],
    ['_ns', '_ns_'],
    ['null', 'null_'],
    // a leading digit gets a leading _
    ['3DModel', '_3DModel'],
    ['1', '_1'],
    // any other invalid character becomes _
    ['ISO639-2', 'ISO639_2'],
    ['odd-name.x', 'odd_name_x'],
    ['-lead', '_lead'],
    ['a b', 'a_b'],
    // valid identifier characters are kept, ASCII or not
    ['café', 'café'],
    ['$ref', '$ref'],
    // not reserved: valid binding names
    ['type', 'type'],
    ['undefined', 'undefined'],
  ])('%s → %s', (localName, name) => {
    expect(ontologyIdentifier(localName)).toBe(name);
  });

  test('collisions are what the rule maps together', () => {
    expect(
      findOntologyNameCollisions([
        'a-b',
        'a_b',
        'a.b',
        'c',
        'default',
        'default_',
      ]),
    ).toEqual([
      {name: 'a_b', localNames: ['a-b', 'a.b', 'a_b']},
      {name: 'default_', localNames: ['default', 'default_']},
    ]);
    expect(findOntologyNameCollisions(['Person', 'person'])).toEqual([]);
  });

  test('the generator refuses a collision instead of renaming', () => {
    expect(() =>
      generateOntologyTermsModule({
        prefix: 'ex',
        namespace: 'https://example.test/ex/',
        dataFiles: ['../data/ex.ttl'],
        terms: [{localName: 'a-b'}, {localName: 'a_b'}],
      }),
    ).toThrow(OntologyNameCollisionError);
  });
});

describe('the doc line', () => {
  const doc = (comment?: string, label?: string, localName = 'Term') =>
    ontologyTermDoc({localName, comment, label});

  test('the comment, else the label; nothing when it only repeats the name', () => {
    expect(doc('A comment.', 'A label')).toBe('A comment.');
    expect(doc(undefined, 'A label')).toBe('A label');
    expect(doc(undefined, 'Term')).toBeUndefined();
    expect(doc(undefined, undefined)).toBeUndefined();
  });

  test('markup is dropped, the first sentence kept, and the result is safe in a comment', () => {
    expect(
      doc(
        'A <a href="x">link</a> to [[Thing]] and [docs](https://x.test). Second.',
      ),
    ).toBe('A link to Thing and docs.');
    expect(doc('Ends */ early, e.g. here. Then more.')).toBe(
      'Ends *\\/ early, e.g. here.',
    );
    expect(doc('@deprecated text')).toBe('\\@deprecated text');
    expect(doc('line\\nbreak\nand separator')).toBe('line break and separator');
  });

  test('a cut never splits a surrogate pair, and lone surrogates are replaced', () => {
    const text = doc('中'.repeat(159) + '\u{20000}\u{20000}\u{20000}')!;
    expect(text).toBe('中'.repeat(159) + '\u{20000}…');
    expect(doc('a\uD840b')).toBe('a\uFFFDb');
  });

  test('a module with no terms imports nothing and is still a module', () => {
    const module = generateOntologyTermsModule({
      prefix: 'ex',
      namespace: 'https://example.test/ex/',
      dataFiles: ['../data/ex.ttl'],
      terms: [],
    });
    expect(module).not.toMatch(/import/);
    // `import * as terms` from the register module needs a module (TS2306 otherwise).
    expect(module).toMatch(/^export \{\};$/m);
  });

  test('a long text is cut on a word boundary at 160 characters', () => {
    const text = doc('word '.repeat(60));
    expect(text!.length).toBeLessThanOrEqual(161);
    expect(text!.endsWith('word…')).toBe(true);
  });
});

describe('the modules', () => {
  test('the fixture package: golden output for two namespaces', async () => {
    const generations = await generatePackageOntologies(FIXTURE);
    expect(
      generations.map((g) => [g.config.prefix, g.termCount, g.skipped]),
    ).toEqual([
      ['ex', 8, ['https://example.test/ex/sub/Deeper']],
      ['other', 2, []],
    ]);
    const files = Object.assign({}, ...generations.map((g) => g.files));
    expect(Object.keys(files).sort()).toEqual([
      'src/ontologies/ex.data.ts',
      'src/ontologies/ex.register.ts',
      'src/ontologies/ex.ts',
      'src/ontologies/other.data.ts',
      'src/ontologies/other.register.ts',
      'src/ontologies/other.ts',
    ]);
    for (const [file, content] of Object.entries(files)) {
      expect(content).toBe(fs.readFileSync(path.join(FIXTURE, file), 'utf8'));
    }
    // Each namespace has only its own terms.
    expect(files['src/ontologies/other.ts']).not.toMatch(/Thing/);
    expect(files['src/ontologies/ex.ts']).not.toMatch(/Elsewhere/);
  });

  test('the terms module holds the terms only, sorted, each pure', async () => {
    const terms = fs.readFileSync(
      path.join(FIXTURE, 'src/ontologies/ex.ts'),
      'utf8',
    );
    const exports = [
      ...terms.matchAll(
        /^export const (\S+) = \/\*#__PURE__\*\/ ns_\('([^']+)'\);$/gm,
      ),
    ];
    expect(exports.map((m) => m[1])).toEqual([
      'Added',
      'Thing',
      'Widget',
      '_3DModel',
      'default_',
      'longComment',
      'ns',
      'odd_name_x',
    ]);
    // Every export is a term; the only import is the namespace function, renamed past the term `ns`.
    expect(terms.match(/^export /gm)).toHaveLength(exports.length);
    expect(terms).toMatch(/^import \{ns as ns_\} from '\.\/ex\.data\.js';$/m);
    expect(terms.match(/^import /gm)).toHaveLength(1);
  });

  test('the same input gives the same bytes, in any order', () => {
    const spec = (terms: {localName: string; comment?: string}[]) => ({
      prefix: 'ex',
      namespace: 'https://example.test/ex/',
      dataFiles: ['../data/ex.ttl'],
      terms,
    });
    const a = [
      {localName: 'b', comment: 'B.'},
      {localName: 'a'},
      {localName: 'C'},
      {localName: 'b', comment: 'Another B.'},
    ];
    expect(generateOntologyModules(spec(a))).toEqual(
      generateOntologyModules(spec([...a].reverse())),
    );
  });

  test('labels: English first, then no language, then by language tag', async () => {
    const ttl = (literals: string) => ({
      name: 't.ttl',
      text: `<https://example.test/ex/T> <http://www.w3.org/2000/01/rdf-schema#label> ${literals} .`,
    });
    const label = async (literals: string) =>
      (
        await ontologyTermsFromTurtle(
          [ttl(literals)],
          'https://example.test/ex/',
        )
      ).terms[0].label;
    expect(await label(`"Ding"@de, "Thing"@en, "Plain"`)).toBe('Thing');
    expect(await label(`"Ding"@de, "Plain"`)).toBe('Plain');
    expect(await label(`"Chose"@fr, "Ding"@de`)).toBe('Ding'); // then by language tag
  });

  test('a browser passes its own Parser; the selection is the same pure function', async () => {
    const quads = [
      {
        subject: {termType: 'NamedNode', value: 'https://example.test/ex/T'},
        predicate: {
          termType: 'NamedNode',
          value: 'http://www.w3.org/2000/01/rdf-schema#label',
        },
        object: {termType: 'Literal', value: 'T label', language: ''},
      },
    ];
    class Parser {
      parse() {
        return quads;
      }
    }
    const viaParser = await ontologyTermsFromTurtle(
      [{name: 'x', text: ''}],
      'https://example.test/ex/',
      {Parser},
    );
    expect(viaParser).toEqual(
      ontologyTermsFromQuads(quads, 'https://example.test/ex/'),
    );
    expect(viaParser.terms).toEqual([{localName: 'T', label: 'T label'}]);
  });

  test('_ontologyResource is the IRI the data declares with owl:Ontology', async () => {
    const [ex, other] = await generatePackageOntologies(FIXTURE);
    expect(ex.files['src/ontologies/ex.data.ts']).toContain(
      "export const _ontologyResource = ns('');",
    );
    expect(other.files['src/ontologies/other.data.ts']).toContain(
      "export const _ontologyResource = {id: 'https://example.test/other'};",
    );
    const ns = 'http://www.w3.org/2002/07/owl#';
    expect(ontologyIriOf([ns, 'http://www.w3.org/2002/07/owl'], ns)).toBe(ns);
    expect(ontologyIriOf(['http://www.w3.org/2002/07/owl'], ns)).toBe(
      'http://www.w3.org/2002/07/owl',
    );
    // A declaration the namespace starts with; never an unrelated one (another vocabulary's).
    expect(ontologyIriOf(['https://x.test/onto'], 'https://x.test/onto/terms#')).toBe(
      'https://x.test/onto',
    );
    expect(ontologyIriOf(['http://purl.org/dc/terms/'], ns)).toBeUndefined();
    expect(ontologyIriOf(['urn:x:'], 'urn:x:')).toBe('urn:x:');
    expect(ontologyIriOf(['https://x.test/a', 'https://x.test/b'], ns)).toBeUndefined();
    expect(ontologyIriOf([], ns)).toBeUndefined();
    // Without a declaration the data module keeps the namespace.
    expect(
      generateOntologyModules({prefix: 'p', namespace: ns, dataFiles: [], terms: []})[
        'src/ontologies/p.data.ts'
      ],
    ).toContain("export const _ontologyResource = ns('');");
  });

  test('a blank node typed owl:Ontology is not the ontology', () => {
    const type = {termType: 'NamedNode', value: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type'};
    const ontology = {termType: 'NamedNode', value: 'http://www.w3.org/2002/07/owl#Ontology'};
    expect(
      ontologyTermsFromQuads(
        [{subject: {termType: 'BlankNode', value: 'b0'}, predicate: type, object: ontology}],
        'https://example.test/ex/',
      ).ontology,
    ).toBeUndefined();
  });

  test('a Turtle error names the file', async () => {
    await expect(
      ontologyTermsFromTurtle(
        [{name: 'src/data/bad.ttl', text: 'not turtle'}],
        'https://example.test/',
      ),
    ).rejects.toThrow(/src\/data\/bad\.ttl/);
  });

  test('an unsafe prefix names no file', () => {
    expect(() =>
      generateOntologyModules({
        prefix: '../x',
        namespace: 'https://x.test/',
        dataFiles: [],
        terms: [],
      }),
    ).toThrow(/cannot name an ontology module/);
  });
});

describe('the package configuration', () => {
  test('entries are sorted, and data defaults to <prefix>.ttl', () => {
    expect(
      readOntologyConfigs({
        linkedOntologies: {
          rdfs: {namespace: 'http://www.w3.org/2000/01/rdf-schema#'},
          rdf: {
            namespace: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
            data: ['rdf.ttl'],
          },
        },
      }),
    ).toEqual([
      {
        prefix: 'rdf',
        namespace: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
        data: ['rdf.ttl'],
      },
      {
        prefix: 'rdfs',
        namespace: 'http://www.w3.org/2000/01/rdf-schema#',
        data: ['rdfs.ttl'],
      },
    ]);
    expect(readOntologyConfigs({})).toEqual([]);
  });

  test.each([
    [[], /must be an object/],
    [{'bad prefix': {namespace: 'https://x.test/'}}, /prefix must be/],
    [{x: 'https://x.test/'}, /must be an object with a "namespace"/],
    [{x: {namespace: 'not an iri'}}, /namespace must be an IRI/],
    [{x: {namespace: 'https://x.test/ont'}}, /ending in \/, # or :/],
    [
      {Ex: {namespace: 'https://x.test/'}, ex: {namespace: 'https://y.test/'}},
      /differ only in case/,
    ],
    [
      {x: {namespace: 'https://x.test/', data: ['../up.ttl']}},
      /data must list/,
    ],
    [{x: {namespace: 'https://x.test/', data: []}}, /data must list/],
    [{x: {namespace: 'https://x.test/', data: ['x.json']}}, /data must list/],
  ])('refuses %j', (value, message) => {
    expect(() => readOntologyConfigs({linkedOntologies: value})).toThrow(
      message,
    );
  });
});

describe('writing and the build check', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'linked-ontgen-'));
    fs.copySync(FIXTURE, dir);
  });
  afterEach(() => fs.removeSync(dir));

  const step = () => {
    const found = planBuildSteps({}, dir).find(
      (s) => s.name === 'Checking ontology modules',
    );
    if (!found) throw new Error('no ontology step');
    return found;
  };

  test('the build passes current modules, and the step runs first', async () => {
    expect(planBuildSteps({}, dir)[0].name).toBe('Checking ontology modules');
    expect(await step().apply()).toBe(true);
    expect(await writePackageOntologies(dir)).toEqual([]);
  });

  test('a CRLF checkout is current', async () => {
    const file = path.join(dir, 'src/ontologies/other.ts');
    fs.writeFileSync(
      file,
      fs.readFileSync(file, 'utf8').replace(/\n/g, '\r\n'),
    );
    expect(await step().apply()).toBe(true);
  });

  test('changed data, an edited module or a missing one fails the build until regenerated', async () => {
    fs.appendFileSync(
      path.join(dir, 'src/data/other.ttl'),
      '\nother:Fresh a rdfs:Class .\n',
    );
    fs.appendFileSync(path.join(dir, 'src/ontologies/ex.ts'), '// hand edit\n');
    fs.removeSync(path.join(dir, 'src/ontologies/ex.register.ts'));

    expect(await staleOntologyModules(dir)).toEqual([
      'src/ontologies/ex.ts',
      'src/ontologies/ex.register.ts',
      'src/ontologies/other.ts',
    ]);
    const result = (await step().apply()) as {error: string};
    expect(result.error).toMatch(
      /src\/ontologies\/ex\.ts, src\/ontologies\/ex\.register\.ts, src\/ontologies\/other\.ts are not what the ontology data generates/,
    );
    expect(result.error).toMatch(/Run `linked generate-ontology`/);

    expect(await writePackageOntologies(dir)).toEqual([
      'src/ontologies/ex.ts',
      'src/ontologies/ex.register.ts',
      'src/ontologies/other.ts',
    ]);
    expect(
      fs.readFileSync(path.join(dir, 'src/ontologies/other.ts'), 'utf8'),
    ).toMatch(/export const Fresh = \/\*#__PURE__\*\/ ns\('Fresh'\);/);
    expect(await step().apply()).toBe(true);
  });

  test('a missing data file and a bad configuration fail the step with the reason', async () => {
    fs.removeSync(path.join(dir, 'src/data/other.ttl'));
    expect(await step().apply()).toEqual({
      error:
        'linkedOntologies.other names src/data/other.ttl, which does not exist.',
    });
    const pkg = fs.readJsonSync(path.join(dir, 'package.json'));
    fs.writeJsonSync(path.join(dir, 'package.json'), {
      ...pkg,
      linkedOntologies: {x: {}},
    });
    expect(await step().apply()).toEqual({
      error: expect.stringMatching(/namespace must be an IRI/),
    });
  });

  test('a package without linkedOntologies passes untouched', async () => {
    fs.writeJsonSync(path.join(dir, 'package.json'), {
      name: 'plain',
      linked: {kind: 'assets'},
    });
    fs.appendFileSync(path.join(dir, 'src/ontologies/ex.ts'), '// hand edit\n');
    expect(await step().apply()).toBe(true);
  });
});

describe('tree-shaking', () => {
  // `import * as ex` with one term used: a bundler keeps that term and drops the rest, because
  // every initializer is annotated pure. Core is stubbed; the data module's `Prefix.add` stays.
  test('an esbuild bundle of one term holds only that term', async () => {
    const esbuild = await import('esbuild');
    const result = await esbuild.build({
      stdin: {
        contents: `import * as ex from './src/ontologies/ex.js'; console.log(ex.Thing);`,
        resolveDir: FIXTURE,
        loader: 'ts',
      },
      bundle: true,
      write: false,
      format: 'esm',
      minify: true,
      logLevel: 'silent',
      plugins: [
        {
          name: 'stub-core',
          setup(build) {
            build.onResolve({filter: /^@_linked\/core\//}, (args) => ({
              path: args.path,
              namespace: 'core',
            }));
            build.onLoad({filter: /.*/, namespace: 'core'}, () => ({
              contents:
                'export const Prefix = {add() {}}; export const createNameSpace = (b) => (t) => ({id: b + t});' +
                'export const loadOntologyFiles = () => [];',
              loader: 'js',
            }));
          },
        },
      ],
    });
    const code = result.outputFiles[0].text;
    expect(code).toContain('"Thing"');
    for (const dropped of [
      'Widget',
      'Added',
      '3DModel',
      'longComment',
      'odd-name.x',
    ]) {
      expect(code).not.toContain(dropped);
    }
  });
});
