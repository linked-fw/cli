import {ANALYSIS_SCHEMA_VERSION, ANALYZER_VERSION} from './contracts.js';
import type {
  AnalysisProfile,
  ManifestAdmission,
  PackageAnalysisManifest,
  SourceSnapshot,
} from './contracts.js';
import {analyzeSource} from './shapeAnalysis.js';
import {assertData, freezeData, stableData} from './snapshot.js';

/** The producer and consumer share the same extractor. No timestamp byte churn. */
export function createManifest(
  snapshot: SourceSnapshot,
  profile: AnalysisProfile,
): PackageAnalysisManifest {
  const evidence = analyzeSource(snapshot, profile);
  return freezeData({
    schemaVersion: ANALYSIS_SCHEMA_VERSION,
    analyzerVersion: ANALYZER_VERSION,
    parserVersion: evidence.parserVersion,
    basisHash: evidence.basisHash,
    evidence,
  });
}
export function serializeManifest(manifest: PackageAnalysisManifest): string {
  return stableData(manifest) + '\n';
}

export function validateManifest(
  manifest: unknown,
  snapshot: SourceSnapshot,
  profile: AnalysisProfile,
): ManifestAdmission {
  const evidence = analyzeSource(snapshot, profile);
  if (manifest === null || manifest === undefined)
    return freezeData({status: 'source', reason: 'absent', evidence});
  try {
    assertData(manifest);
  } catch {
    return freezeData({status: 'source', reason: 'unsupported', evidence});
  }
  const m = manifest as Partial<PackageAnalysisManifest>;
  if (
    !m ||
    typeof m !== 'object' ||
    m.schemaVersion !== ANALYSIS_SCHEMA_VERSION ||
    m.analyzerVersion !== ANALYZER_VERSION ||
    m.parserVersion !== evidence.parserVersion ||
    !m.evidence ||
    typeof m.basisHash !== 'string'
  )
    return freezeData({status: 'source', reason: 'unsupported', evidence});
  if (m.basisHash !== evidence.basisHash)
    return freezeData({status: 'source', reason: 'stale', evidence});
  // First version rederives claims. Hashes cannot attest semantic truth, and
  // arbitrary package JSON must not invent exports. Subset acceleration can
  // follow only with the same proof; this version makes no speedup claim.
  if (stableData(m.evidence) !== stableData(evidence))
    return freezeData({
      status: 'refused',
      reason: 'contradictory-manifest',
      evidence,
      findings: [
        {
          code: 'contradictory-manifest',
          affectedIds: snapshot.entries.map(
            (e) => `${e.moduleId}#${e.exportName}`,
          ),
          provenance: evidence.shapes.flatMap((s) => s.provenance),
        },
      ],
    });
  return freezeData({status: 'verified', evidence});
}
