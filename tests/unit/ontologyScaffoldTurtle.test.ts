// A new ontology package's metadata: the fields of its data file (title, description, prefix,
// creator, maintainer, status) and package.json `author`, each with a default, from
// `buildPackageFiles` and from `linked create-package` flags alike.
//
// cli-methods pulls in ora, which is ESM-only.
jest.mock('ora', () => ({__esModule: true, default: () => ({})}));

import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import {createPackage} from '../../src/cli-methods';
import {buildPackageFiles} from '../../src/utils/packageFiles';
import {staleOntologyModules} from '../../src/utils/generateOntology';
import {
  ontologyScaffoldTurtle,
  ontologyTitleFor,
} from '../../src/utils/ontologyScaffoldTurtle';
import {
  ontologyStatusFlag,
  parsePackagePerson,
} from '../../src/utils/packageMetadata';

const NS = 'https://example.org/ont/planning/';
const ANN = 'https://ann.example.org/profile/card#me';
const BOB = 'https://bob.example.org/profile/card#me';

const FIXED = [
  '@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .',
  '@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .',
  '@prefix owl: <http://www.w3.org/2002/07/owl#> .',
  '@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .',
  '@prefix dcterms: <http://purl.org/dc/terms/> .',
  '@prefix skos: <http://www.w3.org/2004/02/skos/core#> .',
  '@prefix schema: <http://schema.org/> .',
  '@prefix vann: <http://purl.org/vocab/vann/> .',
];

describe('ontologyScaffoldTurtle', () => {
  test('defaults: a title from the name, the name as prefix, the status Draft, no people', () => {
    expect(ontologyScaffoldTurtle('lego-planning', NS)).toBe(
      [
        `@prefix lego-planning: <${NS}> .`,
        ...FIXED,
        '',
        'lego-planning:',
        '    a owl:Ontology ;',
        '    dcterms:title "Lego Planning"@en ;',
        '    vann:preferredNamespacePrefix "lego-planning" ;',
        `    vann:preferredNamespaceUri "${NS}" ;`,
        '    <http://www.w3.org/ns/adms#status> <https://linked.cm/ont/core/Draft> .',
        '',
      ].join('\n'),
    );
  });

  test('every field: predicates in IRI order after rdf:type, literals escaped', () => {
    expect(
      ontologyScaffoldTurtle('planning', NS, {
        title: 'Planning "terms"',
        description: 'Line one\nline two',
        prefix: 'pl',
        creator: ANN,
        maintainer: BOB,
        status: 'ReadyForReview',
      }),
    ).toBe(
      [
        `@prefix pl: <${NS}> .`,
        ...FIXED,
        '',
        'pl:',
        '    a owl:Ontology ;',
        `    dcterms:creator <${ANN}> ;`,
        '    dcterms:description "Line one\\nline two"@en ;',
        '    dcterms:title "Planning \\"terms\\""@en ;',
        '    vann:preferredNamespacePrefix "pl" ;',
        `    vann:preferredNamespaceUri "${NS}" ;`,
        `    schema:maintainer <${BOB}> ;`,
        '    <http://www.w3.org/ns/adms#status> <https://linked.cm/ont/core/ReadyForReview> .',
        '',
      ].join('\n'),
    );
  });

  test('the maintainer defaults to the creator; an empty description is left out', () => {
    const turtle = ontologyScaffoldTurtle('planning', NS, {creator: ANN, description: '  '});
    expect(turtle).toContain(`schema:maintainer <${ANN}>`);
    expect(turtle).not.toContain('dcterms:description');
  });

  test('a prefix that is one of the fixed ones replaces it, so no prefix is declared twice', () => {
    const turtle = ontologyScaffoldTurtle('planning', NS, {prefix: 'schema', creator: ANN});
    expect(turtle.match(/@prefix schema:/g)).toHaveLength(1);
    expect(turtle).toContain(`@prefix schema: <${NS}> .`);
    expect(turtle).toContain(`<http://schema.org/maintainer> <${ANN}>`);
  });

  test('refuses a prefix, person or status it cannot write', () => {
    expect(() => ontologyScaffoldTurtle('planning', NS, {prefix: '3d'})).toThrow(/not a prefix/);
    expect(() => ontologyScaffoldTurtle('planning', NS, {creator: 'Ann'})).toThrow(/creator "Ann" is not an IRI/);
    expect(() => ontologyScaffoldTurtle('planning', NS, {maintainer: 'https://x.test/a b'})).toThrow(/maintainer/);
    expect(() =>
      ontologyScaffoldTurtle('planning', NS, {status: 'Final' as 'Draft'}),
    ).toThrow(/not an ontology status/);
  });

  test('ontologyTitleFor', () => {
    expect(ontologyTitleFor('lego-planning')).toBe('Lego Planning');
    expect(ontologyTitleFor('tiles')).toBe('Tiles');
    expect(ontologyTitleFor('road_map-2')).toBe('Road Map 2');
  });
});

