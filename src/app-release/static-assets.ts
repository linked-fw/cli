import fs from 'fs';
import {globSync} from 'glob';
import path from 'path';
import {
  normalizeReleasePath,
  resolveExistingPathWithinRoot,
} from './paths.js';

export const PUBLIC_ROOT = 'public';

/**
 * Resolve `publish.staticAssets` globs to files under the app's `public/`.
 *
 * Both the pattern and every match are checked. Checking only the pattern is
 * not enough: brace expansion escapes it, and `public/{,../}secret/**` expands
 * to `public/../secret/**`, which glob returns as plain `secret/…` paths — a
 * prefix test on the pattern sees `public/` and lets them through. So each
 * match is resolved (following symlinks) and has to land inside `public/`.
 */
export const resolveDeclaredStaticAssets = (
  appRoot: string,
  patterns: string[] = [],
): string[] => {
  const matches = new Set<string>();
  if (patterns.length === 0) return [];
  const publicPath = path.join(appRoot, PUBLIC_ROOT);
  if (!fs.existsSync(publicPath)) {
    throw new Error(
      `static assets are declared but ${PUBLIC_ROOT}/ does not exist in ${appRoot}`,
    );
  }
  const publicRealPath = fs.realpathSync(publicPath);

  for (const pattern of patterns) {
    const normalizedPattern = normalizeReleasePath(pattern, 'static asset pattern');
    if (!isUnderPublicRoot(normalizedPattern)) {
      throw new Error(
        `static asset pattern must stay inside public/: ${pattern}`,
      );
    }

    for (const match of globSync(normalizedPattern, {
      cwd: appRoot,
      nodir: true,
      dot: false,
      follow: false,
    })) {
      const normalizedMatch = normalizeReleasePath(match, 'static asset path');
      const absoluteMatch = resolveExistingPathWithinRoot(
        appRoot,
        normalizedMatch,
      );
      const relativeToPublic = path.relative(publicRealPath, absoluteMatch);
      if (
        !isUnderPublicRoot(normalizedMatch) ||
        relativeToPublic.startsWith('..') ||
        path.isAbsolute(relativeToPublic)
      ) {
        throw new Error(
          `static asset "${match}" (from pattern ${pattern}) resolves outside public/`,
        );
      }
      matches.add(normalizedMatch);
    }
  }

  return [...matches].sort((a, b) => a.localeCompare(b));
};

const isUnderPublicRoot = (normalizedPath: string): boolean =>
  normalizedPath.startsWith(`${PUBLIC_ROOT}/`);

export const relativePublicAssetPath = (
  publicRoot: string,
  absoluteOrRelativePath: string,
): string => {
  const relativePath = path.isAbsolute(absoluteOrRelativePath)
    ? path.relative(publicRoot, absoluteOrRelativePath)
    : absoluteOrRelativePath;
  return normalizeReleasePath(relativePath, 'public asset path');
};

