/**
 * The one range check localize makes: drift (drift.ts) asks whether a
 * checkout meets a declared range, and pruning whether the app's copy does.
 */
import semver from 'semver';

/**
 * Does the app's installed `version` satisfy `range`? `null` means "cannot
 * tell" -- a dist-tag, `file:`, `npm:`, `workspace:`, a git URL, or a version
 * that is not one -- and every caller then keeps the copy. The failure mode is
 * therefore always the safe one: a copy kept that could have gone, never a
 * copy removed that was needed.
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
