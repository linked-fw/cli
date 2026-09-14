import ts from 'typescript';
import {analyzeSource, sourceHash} from '../../src/source-analysis/index.js';
import {fixture, simple} from './sourceAnalysisFixtures.js';

describe('portable static source analysis', () => {
  test('foreign-direct-shape: literal IRI, named export and exact accessor owner', () => {
    const {snapshot, profile} = fixture();
    const result = analyzeSource(snapshot, profile);
    expect(result.findings).toEqual([]);
    expect(result.coverage).toBe('complete');
    expect(result.shapes).toHaveLength(1);
    expect(result.shapes[0]).toMatchObject({
      entry: {moduleId: 'card.ts', exportName: 'Card'},
      targetClass: {kind: 'iri', value: 'https://example.test/Card'},
      accessors: [
        {
          name: 'title',
          owner: {moduleId: 'card.ts', exportName: 'Card'},
          kind: 'literal',
          path: {kind: 'iri', value: 'https://example.test/title'},
        },
      ],
    });
    expect(
      result.shapes[0].provenance.every(
        (p) => p.moduleHash.length === 64 && p.end > p.start,
      ),
    ).toBe(true);
    expect(Object.isFrozen(result.shapes[0])).toBe(true);
    expect(Object.isFrozen(snapshot.entries[0])).toBe(false);
  });
  test('default-export: keeps the public default route distinct from class spelling', () => {
    const {snapshot, profile} = fixture(
      simple.replace('export class Card', 'export default class Card'),
    );
    const result = analyzeSource(
      {...snapshot, entries: [{moduleId: 'card.ts', exportName: 'default'}]},
      profile,
    );
    expect(result.findings).toEqual([]);
    expect(result.shapes[0].entry.exportName).toBe('default');
  });
  test('compiled-decorator: emitted JavaScript has the same declared meaning', () => {
    const output = ts.transpileModule(simple, {
      compilerOptions: {
        experimentalDecorators: true,
        emitDecoratorMetadata: true,
        target: ts.ScriptTarget.ES2015,
        module: ts.ModuleKind.ESNext,
      },
    }).outputText;
    const {snapshot, profile} = fixture(output, 'js');
    const result = analyzeSource(snapshot, profile);
    expect(result.findings).toEqual([]);
    expect(result.shapes[0].targetClass).toEqual({
      kind: 'iri',
      value: 'https://example.test/Card',
    });
    expect(result.shapes[0].accessors[0].path).toEqual({
      kind: 'iri',
      value: 'https://example.test/title',
    });
  });
  test('inherited-image-range: superclass declaration and deferred package range survive', () => {
    const code = `import {linkedShape,objectProperty,Shape} from 'linked';
      @linkedShape export class Base extends Shape {
        static targetClass='https://example.test/Base';
        @objectProperty({path:'https://example.test/image',shape:['@foreign/media','Picture']}) get photo(){return null;}
      }
      @linkedShape export class Card extends Base {static targetClass='https://example.test/Card';}`;
    const {snapshot, profile} = fixture(code);
    const r = analyzeSource(snapshot, profile);
    expect(r.findings).toEqual([]);
    expect(r.shapes).toHaveLength(2);
    expect(r.shapes[0].superclass).toEqual({
      moduleId: 'card.ts',
      exportName: 'Base',
    });
    expect(r.shapes[1].accessors[0]).toMatchObject({
      owner: {moduleId: 'card.ts', exportName: 'Base'},
      range: {
        kind: 'package',
        packageName: '@foreign/media',
        exportName: 'Picture',
      },
    });
  });
  test('registered-package-decorator: factory origin is proved through its import', () => {
    const code = `import {linkedPackage,Shape} from 'linked'; const {linkedShape}=linkedPackage('@foreign/ui');
      @linkedShape export class Card extends Shape {static targetClass='https://example.test/Card';}`;
    const {snapshot, profile} = fixture(code);
    expect(analyzeSource(snapshot, profile).findings).toEqual([]);
  });
  test('namespace-terms: declared factory and term wrapper work without running the module', () => {
    const code = `import {linkedShape,Shape,createNameSpace} from 'linked';
      const ns=createNameSpace('https://example.test/'); const term=(name)=>ns(name);
      const vocabulary={Card:term('Card')};
      @linkedShape export class Card extends Shape {static targetClass=vocabulary.Card;}`;
    const {snapshot, profile} = fixture(code);
    const r = analyzeSource(snapshot, profile);
    expect(r.findings).toEqual([]);
    expect(r.shapes[0].targetClass).toEqual({
      kind: 'iri',
      value: 'https://example.test/Card',
    });
  });
  test('same-spelling-impostor: a local function cannot become linkedShape', () => {
    const {snapshot, profile} = fixture(
      `function linkedShape(c){return c;} @linkedShape export class Card {static targetClass='https://example.test/Card';}`,
    );
    const r = analyzeSource(snapshot, profile);
    expect(r.shapes).toEqual([]);
    expect(r.findings.map((f) => f.code)).toContain(
      'missing-proven-linked-decorator',
    );
  });
  test('ambiguous-export: duplicate routes refuse rather than pick the first', () => {
    const {snapshot, profile} = fixture(simple + `\nexport {Card};`);
    const r = analyzeSource(snapshot, profile);
    expect(r.shapes).toEqual([]);
    expect(r.findings[0].code).toBe('ambiguous-export');
  });
  test('cyclic-reexport: terminates with explicit source provenance', () => {
    const code = `export {Card} from './other';`;
    const {snapshot, profile} = fixture(code);
    const other = `export {Card} from './card';`;
    const r = analyzeSource(
      {
        ...snapshot,
        modules: [
          ...snapshot.modules,
          {
            id: 'other.ts',
            code: other,
            language: 'ts',
            hash: sourceHash(other),
          },
        ],
        resolutions: [
          ...snapshot.resolutions,
          {from: 'card.ts', specifier: './other', to: 'other.ts'},
          {from: 'other.ts', specifier: './card', to: 'card.ts'},
        ],
      },
      profile,
    );
    expect(r.shapes).toEqual([]);
    expect(r.findings[0].code).toBe('cyclic-reference');
    expect(r.findings[0].provenance).not.toHaveLength(0);
  });
  test('star-export: unsupported is not absence', () => {
    const {snapshot, profile} = fixture(`export * from 'linked';`);
    const r = analyzeSource(snapshot, profile);
    expect(r.coverage).toBe('partial');
    expect(r.findings[0].code).toBe('unsupported-star-export');
  });
  test('hostile-import: top-level side effects are never executed', () => {
    const key = '__linkedStaticAnalyzerExecuted';
    delete (globalThis as any)[key];
    const {snapshot, profile} = fixture(
      `globalThis.${key}=true; fetch('https://example.invalid'); throw Error('must not run');\n` +
        simple,
    );
    expect(analyzeSource(snapshot, profile).shapes).toHaveLength(1);
    expect((globalThis as any)[key]).toBeUndefined();
  });
  test('rdf-fidelity: kinds, language and typed lexical values remain distinct', () => {
    const {snapshot, profile} = fixture();
    const terms = [
      {kind: 'iri', value: 'https://example.test/value'},
      {kind: 'blank', value: 'scope-b1'},
      {
        kind: 'literal',
        value: '01',
        datatype: 'http://www.w3.org/2001/XMLSchema#integer',
      },
      {kind: 'literal', value: 'Bonjour', language: 'fr'},
    ] as const;
    const declarations = {
      nodes: [
        {
          id: 'https://example.test/shape',
          subjectKind: 'iri' as const,
          graphIri: 'https://example.test/declarations',
          packageName: '@foreign/forms',
          capabilityKey: 'forms',
          predicates: {'https://example.test/values': terms},
        },
      ],
      provenance: ['forms.ttl'],
    };
    const r = analyzeSource({...snapshot, declarations}, profile);
    expect(r.declarations).toEqual(declarations);
    expect(Object.isFrozen(declarations.nodes[0])).toBe(false);
    expect(Object.isFrozen(terms[0])).toBe(false);
  });
  test('unknown-inner-pattern: preserves a proved shape while refusing its property', () => {
    const code = simple.replace(
      "path: 'https://example.test/title'",
      'path: chooseAtRuntime()',
    );
    const {snapshot, profile} = fixture(code);
    const r = analyzeSource(snapshot, profile);
    expect(r.shapes).toHaveLength(1);
    expect(r.shapes[0].coverage).toBe('partial');
    expect(r.shapes[0].accessors).toEqual([]);
    expect(r.findings.length).toBeGreaterThan(0);
  });
  test('forged-helper: __decorate spelling alone never qualifies emitted JS', () => {
    const code = `import {linkedShape} from 'linked'; const __decorate=(a,b)=>b;
      let Card=class Card {}; Card.targetClass='https://example.test/Card'; Card=__decorate([linkedShape],Card); export {Card};`;
    const {snapshot, profile} = fixture(code, 'js');
    const r = analyzeSource(snapshot, profile);
    expect(r.shapes).toEqual([]);
    expect(r.findings[0].code).toBe('unrecognized-decorator-helper');
  });
  test('shape-reassignment: retains no claim for a replacement constructor', () => {
    const {snapshot, profile} = fixture(simple + `\nCard=otherFactory();`);
    const r = analyzeSource(snapshot, profile);
    expect(r.shapes).toEqual([]);
    expect(r.findings[0].code).toBe('mutated-shape-binding');
  });
  test('computed-target-write: bracket spelling cannot bypass mutation refusal', () => {
    const {snapshot, profile} = fixture(
      simple + `\nCard['targetClass']='https://example.test/Other';`,
    );
    const r = analyzeSource(snapshot, profile);
    expect(r.shapes).toEqual([]);
    expect(r.findings[0].code).toBe('mutated-shape-binding');
  });
  test('decorator-reexport: one explicit alias retains its trusted origin', () => {
    const {snapshot, profile} = fixture(
      simple.replace("from 'linked'", "from './barrel'"),
    );
    const code = `export {linkedShape,literalProperty,Shape} from 'linked';`;
    const r = analyzeSource(
      {
        ...snapshot,
        modules: [
          ...snapshot.modules,
          {id: 'barrel.ts', code, language: 'ts', hash: sourceHash(code)},
        ],
        resolutions: [
          ...snapshot.resolutions,
          {from: 'card.ts', specifier: './barrel', to: 'barrel.ts'},
          {from: 'barrel.ts', specifier: 'linked', to: 'core.ts'},
        ],
      },
      profile,
    );
    expect(r.shapes[0].targetClass).toEqual({
      kind: 'iri',
      value: 'https://example.test/Card',
    });
    expect(r.shapes[0].accessors).toHaveLength(1);
  });
  test('syntax-error: reports partial scope instead of empty ready', () => {
    const {snapshot, profile} = fixture('export class Card { @');
    const r = analyzeSource(snapshot, profile);
    expect(r.coverage).toBe('partial');
    expect(r.findings[0].code).toBe('syntax-error');
  });
  test('cycle-and-budget: AST and reference budgets produce named refusals', () => {
    const {snapshot, profile} = fixture();
    const r = analyzeSource(snapshot, {
      ...profile,
      limits: {...profile.limits, astNodes: 4},
    });
    expect(r.findings[0].code).toBe('ast-budget');
    expect(r.coverage).toBe('partial');
    expect(() =>
      analyzeSource(snapshot, {
        ...profile,
        limits: {...profile.limits, moduleBytes: 2},
      }),
    ).toThrow('source-byte-budget');
  });
  test('invalid-fingerprint: changed source cannot reuse a claimed hash', () => {
    const {snapshot, profile} = fixture();
    expect(() =>
      analyzeSource(
        {
          ...snapshot,
          modules: snapshot.modules.map((m) => ({...m, code: m.code + ' '})),
        },
        profile,
      ),
    ).toThrow('source-hash-mismatch');
  });
  test('private-path-redaction: host paths cannot become portable module IDs', () => {
    const {snapshot, profile} = fixture();
    for (const id of [
      '/Users/someone/private.ts',
      '../private.ts',
      'C:\\private.ts',
    ])
      expect(() =>
        analyzeSource(
          {
            ...snapshot,
            modules: snapshot.modules.map((m, i) => (i === 1 ? {...m, id} : m)),
          },
          profile,
        ),
      ).toThrow('duplicate-or-invalid-module');
  });
  test('forged-metadata-helper: a familiar name cannot silently modify a property', () => {
    const output = ts.transpileModule(simple, {
      compilerOptions: {
        experimentalDecorators: true,
        emitDecoratorMetadata: true,
        target: ts.ScriptTarget.ES2015,
        module: ts.ModuleKind.ESNext,
      },
    }).outputText;
    const {snapshot, profile} = fixture(
      output + '\n__metadata = malicious;',
      'js',
    );
    const r = analyzeSource(snapshot, profile);
    expect(r.coverage).toBe('partial');
    expect(r.findings.map((f) => f.code)).toContain(
      'unrecognized-metadata-helper',
    );
  });
});
