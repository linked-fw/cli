/** Pure source-analysis subpath. Deliberately not exported from the CLI root. */
export {
  ANALYSIS_SCHEMA_VERSION,
  ANALYZER_VERSION,
  DEFAULT_LIMITS,
} from './contracts.js';
export type {
  RdfTerm,
  DeclarationGraph,
  SourceRef,
  ExportRef,
  SourceModule,
  SourceSnapshot,
  BindingRole,
  AnalysisLimits,
  AnalysisProfile,
  AnalysisFinding,
  RangeRef,
  AccessorEvidence,
  ShapeEvidence,
  AnalysisEvidence,
  PackageAnalysisManifest,
  ManifestAdmission,
} from './contracts.js';
export {analyzeSource} from './shapeAnalysis.js';
export {
  createManifest,
  serializeManifest,
  validateManifest,
} from './manifest.js';
export {AnalysisRefusal, sourceHash} from './snapshot.js';
