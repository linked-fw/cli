import crypto from 'crypto';
import {execFileSync} from 'child_process';
import fs from 'fs';
import path from 'path';
import {
  joinObjectKey,
  normalizeReleasePath,
  resolveExistingPathWithinRoot,
} from './paths.js';
import {resolveDeclaredStaticAssets} from './static-assets.js';
import type {
  AppBuildTarget,
  LinkedAppReleaseFile,
  LinkedAppReleaseManifest,
} from './types.js';

interface ViteManifestEntry {
  file: string;
  css?: string[];
  assets?: string[];
  imports?: string[];
  dynamicImports?: string[];
}

type ViteManifest = Record<string, ViteManifestEntry>;

export interface CreateReleaseManifestOptions {
  appRoot: string;
  environmentNames: string[];
  target: AppBuildTarget;
  /**
   * `accessURL` of the store this release will be published to. Omitted (or
   * null) for a Capacitor build, which produces a local, non-publishable
   * manifest and never touches a file store.
   */
  accessURL?: string | null;
  staticAssets?: string[];
  /** Base key releases are nested under. Defaults to `releases`. */
  releasePrefix?: string;
  builtAt?: string;
  sourceRevision?: string;
}

const MIME_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

const HASH_CHARACTERS = /^[A-Za-z0-9_-]{8,}$/;

/**
 * Does the last `name-HASH.ext` / `name.HASH.ext` segment look like a content
 * hash? Vite's default names are base64url (`main-hwqwrAvA.css`), not hex, so
 * a hex-only test silently marks real bundle output as uncacheable. A segment
 * counts as a hash when it is at least 8 characters of Vite's alphabet and is
 * not plain lowercase prose — it must carry a digit or mix upper and lower
 * case, which `index`, `manifest` and `release` do not.
 */
const looksContentHashed = (baseName: string): boolean => {
  const withoutExtension = baseName.replace(/\.[^.]+$/, '');
  const separator = Math.max(
    withoutExtension.lastIndexOf('.'),
    withoutExtension.lastIndexOf('-'),
    withoutExtension.lastIndexOf('_'),
  );
  if (separator === -1) return false;

  const candidate = withoutExtension.slice(separator + 1);
  if (!HASH_CHARACTERS.test(candidate)) return false;
  return (
    /\d/.test(candidate) ||
    (/[a-z]/.test(candidate) && /[A-Z]/.test(candidate))
  );
};

export const DEFAULT_RELEASE_PREFIX = 'releases';
export const MANIFEST_FILE_NAME = 'linked-release.json';
export const MANIFEST_SOURCE_PATH = `public/bundles/${MANIFEST_FILE_NAME}`;
export const MANIFEST_CONTENT_TYPE = 'application/json; charset=utf-8';

/**
 * Cache-Control rule. A filename carrying a content hash can never change
 * behind a given key, so it is immutable for a year. Everything else — entry
 * files such as `index.html`, and the release manifest — is revalidated after
 * a minute, so a re-published release is picked up quickly.
 */
export const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';
export const ENTRY_CACHE_CONTROL = 'public, max-age=60, must-revalidate';

const getContentType = (filePath: string): string =>
  MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';

export const getCacheControl = (filePath: string): string =>
  looksContentHashed(path.basename(filePath))
    ? IMMUTABLE_CACHE_CONTROL
    : ENTRY_CACHE_CONTROL;

const getSourceRevision = (appRoot: string): string => {
  try {
    return execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], {
      cwd: appRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    throw new Error(
      'Cannot determine the Git revision for this web release. Commit the build source or provide sourceRevision.',
    );
  }
};

const collectViteOutputPaths = (manifest: ViteManifest): string[] => {
  const files = new Set<string>();

  for (const [entryName, entry] of Object.entries(manifest)) {
    if (!entry || typeof entry.file !== 'string') {
      throw new Error(`Invalid Vite manifest entry: ${entryName}`);
    }

    files.add(joinObjectKey('public/bundles', entry.file));
    for (const relativePath of [...(entry.css || []), ...(entry.assets || [])]) {
      files.add(joinObjectKey('public/bundles', relativePath));
    }

    for (const importedEntry of [
      ...(entry.imports || []),
      ...(entry.dynamicImports || []),
    ]) {
      if (!manifest[importedEntry]) {
        throw new Error(
          `Vite manifest entry ${entryName} references missing import ${importedEntry}`,
        );
      }
    }
  }

  return [...files];
};

