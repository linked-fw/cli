// `minimatch` rather than a hand-rolled matcher: a `workspaces` negation may
// legally use brace expansion, `?` or a character class (`!packages/{a,b}`), and
// re-deriving that by hand would mis-handle it SILENTLY — which is how the bug
// this module fixes survived in four separate copies. The declared range tracks
// glob@10's own `minimatch` range so the two resolve to one copy; widening it
// past major 9 installs a second copy at the root instead of deduping.
import {minimatch} from 'minimatch';

/**
 * Interpretation of a `package.json` `workspaces` field, npm-compatible.
 *
 * Three places in this CLI walk that field (the Vite source resolver, the
 * linked-package scanner, and the dev HMR watcher). They used to each
 * hand-roll it, and all three ignored NEGATED patterns — so a monorepo that
 * excludes a directory (`"!packages/core"`) still had that directory treated
 * as a workspace member. For CN that meant dev resolving `@_linked/primitives`
 * to an untracked mrgit checkout under `packages/` whose dependencies npm had
 * never installed, and the app not booting. Hence one shared helper.
 *
 * The semantics below are a direct port of npm's own implementation
 * (`@npmcli/map-workspaces@5.0.3`, `appendNegatedPatterns`), verified against
 * it empirically rather than inferred:
 *
 *   ['packages/*']                                -> a, b, c
 *   ['packages/*', '!packages/b']                 -> a, c
 *   ['!packages/b', 'packages/*']                 -> a, c     (order-insensitive)
 *   ['packages/*', '!packages/b', 'packages/b']   -> a, b, c  (re-included)
 *   ['packages/*', '!packages/b', 'packages/*']   -> a, c     (NOT re-included)
 *   ['packages/*', '!packages/b/**']              -> a, c
 *   ['packages/a', 'packages/b', '!packages/b']   -> a        (exact paths too)
 *   ['packages/*', '!packages/*']                 -> (none)
 *   ['!packages/b']                               -> (none)   (no positives)
 *   ['packages/*', '!!packages/b']                -> a, b, c  (even `!` = positive)
 *
 * Note the asymmetry in rows 4 and 5: a positive pattern appearing AFTER a
 * negation cancels it only when the pattern STRING itself matches the negation
 * glob. `packages/b` matches `packages/b`, so the negation is dropped;
 * `packages/*` does not match `packages/b`, so it is not.
 */
export interface WorkspacePatterns {
  /** Positive patterns: `!`-stripped, normalized, negation-pruned. */
  patterns: string[];
  /** Negation patterns: `!`-stripped and normalized, applied as excludes. */
  negatedPatterns: string[];
}

/**
 * Split a raw `workspaces` value into positive and negated patterns.
 *
 * Accepts either the array form or the legacy `{packages: [...]}` object form,
 * and tolerates a missing/garbage value by returning empty lists (a standalone
 * app has no `workspaces` at all — see getLincdPackages).
 */
export function parseWorkspacePatterns(workspaces: unknown): WorkspacePatterns {
  const declaration: unknown = Array.isArray((workspaces as any)?.packages)
    ? (workspaces as any).packages
    : workspaces;
  if (!Array.isArray(declaration)) return {patterns: [], negatedPatterns: []};

  const patterns: string[] = [];
  const negatedPatterns: string[] = [];

  for (const raw of declaration) {
    if (typeof raw !== 'string') continue;
    let pattern = raw;
    const excl = pattern.match(/^!+/);
    if (excl) pattern = pattern.slice(excl[0].length);
    // Windows separators, then a leading `/` or `./`: `/foo` and `./foo` => `foo`.
    pattern = pattern.replace(/\\/g, '/').replace(/^\.?\/+/, '');
    if (!pattern) continue;

    // An ODD number of `!` negates; `!!foo` is the positive `foo`.
    if (excl && excl[0].length % 2 === 1) {
      negatedPatterns.push(pattern);
      continue;
    }

    // A positive pattern cancels an EARLIER negation that matches it, so a
    // later entry can re-include what an earlier one excluded. Order matters,
    // which is why this happens inside the loop and not in one pass at the end.
    for (let i = negatedPatterns.length - 1; i >= 0; i--) {
      if (minimatch(pattern, negatedPatterns[i])) negatedPatterns.splice(i, 1);
    }
    patterns.push(pattern);
  }

  // Drop positive patterns that a negation covers outright, so callers never
  // crawl a directory tree they would discard afterwards.
  for (const negated of negatedPatterns) {
    for (let i = patterns.length - 1; i >= 0; i--) {
      if (minimatch(patterns[i], negated)) patterns.splice(i, 1);
    }
  }

  return {patterns, negatedPatterns};
}

/**
 * Does a candidate package directory fall under one of the negation patterns?
 *
 * `relPath` is the candidate's path relative to the directory the patterns are
 * written against, with `/` separators and no trailing slash — e.g.
 * `packages/core`. Callers that walk outside the root (the CLI's
 * `workspaceGlobs` option takes things like `../lincd.org/modules/*`) pass the
 * `../`-prefixed relative path, which matches the same way.
 *
 * npm applies negations as glob `ignore` patterns. That makes `!packages/b`
 * exclude `packages/b` but NOT its descendants, while a pattern ending in
 * `/**` excludes the directory itself as well as its contents — the
 * `!packages/b/**` row in the table above. Both are reproduced here.
 */
export function isWorkspacePathNegated(
  relPath: string,
  negatedPatterns: string[],
): boolean {
  const rel = relPath.replace(/\\/g, '/').replace(/\/+$/, '');
  for (const negated of negatedPatterns) {
    if (minimatch(rel, negated)) return true;
    if (negated.endsWith('/**') && minimatch(rel, negated.slice(0, -3)))
      return true;
  }
  return false;
}
