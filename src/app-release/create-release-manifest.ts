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
  /** Allow a revision derived from a working tree with uncommitted changes. */
  allowDirty?: boolean;
  /**
   * Public URL every asset of this release is served from — the release
   * prefix resolved against the store's `accessURL`, and the value the client
   * bundle was built with as Vite's `base`. Empty for a Capacitor build.
   */
  baseURL?: string;
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

export const DEFAULT_RELEASE_PREFIX = 'releases';
export const MANIFEST_FILE_NAME = 'linked-release.json';
export const MANIFEST_SOURCE_PATH = `public/bundles/${MANIFEST_FILE_NAME}`;
export const MANIFEST_CONTENT_TYPE = 'application/json; charset=utf-8';

/**
 * Cache-Control rule, decided by where a file came from rather than by what it
 * is called.
 *
 * Files listed in the Vite manifest are content-hashed by construction — Vite
 * emitted the name, so the bytes behind that key can never change and the
 * object is immutable for a year. Everything else (declared static assets, the
 * release manifest) is revalidated after a minute, so a re-published release is
 * picked up quickly. Guessing "is this hashed?" from the filename was tried and
 * removed: `og-image-1200x630.png`, `sw-v20260101.js` and `icon-FacebookRound.svg`
 * all read as hashed, and a year of immutable caching on those cannot be undone
 * without renaming the file.
 */
export const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';
export const ENTRY_CACHE_CONTROL = 'public, max-age=60, must-revalidate';

/** Where a release file came from; this is what decides its cache policy. */
export type ReleaseFileOrigin = 'vite-bundle' | 'static-asset';

const getContentType = (filePath: string): string =>
  MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';

export const getCacheControl = (origin: ReleaseFileOrigin): string =>
  origin === 'vite-bundle' ? IMMUTABLE_CACHE_CONTROL : ENTRY_CACHE_CONTROL;

/** A revision has to be safe to embed in an object key and a URL. */
const SAFE_REVISION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const runGit = (appRoot: string, args: string[]): string =>
  execFileSync('git', args, {
    cwd: appRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });

export interface ResolveSourceRevisionOptions {
  appRoot: string;
  /** `--revision`, or a caller-supplied value. Used verbatim when given. */
  revision?: string;
  /** `--allow-dirty`: build from a dirty tree, tagging the revision `-dirty`. */
  allowDirty?: boolean;
  env?: NodeJS.ProcessEnv;
}

/**
 * Determine the revision that identifies this release.
 *
 * An explicit `--revision`, then `LINKED_RELEASE_REVISION`, then `GITHUB_SHA`
 * win over Git, so a release can be built from an exported tarball or a CI
 * checkout that is not a working repository. Falling back to `git rev-parse`
 * requires a clean tree: two builds of the same uncommitted work would
 * otherwise share a release ID and a prefix, silently overwriting each other
 * while files removed in between linger under the prefix.
 */