/**
 * Build the key prefix for one release. Every object of a release lives under
 * it, so publishing a new release cannot overwrite the previous one and a
 * rollback is a matter of pointing at the older prefix.
 */
export const buildReleasePrefix = (
  releaseId: string,
  basePrefix: string = DEFAULT_RELEASE_PREFIX,
): string => joinObjectKey(basePrefix, releaseId);

export const releaseObjectKey = (
  releasePrefix: string,
  sourcePath: string,
): string => joinObjectKey(releasePrefix, sourcePath);

const describeReleaseFile = (
  appRoot: string,
  releasePrefix: string,
  sourcePath: string,
): LinkedAppReleaseFile => {
  const normalizedSourcePath = normalizeReleasePath(sourcePath, 'source path');
  const absolutePath = resolveExistingPathWithinRoot(appRoot, normalizedSourcePath);
  const content = fs.readFileSync(absolutePath);

  return {
    sourcePath: normalizedSourcePath,
    objectKey: releaseObjectKey(releasePrefix, normalizedSourcePath),
    sha256: crypto.createHash('sha256').update(content).digest('hex'),
    size: content.byteLength,
    contentType: getContentType(normalizedSourcePath),
    cacheControl: getCacheControl(normalizedSourcePath),
  };
};

export const createReleaseManifest = (
  options: CreateReleaseManifestOptions,
): LinkedAppReleaseManifest => {
  const packageJsonPath = path.join(options.appRoot, 'package.json');
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  const sourceRevision = options.sourceRevision || getSourceRevision(options.appRoot);
  const publicRoot = 'public';
  const releaseId = `${packageJson.version}-${sourceRevision}`;
  const releasePrefix = buildReleasePrefix(releaseId, options.releasePrefix);

  // A Capacitor build ships its assets inside the native app, so it produces a
  // manifest for local inspection only and is never uploaded. That is why it
  // needs no destination and is marked unpublishable.
  const publishable = options.target === 'web';
  if (publishable && options.accessURL === undefined) {
    throw new Error(
      'A web release manifest requires the accessURL of the store it will be published to',
    );
  }

  let sourcePaths: string[] = [];
  if (options.target === 'web') {
    const viteManifestPath = path.join(
      options.appRoot,
      'public/bundles/.vite/manifest.json',
    );
    const viteManifest = JSON.parse(
      fs.readFileSync(viteManifestPath, 'utf8'),
    ) as ViteManifest;
    sourcePaths = collectViteOutputPaths(viteManifest);
  }

  sourcePaths.push(
    ...resolveDeclaredStaticAssets(options.appRoot, options.staticAssets),
  );

  const files = [...new Set(sourcePaths)]
    .map((sourcePath) =>
      describeReleaseFile(options.appRoot, releasePrefix, sourcePath),
    )
    .sort((a, b) => a.objectKey.localeCompare(b.objectKey));

  return {
    schemaVersion: 1,
    appName: packageJson.name,
    appVersion: packageJson.version,
    releaseId,
    target: options.target,
    publishable,
    builtAt: options.builtAt || new Date().toISOString(),
    environmentNames: [...options.environmentNames],
    publicRoot,
    destination: {
      accessURL: options.accessURL || '',
      releasePrefix,
    },
    files,
  };
};

export const serializeReleaseManifest = (
  manifest: LinkedAppReleaseManifest,
): string => `${JSON.stringify(manifest, null, 2)}\n`;

export const writeReleaseManifest = (
  appRoot: string,
  manifest: LinkedAppReleaseManifest,
): string => {
  const outputPath = path.join(appRoot, MANIFEST_SOURCE_PATH);
  fs.writeFileSync(outputPath, serializeReleaseManifest(manifest));
  return outputPath;
};
