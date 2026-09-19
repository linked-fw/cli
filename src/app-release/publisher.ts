import crypto from 'crypto';
import fs from 'fs';
import type {IFileStore} from '@_linked/core/interfaces/IFileStore';
import {normalizeAccessURL} from './app-assets-store.js';
import {
  MANIFEST_CONTENT_TYPE,
  MANIFEST_SOURCE_PATH,
  ENTRY_CACHE_CONTROL,
  releaseObjectKey,
} from './create-release-manifest.js';
import {normalizeReleasePath, resolveExistingPathWithinRoot} from './paths.js';
import type {
  LinkedAppReleaseFile,
  LinkedAppReleaseManifest,
  PublishPlan,
  PublishResult,
} from './types.js';

export interface PlanReleasePublishOptions {
  appRoot: string;
  manifestPath?: string;
  store: IFileStore;
}

export interface PublishReleaseOptions extends PlanReleasePublishOptions {
  yes?: boolean;
  onProgress?: (progress: PublishProgress) => void;
  onWarning?: (message: string) => void;
}

export interface PublishProgress {
  completed: number;
  total: number;
  objectKey: string;
}

const readManifest = (
  appRoot: string,
  manifestPath = MANIFEST_SOURCE_PATH,
): {absolutePath: string; manifest: LinkedAppReleaseManifest} => {
  const absolutePath = resolveExistingPathWithinRoot(appRoot, manifestPath);
  const manifest = JSON.parse(
    fs.readFileSync(absolutePath, 'utf8'),
  ) as LinkedAppReleaseManifest;

  if (manifest.schemaVersion !== 1) {
    throw new Error(
      `Unsupported release manifest schema: ${manifest.schemaVersion}`,
    );
  }
  if (manifest.target !== 'web' || manifest.publishable !== true) {
    throw new Error('Only publishable web release manifests may be uploaded');
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new Error('Release manifest contains no files');
  }
  if (!manifest.destination?.releasePrefix) {
    throw new Error('Release manifest has no release prefix');
  }

  return {absolutePath, manifest};
};

/**
 * The manifest records the `accessURL` of the store it was built for. If the
 * configured store now writes somewhere else, the release is not the one that
 * was built and publishing stops. Trailing slashes are not significant.
 */
const validateDestination = (
  manifest: LinkedAppReleaseManifest,
  store: IFileStore,
) => {
  const expected = normalizeAccessURL(manifest.destination.accessURL);
  const actual = normalizeAccessURL(store.accessURL);
  if (expected !== actual) {
    throw new Error(
      `Release destination does not match the manifest (manifest was built for ${
        expected || '(empty)'
      }, the configured appAssets store writes to ${actual || '(empty)'})`,
    );
  }
};

const hashBuffer = (content: Buffer): string =>
  crypto.createHash('sha256').update(content).digest('hex');

/**
 * Re-hash the file on disk before uploading. This needs no support from the
 * store and is what actually guarantees the bytes match the manifest.
 */
const validateLocalFile = (
  appRoot: string,
  file: LinkedAppReleaseFile,
): string => {
  normalizeReleasePath(file.objectKey, 'object key');
  const absolutePath = resolveExistingPathWithinRoot(appRoot, file.sourcePath);
  const content = fs.readFileSync(absolutePath);
  if (content.byteLength !== file.size || hashBuffer(content) !== file.sha256) {
    throw new Error(`Release artifact changed after build: ${file.sourcePath}`);
  }
  return absolutePath;
};

export const planReleasePublish = (
  options: PlanReleasePublishOptions,
): PublishPlan => {
  const {absolutePath, manifest} = readManifest(
    options.appRoot,
    options.manifestPath,
  );
  validateDestination(manifest, options.store);

  for (const file of manifest.files) {
    validateLocalFile(options.appRoot, file);
  }

  return {
    releaseId: manifest.releaseId,
    manifestPath: absolutePath,
    manifestObjectKey: releaseObjectKey(
      manifest.destination.releasePrefix,
      MANIFEST_SOURCE_PATH,
    ),
    destination: manifest.destination,
    files: manifest.files,
    totalBytes: manifest.files.reduce((total, file) => total + file.size, 0),
  };
};

