import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type {IArtifactStore} from '@_linked/core/interfaces/IArtifactStore';
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
  store: IArtifactStore;
}

export interface PublishReleaseOptions extends PlanReleasePublishOptions {
  yes?: boolean;
}

const DEFAULT_MANIFEST_PATH = 'public/bundles/linked-release.json';

const readManifest = (
  appRoot: string,
  manifestPath = DEFAULT_MANIFEST_PATH,
): {absolutePath: string; manifest: LinkedAppReleaseManifest} => {
  const absolutePath = resolveExistingPathWithinRoot(appRoot, manifestPath);
  const manifest = JSON.parse(
    fs.readFileSync(absolutePath, 'utf8'),
  ) as LinkedAppReleaseManifest;

  if (manifest.schemaVersion !== 1) {
    throw new Error(`Unsupported release manifest schema: ${manifest.schemaVersion}`);
  }
  if (manifest.target !== 'web' || manifest.publishable !== true) {
    throw new Error('Only publishable web release manifests may be uploaded');
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new Error('Release manifest contains no files');
  }

  return {absolutePath, manifest};
};

const sameOptionalValue = (a?: string, b?: string): boolean =>
  (a || '').replace(/\/+$/, '') === (b || '').replace(/\/+$/, '');

const validateDestination = (
  manifest: LinkedAppReleaseManifest,
  store: IArtifactStore,
) => {
  const actual = store.describeDestination();
  if (
    actual.bucket !== manifest.destination.bucket ||
    actual.prefix !== manifest.destination.destinationPrefix ||
    !sameOptionalValue(actual.endpoint, manifest.destination.endpoint) ||
    !sameOptionalValue(actual.publicBaseUrl, manifest.destination.publicBaseUrl)
  ) {
    throw new Error(
      `Static destination does not match release manifest (expected bucket ${manifest.destination.bucket}, prefix ${manifest.destination.destinationPrefix})`,
    );
  }
  return actual;
};

const hashFile = (absolutePath: string): string =>
  crypto.createHash('sha256').update(fs.readFileSync(absolutePath)).digest('hex');

const validateLocalFile = (
  appRoot: string,
  file: LinkedAppReleaseFile,
): string => {
  normalizeReleasePath(file.objectKey, 'object key');
  const absolutePath = resolveExistingPathWithinRoot(appRoot, file.sourcePath);
  const stat = fs.statSync(absolutePath);
  if (stat.size !== file.size || hashFile(absolutePath) !== file.sha256) {
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
    manifestPath: absolutePath,
    destination: manifest.destination,
    files: manifest.files,
    totalBytes: manifest.files.reduce((total, file) => total + file.size, 0),
  };
};

const verifyArtifact = async (
  store: IArtifactStore,
  file: LinkedAppReleaseFile,
) => {
  const metadata = await store.statArtifact(file.objectKey);
  if (metadata.size !== file.size || metadata.sha256 !== file.sha256) {
    throw new Error(`Uploaded artifact verification failed: ${file.objectKey}`);
  }
};

export const publishRelease = async (
  options: PublishReleaseOptions,
): Promise<PublishResult> => {
  const {manifest} = readManifest(options.appRoot, options.manifestPath);
  const plan = planReleasePublish(options);

  if (!options.yes) {
    return {
      releaseId: manifest.releaseId,
      uploadedFiles: 0,
      uploadedBytes: 0,
      dryRun: true,
    };
  }

  for (const file of plan.files) {
    const absolutePath = resolveExistingPathWithinRoot(
      options.appRoot,
      file.sourcePath,
    );
    await options.store.putArtifact({
      key: file.objectKey,
      body: fs.readFileSync(absolutePath),
      contentType: file.contentType,
      cacheControl: file.cacheControl,
      sha256: file.sha256,
    });
    await verifyArtifact(options.store, file);
  }

  const manifestBody = fs.readFileSync(plan.manifestPath);
  const manifestKey = DEFAULT_MANIFEST_PATH;
  const manifestHash = crypto.createHash('sha256').update(manifestBody).digest('hex');
  await options.store.putArtifact({
    key: manifestKey,
    body: manifestBody,
    contentType: 'application/json; charset=utf-8',
    cacheControl: 'no-cache',
    sha256: manifestHash,
  });
  const manifestMetadata = await options.store.statArtifact(manifestKey);
  if (
    manifestMetadata.size !== manifestBody.byteLength ||
    manifestMetadata.sha256 !== manifestHash
  ) {
    throw new Error('Uploaded release manifest verification failed');
  }

  return {
    releaseId: manifest.releaseId,
    uploadedFiles: plan.files.length + 1,
    uploadedBytes: plan.totalBytes + manifestBody.byteLength,
    dryRun: false,
  };
};