export const resolveSourceRevision = ({
  appRoot,
  revision,
  allowDirty,
  env = process.env,
}: ResolveSourceRevisionOptions): string => {
  const explicit = (
    revision ||
    env.LINKED_RELEASE_REVISION ||
    env.GITHUB_SHA ||
    ''
  ).trim();
  if (explicit) {
    if (!SAFE_REVISION.test(explicit)) {
      throw new Error(
        `Invalid release revision "${explicit}". Use letters, digits, ".", "-" or "_".`,
      );
    }
    return explicit;
  }

  let head: string;
  try {
    head = runGit(appRoot, ['rev-parse', '--short=12', 'HEAD']).trim();
  } catch {
    throw new Error(
      'Cannot determine the Git revision for this release. Build from a Git checkout, ' +
        'or pass --revision <sha> (or set LINKED_RELEASE_REVISION / GITHUB_SHA).',
    );
  }

  let dirty = false;
  try {
    dirty = runGit(appRoot, ['status', '--porcelain']).trim().length > 0;
  } catch {
    // `rev-parse` worked, so this is a repository; treat an unreadable status
    // as clean rather than blocking the build on a Git quirk.
  }
  if (!dirty) return head;
  if (!allowDirty) {
    throw new Error(
      `The working tree has uncommitted changes, so release ${head} would not identify ` +
        'what was built: a second build of the same edits reuses the prefix and overwrites it. ' +
        'Commit or stash the changes, pass --allow-dirty to publish as ' +
        `"${head}-dirty", or pass --revision <sha>.`,
    );
  }
  return `${head}-dirty`;
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

/** Directory `vite build` writes the client bundle to. See the README. */
export const VITE_OUTPUT_DIR = 'public/bundles';

/**
 * Public URL the client bundle of a release is served from. Object keys are
 * `<releasePrefix>/public/bundles/…` under the store's `accessURL`, and this is
 * the value the build passes to Vite as `base`, so the root-absolute URLs the
 * bundle emits for its own chunks and assets resolve under the release prefix
 * without any server rewrite.
 */
export const releaseBaseURL = (
  accessURL: string,
  releasePrefix: string,
): string =>
  `${releaseStaticAccessURL(accessURL, releasePrefix)}/${VITE_OUTPUT_DIR}/`;

/**
 * The release's root URL: `accessURL` plus the release prefix, without the
 * bundle directory. `@_linked/server` builds the HTML entry tags as
 * `${STATIC_ACCESS_URL}/public/bundles/<file>`, so pointing `STATIC_ACCESS_URL`
 * at this value is what makes a running app serve one particular release —
 * a value to deploy, not server code to write or a rewrite rule to configure.
 */
export const releaseStaticAccessURL = (
  accessURL: string,
  releasePrefix: string,
): string =>
  `${(accessURL || '').trim().replace(/\/+$/, '')}/${releasePrefix}`;

export interface ReleaseIdentity {
  appName: string;
  appVersion: string;
  sourceRevision: string;
  releaseId: string;
  releasePrefix: string;
}

/**
 * Work out the release ID and prefix before anything is built. The client
 * bundle has to be built with the release prefix as its `base`, so the prefix
 * cannot wait until the manifest is written.
 */
export const resolveReleaseIdentity = (options: {
  appRoot: string;
  releasePrefix?: string;
  sourceRevision?: string;
  allowDirty?: boolean;
  env?: NodeJS.ProcessEnv;
}): ReleaseIdentity => {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(options.appRoot, 'package.json'), 'utf8'),
  );
  const sourceRevision = resolveSourceRevision({
    appRoot: options.appRoot,
    revision: options.sourceRevision,
    allowDirty: options.allowDirty,
    env: options.env,
  });
  const releaseId = `${packageJson.version}-${sourceRevision}`;
  return {
    appName: packageJson.name,
    appVersion: packageJson.version,
    sourceRevision,
    releaseId,
    releasePrefix: buildReleasePrefix(releaseId, options.releasePrefix),
  };
};

const describeReleaseFile = (
  appRoot: string,
  releasePrefix: string,
  sourcePath: string,
  origin: ReleaseFileOrigin,
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
    cacheControl: getCacheControl(origin),
  };
};

export const createReleaseManifest = (
  options: CreateReleaseManifestOptions,
): LinkedAppReleaseManifest => {
  const identity = resolveReleaseIdentity({
    appRoot: options.appRoot,
    releasePrefix: options.releasePrefix,
    sourceRevision: options.sourceRevision,
    allowDirty: options.allowDirty,
  });
  const {releasePrefix} = identity;

  // A Capacitor build ships its assets inside the native app, so it produces a
  // manifest for local inspection only and is never uploaded. That is why it
  // needs no destination and is marked unpublishable.
  const publishable = options.target === 'web';
  if (publishable && options.accessURL === undefined) {
    throw new Error(
      'A web release manifest requires the accessURL of the store it will be published to',
    );
  }

  // Origin decides the cache policy: Vite named these files after their own
  // content, so they are immutable; declared static assets keep their name
  // across releases and must be revalidated.
  const origins = new Map<string, ReleaseFileOrigin>();
  if (options.target === 'web') {
    const viteManifestPath = path.join(
      options.appRoot,
      `${VITE_OUTPUT_DIR}/.vite/manifest.json`,
    );
    const viteManifest = JSON.parse(
      fs.readFileSync(viteManifestPath, 'utf8'),
    ) as ViteManifest;
    for (const sourcePath of collectViteOutputPaths(viteManifest)) {
      origins.set(sourcePath, 'vite-bundle');
    }
  }
  for (const sourcePath of resolveDeclaredStaticAssets(
    options.appRoot,
    options.staticAssets,
  )) {
    if (!origins.has(sourcePath)) origins.set(sourcePath, 'static-asset');
  }

  const files = [...origins.entries()]
    .map(([sourcePath, origin]) =>
      describeReleaseFile(options.appRoot, releasePrefix, sourcePath, origin),
    )
    .sort((a, b) => a.objectKey.localeCompare(b.objectKey));

  return {
    schemaVersion: 1,
    appName: identity.appName,
    appVersion: identity.appVersion,
    releaseId: identity.releaseId,
    target: options.target,
    publishable,
    builtAt: options.builtAt || new Date().toISOString(),
    environmentNames: [...options.environmentNames],
    destination: {
      accessURL: options.accessURL || '',
      releasePrefix,
      baseURL:
        options.baseURL ??
        (options.accessURL
          ? releaseBaseURL(options.accessURL, releasePrefix)
          : ''),
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
