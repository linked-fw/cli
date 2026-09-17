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
  LinkedAppReleaseDestination,
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
  destination: LinkedAppReleaseDestination;
  staticAssets?: string[];
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

const HASHED_ASSET = /(?:^|[._-])[a-f0-9]{8,}(?:[._-]|$)/i;

const getContentType = (filePath: string): string =>
  MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';

const getCacheControl = (filePath: string): string =>
  HASHED_ASSET.test(path.basename(filePath))
    ? 'public, max-age=31536000, immutable'
    : 'no-cache';

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

const describeReleaseFile = (
  appRoot: string,
  sourcePath: string,
): LinkedAppReleaseFile => {
  const normalizedSourcePath = normalizeReleasePath(sourcePath, 'source path');
  const absolutePath = resolveExistingPathWithinRoot(appRoot, normalizedSourcePath);
  const content = fs.readFileSync(absolutePath);

  return {
    sourcePath: normalizedSourcePath,
    objectKey: normalizedSourcePath,
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
    .map((sourcePath) => describeReleaseFile(options.appRoot, sourcePath))
    .sort((a, b) => a.objectKey.localeCompare(b.objectKey));

  return {
    schemaVersion: 1,
    appName: packageJson.name,
    appVersion: packageJson.version,
    releaseId: `${packageJson.version}-${sourceRevision}`,
    target: options.target,
    publishable: options.target === 'web',
    builtAt: options.builtAt || new Date().toISOString(),
    environmentNames: [...options.environmentNames],
    publicRoot,
    destination: {
      ...options.destination,
      destinationPrefix: normalizeReleasePath(
        options.destination.destinationPrefix,
        'destination prefix',
      ),
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
  const outputPath = path.join(
    appRoot,
    'public/bundles/linked-release.json',
  );
  fs.writeFileSync(outputPath, serializeReleaseManifest(manifest));
  return outputPath;
};

