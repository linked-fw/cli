export {default as tailwindConfig} from './tailwind.config';
// export {buildMetadata} from './metadata';
export * from './utils';
export {defineConfig} from './defineConfig';
export type {LinkedConfig, LinkedServerConfig} from './interfaces';

export {buildPackageByPath} from './commands/build-package';
export {safeYarn} from './commands/safe-yarn';
export {setupPublish} from './commands/setup-publish';
export {resolveBuildTarget} from './app-release/resolve-build-target';
export {
  buildReleasePrefix,
  createReleaseManifest,
  getCacheControl,
  releaseBaseURL,
  releaseObjectKey,
  releaseStaticAccessURL,
  resolveReleaseIdentity,
  resolveSourceRevision,
  serializeReleaseManifest,
  writeReleaseManifest,
  DEFAULT_RELEASE_PREFIX,
  ENTRY_CACHE_CONTROL,
  IMMUTABLE_CACHE_CONTROL,
  MANIFEST_SOURCE_PATH,
  VITE_OUTPUT_DIR,
} from './app-release/create-release-manifest';
export {resolveDeclaredStaticAssets} from './app-release/static-assets';
export {
  loadReleaseManifest,
  planReleasePublish,
  publishRelease,
} from './app-release/publisher';
export {
  normalizeAccessURL,
  resolveAppAssetsStore,
} from './app-release/app-assets-store';
export {buildViteApp, hasViteConfig} from './commands/build-app';
export {publishApp} from './commands/publish-app';
export {
  serveCompiledApp,
  validateCompiledAppArtifacts,
} from './commands/serve-app';
export {
  joinObjectKey,
  joinStaticAssetUrl,
  normalizeReleasePath,
  resolveExistingPathWithinRoot,
} from './app-release/paths';
export type {
  AppBuildTarget,
  AppPublishConfig,
  BuildAppOptions,
  LinkedAppReleaseDestination,
  LinkedAppReleaseFile,
  LinkedAppReleaseManifest,
  PublishPlan,
  PublishResult,
} from './app-release/types';
export type {
  CreateReleaseManifestOptions,
  ReleaseFileOrigin,
  ReleaseIdentity,
} from './app-release/create-release-manifest';
