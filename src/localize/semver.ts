/**
 * The range check drift makes, for TypeScript callers: whether a checkout
 * meets a declared range. `hooks/drift.cjs` applies the same rule in plain
 * CommonJS for the hooks.
 */
import semver from 'semver';

/**
 * Does the app's installed `version` satisfy `range`? `null` means "cannot
 * tell" -- a dist-tag, `file:`, `npm:`, `workspace:`, a git URL, or a version
 * that is not one -- and drift then reports nothing: npm links the checkout
 * for such a range anyway.
 *
 * npm's own `semver` decides, so prereleases follow npm's rule: `1.3.0-beta.1`
 * satisfies a range only when one of its comparators names a prerelease on
 * the same `major.minor.patch`.
 */
export function satisfies(version: string, range: string): boolean | null {
  if (typeof version !== 'string' || typeof range !== 'string') return null;
  if (semver.valid(version) === null) return null;
  if (semver.validRange(range) === null) return null;
  return semver.satisfies(version, range);
}