describe('the metadata flags', () => {
  test('--author takes npm\'s one-line person, or a bare IRI as its url', () => {
    expect(parsePackagePerson('Ann Lovelace <ann@example.org> (https://example.org/ann)')).toEqual({
      name: 'Ann Lovelace',
      email: 'ann@example.org',
      url: 'https://example.org/ann',
    });
    expect(parsePackagePerson('Ann Lovelace')).toEqual({name: 'Ann Lovelace'});
    expect(parsePackagePerson(ANN)).toEqual({url: ANN});
    expect(() => parsePackagePerson(' <> ')).toThrow(/names no one/);
  });

  test('--status is case-insensitive', () => {
    expect(ontologyStatusFlag('draft')).toBe('Draft');
    expect(ontologyStatusFlag('ready-for-review')).toBe('ReadyForReview');
    expect(ontologyStatusFlag('Published')).toBe('Published');
    expect(() => ontologyStatusFlag('final')).toThrow(/--status must be one of/);
  });
});

describe('buildPackageFiles with the template fields', () => {
  let tmp: string;
  let ttyDescriptors: PropertyDescriptor[];

  beforeAll(() => {
    ttyDescriptors = [process.stdin, process.stdout].map(
      (stream) =>
        Object.getOwnPropertyDescriptor(stream, 'isTTY') ?? {value: undefined, configurable: true},
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
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'linked-ontology-fields-'));
  });

  afterEach(() => {
    fs.removeSync(tmp);
  });

  const ontology = {
    title: 'Planning',
    description: 'Planning terms',
    prefix: 'pl',
    creator: ANN,
  };

  test('the data file holds the fields, the modules suggest the prefix and pass the module check', async () => {
    const out = buildPackageFiles('planning-ont', 'ontology', {uriBase: NS, ontology});
    expect(out['src/data/planning.ttl']).toBe(ontologyScaffoldTurtle('planning', NS, ontology));
    expect(out['src/ontologies/index.ts']).toContain(`suggestedPrefix: 'pl',`);
    for (const [file, content] of Object.entries(out)) {
      fs.outputFileSync(path.join(tmp, file), content);
    }
    expect(await staleOntologyModules(tmp)).toEqual([]);
  });

  test('author: given, it follows description; else the creator as its url; else none', () => {
    const keys = (pkg: string) => Object.keys(JSON.parse(pkg));
    const given = buildPackageFiles('planning-ont', 'ontology', {
      ontology,
      author: {name: 'Ann', email: '', url: ANN},
    })['package.json'];
    expect(JSON.parse(given).author).toEqual({name: 'Ann', url: ANN});
    expect(keys(given).slice(0, 3)).toEqual(['name', 'description', 'author']);

    const fromCreator = buildPackageFiles('planning-ont', 'ontology', {ontology})['package.json'];
    expect(JSON.parse(fromCreator).author).toEqual({url: ANN});

    expect(JSON.parse(buildPackageFiles('planning-ont', 'ontology')['package.json'])).not.toHaveProperty('author');
    expect(JSON.parse(buildPackageFiles('planning-assets', 'assets')['package.json'])).not.toHaveProperty('author');
    expect(
      JSON.parse(buildPackageFiles('planning-assets', 'assets', {author: {name: 'Ann'}})['package.json']).author,
    ).toEqual({name: 'Ann'});
  });

  test('the template leftovers are gone: no empty author, no dc: prefix, dotfiles end in a newline', () => {
    const out = buildPackageFiles('planning-ont', 'ontology');
    expect(out['package.json']).not.toContain('"author"');
    expect(out['src/data/planning.ttl']).not.toContain('@prefix dc:');
    expect(out['.npmignore'].endsWith('\n')).toBe(true);
    expect(out['.gitignore'].endsWith('\n')).toBe(true);
  });

  test('create-package takes the fields as flags and writes what buildPackageFiles gives for them', async () => {
    await createPackage('planning', NS, tmp, {
      kind: 'ontology',
      skipInstall: true,
      title: 'Planning',
      description: 'Planning terms',
      prefix: 'pl',
      creator: ANN,
      maintainer: BOB,
      status: 'published',
      author: 'Ann <ann@example.org>',
    });
    const expected = buildPackageFiles('planning-ont', 'ontology', {
      uriBase: NS,
      ontology: {...ontology, maintainer: BOB, status: 'Published'},
      author: {name: 'Ann', email: 'ann@example.org'},
    });
    for (const [file, content] of Object.entries(expected)) {
      expect([file, fs.readFileSync(path.join(tmp, 'planning-ont', file), 'utf8')]).toEqual([file, content]);
    }
  });

  test('a flag it cannot use is refused before anything is written', async () => {
    await expect(
      createPackage('planning', undefined, tmp, {kind: 'ontology', skipInstall: true, creator: 'Ann'}),
    ).rejects.toThrow(/not an IRI/);
    await expect(
      createPackage('planning', undefined, tmp, {kind: 'both', skipInstall: true, status: 'final'}),
    ).rejects.toThrow(/--status must be one of/);
    expect(fs.readdirSync(tmp)).toEqual([]);
  });
});
