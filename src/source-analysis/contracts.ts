/** Portable, data-only source evidence. Filesystem authority belongs to the host. */
export const ANALYSIS_SCHEMA_VERSION = 1 as const;
export const ANALYZER_VERSION = 'linked-static-v1' as const;

export type RdfTerm =
  | {readonly kind: 'iri' | 'blank'; readonly value: string}
  | {
      readonly kind: 'literal';
      readonly value: string;
      readonly datatype?: string;
      readonly language?: string;
    };

export interface SourceRef {
  readonly moduleId: string;
  readonly moduleHash: string;
  readonly start: number;
  readonly end: number;
}
export interface ExportRef {
  readonly moduleId: string;
  readonly exportName: string;
}
export interface SourceModule {
  readonly id: string;
  readonly code: string;
  readonly language: 'ts' | 'tsx' | 'js' | 'jsx';
  readonly hash: string;
}
/** Existing Linked declaration graph wire shape, without a CN dependency. */
export interface DeclarationGraph {
  readonly nodes: readonly {
    readonly id: string;
    readonly subjectKind?: 'iri' | 'blank';
    readonly graphIri: string;
    readonly packageName: string;
    readonly capabilityKey: string;
    readonly predicates: Readonly<Record<string, readonly RdfTerm[]>>;
  }[];
  readonly provenance: readonly string[];
}
export interface SourceSnapshot {
  readonly modules: readonly SourceModule[];
  readonly resolutions: readonly {
    readonly from: string;
    readonly specifier: string;
    readonly to: string;
  }[];
  readonly entries: readonly ExportRef[];
  readonly declarations: DeclarationGraph;
  /** Host-computed package/lock/patch/conditions/declaration identity. */
  readonly resolutionHash: string;
}
export type BindingRole =
  | 'linkedShape'
  | 'literalProperty'
  | 'objectProperty'
  | 'linkedPackage'
  | 'createNameSpace'
  | 'namedNode'
  | 'Shape';
export interface AnalysisLimits {
  readonly modules: number;
  readonly totalBytes: number;
  readonly moduleBytes: number;
  readonly referenceDepth: number;
  readonly astNodes: number;
}
export const DEFAULT_LIMITS: AnalysisLimits = Object.freeze({
  modules: 256,
  totalBytes: 16 * 1024 * 1024,
  moduleBytes: 1024 * 1024,
  referenceDepth: 32,
  astNodes: 250_000,
});
export interface AnalysisProfile {
  readonly id: typeof ANALYZER_VERSION;
  readonly conditions: readonly string[];
  /** Only the authorized host may attest API identities from installed code. */
  readonly trustedBindings: readonly (ExportRef & {
    readonly role: BindingRole;
    readonly moduleHash: string;
  })[];
  readonly limits: AnalysisLimits;
}
export interface AnalysisFinding {
  readonly code: string;
  readonly affectedIds: readonly string[];
  readonly provenance: readonly SourceRef[];
}
export type RangeRef =
  | {readonly kind: 'export'; readonly reference: ExportRef}
  | {
      readonly kind: 'package';
      readonly packageName: string;
      readonly exportName: string;
    };
export interface AccessorEvidence {
  readonly name: string;
  readonly owner: ExportRef;
  readonly kind: 'literal' | 'object';
  readonly path: RdfTerm;
  readonly range?: RangeRef;
  readonly provenance: readonly SourceRef[];
}
export interface ShapeEvidence {
  readonly entry: ExportRef;
  readonly declaration: {readonly moduleId: string; readonly localName: string};
  readonly targetClass: RdfTerm;
  readonly superclass?: ExportRef;
  readonly accessors: readonly AccessorEvidence[];
  readonly coverage: 'complete' | 'partial';
  readonly provenance: readonly SourceRef[];
}
export interface AnalysisEvidence {
  readonly schemaVersion: typeof ANALYSIS_SCHEMA_VERSION;
  readonly analyzerVersion: typeof ANALYZER_VERSION;
  readonly parserVersion: string;
  readonly basisHash: string;
  readonly coverage: 'complete' | 'partial';
  readonly shapes: readonly ShapeEvidence[];
  readonly declarations: DeclarationGraph;
  readonly findings: readonly AnalysisFinding[];
}
export interface PackageAnalysisManifest {
  readonly schemaVersion: typeof ANALYSIS_SCHEMA_VERSION;
  readonly analyzerVersion: typeof ANALYZER_VERSION;
  readonly parserVersion: string;
  readonly basisHash: string;
  readonly evidence: AnalysisEvidence;
}
export type ManifestAdmission =
  | {
      readonly status: 'source';
      readonly reason: 'absent' | 'stale' | 'unsupported';
      readonly evidence: AnalysisEvidence;
    }
  | {readonly status: 'verified'; readonly evidence: AnalysisEvidence}
  | {
      readonly status: 'refused';
      readonly reason: 'contradictory-manifest';
      readonly evidence: AnalysisEvidence;
      readonly findings: readonly AnalysisFinding[];
    };
