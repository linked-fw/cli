import {globSync} from 'glob';
import path from 'path';
import {
  normalizeReleasePath,
  resolveExistingPathWithinRoot,
} from './paths.js';

export const resolveDeclaredStaticAssets = (
  appRoot: string,
  patterns: string[] = [],
): string[] => {
  const matches = new Set<string>();

  for (const pattern of patterns) {
    const normalizedPattern = normalizeReleasePath(pattern, 'static asset pattern');
    if (!normalizedPattern.startsWith('public/')) {
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
      resolveExistingPathWithinRoot(appRoot, normalizedMatch);
      matches.add(normalizedMatch);
    }
  }

  return [...matches].sort((a, b) => a.localeCompare(b));
};

export const relativePublicAssetPath = (
  publicRoot: string,
  absoluteOrRelativePath: string,
): string => {
  const relativePath = path.isAbsolute(absoluteOrRelativePath)
    ? path.relative(publicRoot, absoluteOrRelativePath)
    : absoluteOrRelativePath;
  return normalizeReleasePath(relativePath, 'public asset path');
};

