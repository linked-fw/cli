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
  generateOntologyIndexModule,
  generateOntologyTermsModule,
  ontologyIdentifier,
  OntologyNameCollisionError,
  ontologyTermDoc,
} from '../../src/utils/ontologyModules.js';
import {
  ontologyIriOf,
  ontologySuggestedPrefix,
  ontologyTermsFromQuads,
  ontologyTermsFromTurtle,
  OntologyVannError,
} from '../../src/utils/ontologyTerms.js';
import {
  checkOntologyModulesStep,
  generatePackageOntologies,
  staleOntologyModules,
  writePackageOntologies,
} from '../../src/utils/generateOntology.js';
import {readOntologyConfigs} from '../../src/utils/ontologyConfig.js';
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
        name: 'ex',
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
      name: 'ex',
      namespace: 'https://example.test/ex/',
      dataFiles: ['../data/ex.ttl'],
      terms: [],
    });
    expect(module).not.toMatch(/import/);
    // `import * as terms` from the index needs a module (TS2306 otherwise).
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
    const generated = await generatePackageOntologies(FIXTURE);
    expect(
      generated.ontologies.map((g) => [g.config.name, g.suggestedPrefix, g.termCount, g.skipped]),
    ).toEqual([
      ['ex', 'exa', 8, ['https://example.test/ex/sub/Deeper']],
      ['other', 'other', 2, []],
    ]);
    expect(Object.keys(generated.files).sort()).toEqual([
      'src/ontologies/ex.ts',
      'src/ontologies/index.ts',
      'src/ontologies/other.ts',
    ]);
    for (const [file, content] of Object.entries(generated.files)) {
      expect(content).toBe(fs.readFileSync(path.join(FIXTURE, file), 'utf8'));
    }
    expect(generated.edits).toEqual({});
    expect(generated.remove).toEqual([]);
    // Each namespace has only its own terms.
    expect(generated.files['src/ontologies/other.ts']).not.toMatch(/Thing/);
    expect(generated.files['src/ontologies/ex.ts']).not.toMatch(/Elsewhere/);
  });

  test('the terms module holds the terms only, each the {id} literal of its full IRI, and imports nothing', async () => {
    const terms = fs.readFileSync(
      path.join(FIXTURE, 'src/ontologies/ex.ts'),
      'utf8',
    );
    const exports = [
      ...terms.matchAll(/^export const (\S+) = \{id: '([^']+)'\};$/gm),
    ];
    expect(exports.map((m) => [m[1], m[2]])).toEqual([
      ['Added', 'https://example.test/ex/Added'],
      ['Thing', 'https://example.test/ex/Thing'],
      ['Widget', 'https://example.test/ex/Widget'],
      ['_3DModel', 'https://example.test/ex/3DModel'],
      ['default_', 'https://example.test/ex/default'],
      ['longComment', 'https://example.test/ex/longComment'],
      ['ns', 'https://example.test/ex/ns'],
      ['odd_name_x', 'https://example.test/ex/odd-name.x'],
    ]);
    expect(terms.match(/^export /gm)).toHaveLength(exports.length);
    expect(terms).not.toMatch(/^import /m);
  });

  test('the index imports every module and registers them all with one call', () => {
    const index = fs.readFileSync(
      path.join(FIXTURE, 'src/ontologies/index.ts'),
      'utf8',
    );
    expect(index).toMatch(/^\/\/ Generated by `linked generate-ontology`\./);
    expect(index.match(/^import /gm)).toHaveLength(4);
    expect(index).toContain("import {registerOntologies} from '../package.js';");
    expect(index).toContain("import * as ex from './ex.js';");
    expect(index.match(/registerOntologies\(/g)).toHaveLength(1);
    expect(index).toContain(
      [
        '  {',
        "    name: 'ex',",
        "    namespace: 'https://example.test/ex/',",
        '    terms: ex,',
        "    data: data(['../data/ex.ttl', '../data/ex-extra.ttl']),",
        "    suggestedPrefix: 'exa',",
        '  },',
      ].join('\n'),
    );
  });

  test('index imports never take a binding of the index or of each other', () => {
    const entry = (name: string, module?: string) => ({
      name,
      module,
      namespace: `https://x.test/${name}/`,
      suggestedPrefix: 'x',
      dataFiles: [],
    });
    const index = generateOntologyIndexModule([
      entry('data'),
      entry('a-b'),
      entry('a_b'),
      entry('reg', 'register-ontologies'),
    ]);
    expect(index).toContain("import * as a_b from './a-b.js';");
    expect(index).toContain("import * as a_b_ from './a_b.js';");
    expect(index).toContain("import * as data_ from './data.js';");
    expect(index).toContain("import * as register_ontologies from './register-ontologies.js';");
    expect(() =>
      generateOntologyModules([], [entry('index')]),
    ).toThrow(/use the module src\/ontologies\/index\.ts/);
  });

  test('the same input gives the same bytes, in any order', () => {
    const spec = (terms: {localName: string; comment?: string}[]) => ({
      name: 'ex',
      suggestedPrefix: 'ex',
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

  test('the ontology IRI is the one the data declares with owl:Ontology', () => {
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

  test('an unsafe name names no file', () => {
    expect(() =>
      generateOntologyModules({
        name: '../x',
        suggestedPrefix: 'x',
        namespace: 'https://x.test/',
        dataFiles: [],
        terms: [],
      }),
    ).toThrow(/cannot name an ontology module/);
  });
});

describe('the suggested prefix', () => {
  const NS = 'https://example.test/s/';
  const read = (turtle: string) =>
    ontologyTermsFromTurtle(
      [
        {
          name: 's.ttl',
          text:
            '@prefix owl: <http://www.w3.org/2002/07/owl#> .\n' +
            '@prefix vann: <http://purl.org/vocab/vann/> .\n' +
            turtle,
        },
      ],
      NS,
    );
  const prefixOf = async (turtle: string) =>
    ontologySuggestedPrefix(await read(turtle), NS);

  test('is the vann prefix of the ontology node, which need not be the name', async () => {
    const {ontologies, files} = await generatePackageOntologies(FIXTURE);
    expect(ontologies.map((o) => [o.config.name, o.suggestedPrefix])).toEqual([
      ['ex', 'exa'],
      // The vann namespace may be an IRI as well as a literal.
      ['other', 'other'],
    ]);
    expect(files['src/ontologies/index.ts']).toContain(
      "    name: 'ex',\n    namespace: 'https://example.test/ex/',\n    terms: ex,\n    data: data(['../data/ex.ttl', '../data/ex-extra.ttl']),\n    suggestedPrefix: 'exa',",
    );
    expect(
      await prefixOf(
        `<${NS}> a owl:Ontology ; vann:preferredNamespacePrefix "s1" ; vann:preferredNamespaceUri "${NS}" .`,
      ),
    ).toBe('s1');
  });

  test('vann data on another node does not count', async () => {
    const result = await read(
      `<${NS}> a owl:Ontology .\n<https://example.test/elsewhere> vann:preferredNamespacePrefix "s" ; vann:preferredNamespaceUri "${NS}" .`,
    );
    expect(result.preferredPrefixes).toEqual([]);
    expect(() => ontologySuggestedPrefix(result, NS)).toThrow(
      /has no vann:preferredNamespacePrefix/,
    );
  });

  test.each([
    [`<${NS}> vann:preferredNamespacePrefix "s" .`, /declares no owl:Ontology/],
    [`<${NS}> a owl:Ontology ; vann:preferredNamespaceUri "${NS}" .`, /no vann:preferredNamespacePrefix/],
    [`<${NS}> a owl:Ontology ; vann:preferredNamespacePrefix "s" .`, /no vann:preferredNamespaceUri/],
    [
      `<${NS}> a owl:Ontology ; vann:preferredNamespacePrefix "s", "t" ; vann:preferredNamespaceUri "${NS}" .`,
      /more than one vann:preferredNamespacePrefix \("s", "t"\)/,
    ],
    [
      `<${NS}> a owl:Ontology ; vann:preferredNamespacePrefix "s" ; vann:preferredNamespaceUri "${NS}", <https://example.test/t/> .`,
      /more than one vann:preferredNamespaceUri/,
    ],
    [
      `<${NS}> a owl:Ontology ; vann:preferredNamespacePrefix "s" ; vann:preferredNamespaceUri "https://example.test/t/" .`,
      /"https:\/\/example\.test\/t\/" is not its namespace/,
    ],
    [
      `<${NS}> a owl:Ontology ; vann:preferredNamespacePrefix "3d" ; vann:preferredNamespaceUri "${NS}" .`,
      /"3d" is not a prefix/,
    ],
  ])('refuses %s', async (turtle, message) => {
    const result = await read(turtle);
    let error: unknown;
    try {
      ontologySuggestedPrefix(result, NS);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(OntologyVannError);
    expect((error as Error).message).toMatch(message);
  });
});

describe('the package configuration', () => {
  test('entries are sorted; data defaults to <name>.ttl, module to the name, generated to true', () => {
    expect(
      readOntologyConfigs({
        linkedOntologies: {
          rdfs: {
            namespace: 'http://www.w3.org/2000/01/rdf-schema#',
            module: 'rdf-schema',
            generated: false,
          },
          rdf: {
            namespace: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
            data: ['rdf.ttl'],
          },
        },
      }),
    ).toEqual([
      {
        name: 'rdf',
        namespace: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
        data: ['rdf.ttl'],
        module: 'rdf',
        generated: true,
      },
      {
        name: 'rdfs',
        namespace: 'http://www.w3.org/2000/01/rdf-schema#',
        data: ['rdfs.ttl'],
        module: 'rdf-schema',
        generated: false,
      },
    ]);
    expect(readOntologyConfigs({})).toEqual([]);
  });

  test.each([
    [[], /must be an object/],
    [{'bad name': {namespace: 'https://x.test/'}}, /name must be lowercase/],
    // Lowercase only, so two names never differ only in case.
    [{Ex: {namespace: 'https://x.test/'}}, /name must be lowercase/],
    [{x: 'https://x.test/'}, /must be an object with a "namespace"/],
    [{x: {namespace: 'not an iri'}}, /namespace must be an IRI/],
    [{x: {namespace: 'https://x.test/ont'}}, /ending in \/, # or :/],
    [
      {x: {namespace: 'https://x.test/', data: ['../up.ttl']}},
      /data must list/,
    ],
    [{x: {namespace: 'https://x.test/', data: []}}, /data must list/],
    [{x: {namespace: 'https://x.test/', data: ['x.json']}}, /data must list/],
    [
      {x: {namespace: 'https://x.test/', module: 'Linked-Core'}},
      /x\.module must be a file name in src\/ontologies\/ without extension/,
    ],
    [
      {x: {namespace: 'https://x.test/', module: '../x'}},
      /x\.module must be a file name/,
    ],
    [
      {x: {namespace: 'https://x.test/', generated: 'no'}},
      /x\.generated must be true \(the default\) or false/,
    ],
    [
      {
        a: {namespace: 'https://x.test/a/', module: 'b'},
        b: {namespace: 'https://x.test/b/'},
      },
      /"a" and "b" both use the module src\/ontologies\/b\.ts/,
    ],
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
    fs.removeSync(path.join(dir, 'src/ontologies/index.ts'));

    const stale = [
      'src/ontologies/ex.ts',
      'src/ontologies/index.ts',
      'src/ontologies/other.ts',
    ];
    expect(await staleOntologyModules(dir)).toEqual(stale);
    const result = (await step().apply()) as {error: string};
    expect(result.error).toMatch(
      /src\/ontologies\/ex\.ts, src\/ontologies\/index\.ts, src\/ontologies\/other\.ts are not what the ontology data generates/,
    );
    expect(result.error).toMatch(/Run `linked generate-ontology`/);

    expect(await writePackageOntologies(dir)).toEqual(stale);
    expect(
      fs.readFileSync(path.join(dir, 'src/ontologies/other.ts'), 'utf8'),
    ).toMatch(/^export const Fresh = \{id: 'https:\/\/example\.test\/other#Fresh'\};$/m);
    expect(await step().apply()).toBe(true);
  });

  test('the files of the earlier layout are refused, then removed, and their imports become the index', async () => {
    const generatedFile = (name: string) =>
      '// Generated by `linked generate-ontology`. Do not edit.\nexport {};\n';
    for (const f of ['ex.data.ts', 'ex.register.ts', 'other.register.ts']) {
      fs.writeFileSync(path.join(dir, 'src/ontologies', f), generatedFile(f));
    }
    // A hand-written module of the same form stays.
    fs.writeFileSync(path.join(dir, 'src/ontologies/other.data.ts'), 'export const extra = 1;\n');
    fs.writeFileSync(
      path.join(dir, 'src/index.ts'),
      "import './types.js';\nimport './ontologies/ex.register.js';\nimport './ontologies/other.register.js';\n",
    );
    fs.outputFileSync(
      path.join(dir, 'src/shapes/index.ts'),
      "import '../ontologies/other.register.js';\nimport './Thing.js';\n",
    );

    expect(await staleOntologyModules(dir)).toEqual([
      'src/index.ts',
      'src/ontologies/ex.data.ts',
      'src/ontologies/ex.register.ts',
      'src/ontologies/other.register.ts',
      'src/shapes/index.ts',
    ]);
    expect(((await step().apply()) as {error: string}).error).toMatch(
      /^src\/index\.ts, src\/ontologies\/ex\.data\.ts, .* are not what the ontology data generates/,
    );

    await writePackageOntologies(dir);
    expect(fs.readdirSync(path.join(dir, 'src/ontologies')).sort()).toEqual([
      'ex.ts',
      'index.ts',
      'other.data.ts',
      'other.ts',
    ]);
    expect(fs.readFileSync(path.join(dir, 'src/index.ts'), 'utf8')).toBe(
      "import './types.js';\nimport './ontologies/index.js';\n",
    );
    expect(fs.readFileSync(path.join(dir, 'src/shapes/index.ts'), 'utf8')).toBe(
      "import '../ontologies/index.js';\nimport './Thing.js';\n",
    );
    expect(await step().apply()).toBe(true);
  });

  test('the entry must import the index; without an entry the build says so', async () => {
    fs.writeFileSync(path.join(dir, 'src/index.ts'), "import './types.js';\n");
    expect(await staleOntologyModules(dir)).toEqual(['src/index.ts']);
    await writePackageOntologies(dir);
    expect(fs.readFileSync(path.join(dir, 'src/index.ts'), 'utf8')).toBe(
      "import './ontologies/index.js';\nimport './types.js';\n",
    );
    fs.removeSync(path.join(dir, 'src/index.ts'));
    expect(((await step().apply()) as {error: string}).error).toBe(
      "ontology-generator-fixture: no src/index.ts or src/index.tsx to import ./ontologies/index.js, which registers the package's ontologies.",
    );
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

  test('an ontology without vann data fails the build, saying which triples to add and where', async () => {
    const file = path.join(dir, 'src/data/ex.ttl');
    fs.writeFileSync(
      file,
      fs
        .readFileSync(file, 'utf8')
        .replace(/ ;\n  vann:preferredNamespacePrefix "exa" ;\n  vann:preferredNamespaceUri "[^"]*"/, ''),
    );
    const {error} = (await step().apply()) as {error: string};
    expect(error).toContain(
      'ontology-generator-fixture: the ontology "ex" (src/data/ex.ttl, src/data/ex-extra.ttl) has no suggested prefix: <https://example.test/ex/> has no vann:preferredNamespacePrefix.',
    );
    expect(error).toContain(
      '  <https://example.test/ex/>\n    vann:preferredNamespacePrefix "ex" ;\n    vann:preferredNamespaceUri "https://example.test/ex/" .',
    );
    expect(error).toContain('src/data/ex-added.ttl, never in the published file');
    await expect(generatePackageOntologies(dir)).rejects.toThrow(
      /the ontology "ex" .* has no suggested prefix/,
    );
  });

  test('without an owl:Ontology node the message declares one; a wrong vann namespace is named', async () => {
    fs.writeFileSync(
      path.join(dir, 'src/data/other.ttl'),
      '@prefix other: <https://example.test/other#> .\nother:Elsewhere a <http://www.w3.org/2000/01/rdf-schema#Class> .\n',
    );
    const {error} = (await step().apply()) as {error: string};
    expect(error).toMatch(/its data declares no owl:Ontology for the namespace <https:\/\/example\.test\/other#>/);
    expect(error).toContain('  <https://example.test/other#> a owl:Ontology ;\n');

    fs.copySync(path.join(FIXTURE, 'src/data/other.ttl'), path.join(dir, 'src/data/other.ttl'));
    const pkg = fs.readJsonSync(path.join(dir, 'package.json'));
    pkg.linkedOntologies.other.namespace = 'https://example.test/other/';
    fs.writeJsonSync(path.join(dir, 'package.json'), pkg);
    expect(((await step().apply()) as {error: string}).error).toMatch(
      /its vann:preferredNamespaceUri "https:\/\/example\.test\/other#" is not its namespace "https:\/\/example\.test\/other\/"/,
    );
  });

  test('an ontology whose module is written by hand: the index registers it, nothing else is generated or compared, vann data still required', async () => {
    const pkg = fs.readJsonSync(path.join(dir, 'package.json'));
    pkg.linkedOntologies.ex.generated = false;
    fs.writeJsonSync(path.join(dir, 'package.json'), pkg);
    // A hand-written module, edited with an extra export.
    fs.appendFileSync(
      path.join(dir, 'src/ontologies/ex.ts'),
      'export const grouping = {};\n',
    );

    // The index is the same: it registers the hand-written module like a generated one.
    expect(await step().apply()).toBe(true);
    const generated = await generatePackageOntologies(dir);
    expect(
      generated.ontologies.map((g) => [g.config.name, g.config.generated]),
    ).toEqual([
      ['ex', false],
      ['other', true],
    ]);
    expect(Object.keys(generated.files).sort()).toEqual([
      'src/ontologies/index.ts',
      'src/ontologies/other.ts',
    ]);
    expect(generated.files['src/ontologies/index.ts']).toContain(
      "import * as ex from './ex.js';",
    );
    expect(generated.ontologies[0].termCount).toBeGreaterThan(0);
    expect(await writePackageOntologies(dir)).toEqual([]);

    // Without vann data it fails the build with the same message as a generated one.
    const file = path.join(dir, 'src/data/ex.ttl');
    fs.writeFileSync(
      file,
      fs
        .readFileSync(file, 'utf8')
        .replace(/ ;\n  vann:preferredNamespacePrefix "exa" ;\n  vann:preferredNamespaceUri "[^"]*"/, ''),
    );
    const {error} = (await step().apply()) as {error: string};
    expect(error).toContain(
      'ontology-generator-fixture: the ontology "ex" (src/data/ex.ttl, src/data/ex-extra.ttl) has no suggested prefix: <https://example.test/ex/> has no vann:preferredNamespacePrefix.',
    );
    await expect(generatePackageOntologies(dir)).rejects.toThrow(
      /the ontology "ex" .* has no suggested prefix/,
    );
  });

  test('a stale generated module names the option for hand-written modules', async () => {
    fs.appendFileSync(path.join(dir, 'src/ontologies/ex.ts'), '// hand edit\n');
    expect(((await step().apply()) as {error: string}).error).toMatch(
      /declare it with "generated": false in "linkedOntologies"/,
    );
  });

  test('a module other than the name: the file takes the module, the registration the name', async () => {
    const pkg = fs.readJsonSync(path.join(dir, 'package.json'));
    pkg.linkedOntologies.ex.module = 'linked-ex';
    fs.writeJsonSync(path.join(dir, 'package.json'), pkg);
    // The generated module under the old file name goes.
    expect(await staleOntologyModules(dir)).toEqual([
      'src/ontologies/ex.ts',
      'src/ontologies/index.ts',
      'src/ontologies/linked-ex.ts',
    ]);
    await writePackageOntologies(dir);
    const read = (f: string) =>
      fs.readFileSync(path.join(dir, 'src/ontologies', f), 'utf8');
    expect(fs.existsSync(path.join(dir, 'src/ontologies/ex.ts'))).toBe(false);
    expect(read('linked-ex.ts')).toBe(
      fs.readFileSync(path.join(FIXTURE, 'src/ontologies/ex.ts'), 'utf8'),
    );
    const index = read('index.ts');
    expect(index).toContain("import * as linked_ex from './linked-ex.js';");
    expect(index).toContain("    name: 'ex',\n    namespace: 'https://example.test/ex/',\n    terms: linked_ex,");
    expect(await step().apply()).toBe(true);
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
  // `import * as ex` with one term used: a bundler keeps that term and drops the rest (each is a
  // plain object literal).
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
    });
    const code = result.outputFiles[0].text;
    expect(code).toContain('https://example.test/ex/Thing');
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
