import {
  analyzeSource,
  createManifest,
  serializeManifest,
  validateManifest,
} from '../../src/source-analysis/index.js';
import {fixture} from './sourceAnalysisFixtures.js';

describe('optional manifest admission', () => {
  test('absent: source-only remains fully usable', () => {
    const {snapshot, profile} = fixture();
    const r = validateManifest(undefined, snapshot, profile);
    expect(r.status).toBe('source');
    expect(r.evidence).toEqual(analyzeSource(snapshot, profile));
  });
  test('two-builds-identical: stable data round-trips byte-identically', () => {
    const {snapshot, profile} = fixture();
    const bytes = serializeManifest(createManifest(snapshot, profile));
    expect(serializeManifest(createManifest(snapshot, profile))).toBe(bytes);
    expect(serializeManifest(JSON.parse(bytes))).toBe(bytes);
    expect(validateManifest(JSON.parse(bytes), snapshot, profile).status).toBe(
      'verified',
    );
  });
  test('manifest-drift: changed declaration/conditions declines stale acceleration', () => {
    const {snapshot, profile} = fixture();
    const m = createManifest(snapshot, profile);
    const r = validateManifest(m, snapshot, {
      ...profile,
      conditions: ['browser', 'import'],
    });
    expect(r).toMatchObject({status: 'source', reason: 'stale'});
    expect(r.evidence.basisHash).not.toBe(m.basisHash);
  });
  test('manifest-false-claim: a fresh hash cannot invent an export', () => {
    const {snapshot, profile} = fixture();
    const m = JSON.parse(serializeManifest(createManifest(snapshot, profile)));
    m.evidence.shapes[0].entry.exportName = 'Invented';
    const r = validateManifest(m, snapshot, profile);
    expect(r.status).toBe('refused');
    expect(r.evidence.shapes[0].entry.exportName).toBe('Card');
    if (r.status === 'refused')
      expect(r.findings[0].provenance.length).toBeGreaterThan(0);
  });
  test('unsupported-schema: explicit fallback, not a requirement to rebuild', () => {
    const {snapshot, profile} = fixture();
    expect(
      validateManifest({schemaVersion: 99}, snapshot, profile),
    ).toMatchObject({status: 'source', reason: 'unsupported'});
  });
  test('executable-carrier: never invokes a getter or toJSON', () => {
    const {snapshot, profile} = fixture();
    let ran = false;
    const malicious = {
      get schemaVersion() {
        ran = true;
        return 1;
      },
      toJSON() {
        ran = true;
        return {};
      },
    };
    expect(validateManifest(malicious, snapshot, profile)).toMatchObject({
      status: 'source',
      reason: 'unsupported',
    });
    expect(ran).toBe(false);
  });
});
