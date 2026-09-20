import fs from 'fs';
import path from 'path';

const WINDOWS_ABSOLUTE_PATH = /^[a-zA-Z]:[\\/]/;

export const normalizeReleasePath = (
  value: string,
  label: string = 'release path',
): string => {
  const slashPath = value.replace(/\\/g, '/').trim();

  if (!slashPath || slashPath === '.') {
    throw new Error(`${label} must not be empty`);
  }

  if (path.posix.isAbsolute(slashPath) || WINDOWS_ABSOLUTE_PATH.test(value)) {
    throw new Error(`${label} must be relative: ${value}`);
  }

  const normalized = path.posix.normalize(slashPath).replace(/^\.\//, '');
  if (normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`${label} must stay inside the application root: ${value}`);
  }

  return normalized;
};

export const joinObjectKey = (...segments: string[]): string => {
  if (segments.length === 0) {
    throw new Error('object key must not be empty');
  }

  return normalizeReleasePath(segments.join('/'), 'object key');
};

export const resolveExistingPathWithinRoot = (
  appRoot: string,
  relativePath: string,
): string => {
  const normalized = normalizeReleasePath(relativePath, 'source path');
  const rootRealPath = fs.realpathSync(appRoot);
  const candidateRealPath = fs.realpathSync(path.resolve(rootRealPath, normalized));
  const relativeToRoot = path.relative(rootRealPath, candidateRealPath);

  if (
    relativeToRoot === '..' ||
    relativeToRoot.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeToRoot)
  ) {
    throw new Error(`source path escapes the application root: ${relativePath}`);
  }

  return candidateRealPath;
};

export const joinStaticAssetUrl = (
  publicBaseUrl: string,
  assetPath: string,
): string => {
  const normalizedAssetPath = normalizeReleasePath(assetPath, 'asset path');
  const normalizedBaseUrl = publicBaseUrl.trim().replace(/\/+$/, '');

  if (!normalizedBaseUrl) {
    throw new Error('public base URL must not be empty');
  }

  return `${normalizedBaseUrl}/${normalizedAssetPath}`;
};

