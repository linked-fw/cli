import {createHash} from 'node:crypto';
import ts from 'typescript';
import {ANALYSIS_SCHEMA_VERSION, ANALYZER_VERSION} from './contracts.js';
import type {AnalysisProfile, SourceSnapshot} from './contracts.js';

export const sourceHash = (code: string): string =>
  createHash('sha256').update(code).digest('hex');
export class AnalysisRefusal extends Error {
  constructor(
    readonly code: string,
    readonly moduleId?: string,
  ) {
    super(code);
  }
}
export const refuse = (code: string, moduleId?: string): never => {
  throw new AnalysisRefusal(code, moduleId);
};
const plain = (value: unknown): value is Record<string, unknown> =>
  !!value &&
  typeof value === 'object' &&
  (Object.getPrototypeOf(value) === Object.prototype ||
    Object.getPrototypeOf(value) === null);

/** Reject executable/exotic carriers before traversing them or calling JSON.stringify. */
export function assertData(value: unknown, depth = 0): void {
  if (depth > 64) refuse('invalid-data-depth');
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (!Array.isArray(value) && !plain(value)) refuse('non-data-input');
  for (const [key, descriptor] of Object.entries(
    Object.getOwnPropertyDescriptors(value),
  )) {
    if (Array.isArray(value) && key === 'length') continue;
    if (!('value' in descriptor)) refuse('non-data-input');
    assertData(descriptor.value, depth + 1);
  }
}
export function stableData(value: unknown): string {
  assertData(value);
  const canonical = (v: any): any =>
    Array.isArray(v)
      ? v.map(canonical)
      : plain(v)
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((key) => [key, canonical(v[key])]),
          )
        : v;
  return JSON.stringify(canonical(value));
}
export function freezeData<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freezeData);
    Object.freeze(value);
  }
  return value;
}
export function validateSnapshot(
  snapshot: SourceSnapshot,
  profile: AnalysisProfile,
): string {
  assertData(snapshot);
  assertData(profile);
  if (profile.id !== ANALYZER_VERSION) refuse('unsupported-profile');
  for (const key of [
    'modules',
    'totalBytes',
    'moduleBytes',
    'referenceDepth',
    'astNodes',
  ] as const)
    if (!Number.isSafeInteger(profile.limits?.[key]) || profile.limits[key] < 1)
      refuse('invalid-limits');
  if (
    !Array.isArray(snapshot.modules) ||
    !Array.isArray(snapshot.entries) ||
    !Array.isArray(snapshot.resolutions) ||
    !Array.isArray(snapshot.declarations?.nodes) ||
    !Array.isArray(snapshot.declarations?.provenance)
  )
    refuse('invalid-snapshot');
  if (snapshot.modules.length > profile.limits.modules) refuse('module-budget');
  if (!/^[a-f0-9]{64}$/.test(snapshot.resolutionHash))
    refuse('invalid-resolution-hash');
  const ids = new Set<string>();
  let bytes = 0;
  for (const m of snapshot.modules) {
    if (
      !m ||
      typeof m.id !== 'string' ||
      !m.id ||
      m.id.startsWith('/') ||
      /^[A-Za-z]:/.test(m.id) ||
      /[\\\u0000-\u001f]/.test(m.id) ||
      m.id.split('/').some((part) => part === '..' || part === '.' || !part) ||
      ids.has(m.id)
    )
      refuse('duplicate-or-invalid-module');
    ids.add(m.id);
    if (
      !['ts', 'tsx', 'js', 'jsx'].includes(m.language) ||
      typeof m.code !== 'string'
    )
      refuse('unsupported-source', m.id);
    const size = Buffer.byteLength(m.code);
    bytes += size;
    if (size > profile.limits.moduleBytes || bytes > profile.limits.totalBytes)
      refuse('source-byte-budget', m.id);
    if (sourceHash(m.code) !== m.hash) refuse('source-hash-mismatch', m.id);
  }
  const edgeKeys = new Set<string>();
  for (const edge of snapshot.resolutions) {
    const key = JSON.stringify([edge.from, edge.specifier]);
    if (
      !ids.has(edge.from) ||
      !ids.has(edge.to) ||
      !edge.specifier ||
      edgeKeys.has(key)
    )
      refuse('ambiguous-module-resolution', edge.from);
    edgeKeys.add(key);
  }
  for (const entry of snapshot.entries)
    if (!ids.has(entry.moduleId) || !entry.exportName)
      refuse('invalid-entry', entry.moduleId);
  if (snapshot.entries.length > profile.limits.modules) refuse('entry-budget');
  if (snapshot.declarations.nodes.length > profile.limits.astNodes)
    refuse('declaration-budget');
  const declarationIds = new Set<string>();
  for (const node of snapshot.declarations.nodes) {
    if (
      typeof node.id !== 'string' ||
      !node.id ||
      !['iri', 'blank'].includes(node.subjectKind ?? 'iri') ||
      typeof node.graphIri !== 'string' ||
      typeof node.packageName !== 'string' ||
      typeof node.capabilityKey !== 'string' ||
      !plain(node.predicates)
    )
      refuse('invalid-declaration-node');
    const key = JSON.stringify([
      node.graphIri,
      node.subjectKind ?? 'iri',
      node.id,
    ]);
    if (declarationIds.has(key)) refuse('duplicate-declaration-node');
    declarationIds.add(key);
    for (const terms of Object.values(node.predicates)) {
      if (!Array.isArray(terms)) refuse('invalid-declaration-predicate');
      for (const term of terms) {
        if (
          !term ||
          typeof term.value !== 'string' ||
          !['iri', 'blank', 'literal'].includes(term.kind)
        )
          refuse('invalid-rdf-term');
        if (
          term.kind !== 'literal' &&
          ('datatype' in term || 'language' in term)
        )
          refuse('invalid-rdf-term');
        if (
          term.kind === 'literal' &&
          ((term.language !== undefined &&
            (typeof term.language !== 'string' || !term.language)) ||
            (term.datatype !== undefined && typeof term.datatype !== 'string'))
        )
          refuse('invalid-rdf-term');
      }
    }
  }
  if (snapshot.declarations.provenance.some((p) => typeof p !== 'string'))
    refuse('invalid-declaration-provenance');
  const roles = new Set<string>();
  if (
    !Array.isArray(profile.conditions) ||
    profile.conditions.some((c) => typeof c !== 'string') ||
    !Array.isArray(profile.trustedBindings)
  )
    refuse('invalid-profile');
  for (const binding of profile.trustedBindings) {
    const module = snapshot.modules.find((m) => m.id === binding.moduleId);
    const key = JSON.stringify([binding.moduleId, binding.exportName]);
    if (
      !module ||
      module.hash !== binding.moduleHash ||
      !binding.exportName ||
      roles.has(key) ||
      ![
        'linkedShape',
        'literalProperty',
        'objectProperty',
        'linkedPackage',
        'createNameSpace',
        'namedNode',
        'Shape',
      ].includes(binding.role)
    )
      refuse('invalid-trusted-binding', binding.moduleId);
    roles.add(key);
  }
  return sourceHash(
    stableData({
      schemaVersion: ANALYSIS_SCHEMA_VERSION,
      analyzerVersion: ANALYZER_VERSION,
      parserVersion: ts.version,
      snapshot: {
        ...snapshot,
        modules: [...snapshot.modules].sort((a, b) => a.id.localeCompare(b.id)),
      },
      profile,
    }),
  );
}
