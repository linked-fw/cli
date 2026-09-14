import {
  ANALYZER_VERSION,
  DEFAULT_LIMITS,
  sourceHash,
} from '../../src/source-analysis/index.js';
import type {
  AnalysisProfile,
  BindingRole,
  SourceSnapshot,
} from '../../src/source-analysis/index.js';

export const core = `export function linkedShape() {}\nexport function literalProperty() {}\nexport function objectProperty() {}\nexport function linkedPackage() {}\nexport function createNameSpace() {}\nexport function namedNode() {}\nexport class Shape {}`;
export const simple = `import {linkedShape, literalProperty, Shape} from 'linked';
@linkedShape export class Card extends Shape {
 static targetClass = 'https://example.test/Card';
 @literalProperty({path: 'https://example.test/title'}) get title() { return ''; }
}`;
export function fixture(
  code = simple,
  language: 'ts' | 'js' = 'ts',
): {snapshot: SourceSnapshot; profile: AnalysisProfile} {
  const snapshot: SourceSnapshot = {
    modules: [
      {id: 'core.ts', code: core, language: 'ts', hash: sourceHash(core)},
      {id: 'card.ts', code, language, hash: sourceHash(code)},
    ],
    entries: [{moduleId: 'card.ts', exportName: 'Card'}],
    resolutions: [{from: 'card.ts', specifier: 'linked', to: 'core.ts'}],
    declarations: {nodes: [], provenance: []},
    resolutionHash: sourceHash('authorized-resolutions-v1'),
  };
  const roles: BindingRole[] = [
    'linkedShape',
    'literalProperty',
    'objectProperty',
    'linkedPackage',
    'createNameSpace',
    'namedNode',
    'Shape',
  ];
  const profile: AnalysisProfile = {
    id: ANALYZER_VERSION,
    limits: DEFAULT_LIMITS,
    conditions: ['import'],
    trustedBindings: roles.map((role) => ({
      moduleId: 'core.ts',
      exportName: role,
      role,
      moduleHash: sourceHash(core),
    })),
  };
  return {snapshot, profile};
}