/**
 * Verify one uploaded object against the hash in the manifest.
 *
 * `statFile` is optional on `IFileStore`, and a store that has it may still
 * report no `sha256` (S3 only returns one when the object carries a checksum).
 * Neither case is a failure: verification is skipped, the key is reported back
 * as unverified, and the caller warns once. An `etag` is deliberately not used
 * as a substitute — it is not a content hash.
 */
const verifyUpload = async (
  store: IFileStore,
  objectKey: string,
  expected: {size: number; sha256: string},
): Promise<'verified' | 'unsupported' | 'no-hash'> => {
  if (typeof store.statFile !== 'function') return 'unsupported';

  const stat = await store.statFile(objectKey);
  if (!stat) {
    throw new Error(`Uploaded artifact is missing from the store: ${objectKey}`);
  }
  if (stat.size !== expected.size) {
    throw new Error(
      `Uploaded artifact size does not match the manifest: ${objectKey}`,
    );
  }
  if (!stat.sha256) return 'no-hash';
  if (stat.sha256 !== expected.sha256) {
    throw new Error(`Uploaded artifact verification failed: ${objectKey}`);
  }
  return 'verified';
};

export const publishRelease = async (
  options: PublishReleaseOptions,
): Promise<PublishResult> => {
  const plan = planReleasePublish(options);

  if (!options.yes) {
    return {
      releaseId: plan.releaseId,
      uploadedFiles: 0,
      uploadedBytes: 0,
      dryRun: true,
      unverified: [],
    };
  }

  const unverified: string[] = [];
  let warnedAboutVerification = false;
  const noteUnverified = (objectKey: string, reason: string) => {
    unverified.push(objectKey);
    if (warnedAboutVerification) return;
    warnedAboutVerification = true;
    options.onWarning?.(
      `Cannot verify uploads against a store hash (${reason}). Files are still ` +
        'checked against the manifest before upload; the remote copy is not re-checked.',
    );
  };

  const upload = async (
    objectKey: string,
    content: Buffer,
    contentType: string,
    cacheControl: string,
    sha256: string,
  ) => {
    // `preventDuplicates: false` is explicit: a release key must be exactly the
    // key in the manifest. `LocalFileStore` otherwise appends a random suffix,
    // which would both break the URL and make verification meaningless.
    const storedURL = await options.store.saveFile(objectKey, content, {
      mimeType: contentType,
      cacheControl,
      preventDuplicates: false,
    });
    // A release key has to survive the round trip verbatim, or the published
    // URLs in the bundle point at nothing. Some stores sanitise or suffix the
    // path they are given; say so plainly instead of failing later with a
    // confusing "missing from the store".
    if (typeof storedURL === 'string' && !storedURL.endsWith(objectKey)) {
      throw new Error(
        `The file store did not store the release object under its own key. ` +
          `Expected a location ending in "${objectKey}", got "${storedURL}". ` +
          'A release store must keep object keys verbatim.',
      );
    }
    const outcome = await verifyUpload(options.store, objectKey, {
      size: content.byteLength,
      sha256,
    });
    if (outcome === 'unsupported') {
      noteUnverified(objectKey, 'this store does not implement statFile');
    } else if (outcome === 'no-hash') {
      noteUnverified(objectKey, 'the store reports no sha256 for stored objects');
    }
  };

  const totalUploads = plan.files.length + 1;
  let completedUploads = 0;
  for (const file of plan.files) {
    const absolutePath = resolveExistingPathWithinRoot(
      options.appRoot,
      file.sourcePath,
    );
    await upload(
      file.objectKey,
      fs.readFileSync(absolutePath),
      file.contentType,
      file.cacheControl,
      file.sha256,
    );
    completedUploads += 1;
    options.onProgress?.({
      completed: completedUploads,
      total: totalUploads,
      objectKey: file.objectKey,
    });
  }

  // The manifest goes last: its presence under the release prefix is what marks
  // the release as complete.
  const manifestBody = fs.readFileSync(plan.manifestPath);
  await upload(
    plan.manifestObjectKey,
    manifestBody,
    MANIFEST_CONTENT_TYPE,
    ENTRY_CACHE_CONTROL,
    hashBuffer(manifestBody),
  );
  completedUploads += 1;
  options.onProgress?.({
    completed: completedUploads,
    total: totalUploads,
    objectKey: plan.manifestObjectKey,
  });

  return {
    releaseId: plan.releaseId,
    uploadedFiles: totalUploads,
    uploadedBytes: plan.totalBytes + manifestBody.byteLength,
    dryRun: false,
    unverified,
  };
};
