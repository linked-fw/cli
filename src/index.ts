export {default as tailwindConfig} from './tailwind.config.js';
// export {buildMetadata} from './metadata.js';
export * from './utils.js';
export {defineConfig} from './defineConfig.js';
export type {LinkedConfig, LinkedServerConfig} from './interfaces.js';

export {buildPackageByPath} from './commands/build-package.js';
export {setupPublish} from './commands/setup-publish.js';
export {resolveBuildTarget} from './app-release/resolve-build-target.js';
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
} from './app-release/create-release-manifest.js';
export {resolveDeclaredStaticAssets} from './app-release/static-assets.js';
export {
  loadReleaseManifest,
  planReleasePublish,
  publishRelease,
} from './app-release/publisher.js';
export {
  normalizeAccessURL,
  resolveAppAssetsStore,
} from './app-release/app-assets-store.js';
export {buildViteApp, hasViteConfig} from './commands/build-app.js';
export {publishApp} from './commands/publish-app.js';
export {
  serveCompiledApp,
  validateCompiledAppArtifacts,
} from './commands/serve-app.js';
export {
  joinObjectKey,
  joinStaticAssetUrl,
  normalizeReleasePath,
  resolveExistingPathWithinRoot,
} from './app-release/paths.js';
export type {
  AppBuildTarget,
  AppPublishConfig,
  BuildAppOptions,
  LinkedAppReleaseDestination,
  LinkedAppReleaseFile,
  LinkedAppReleaseManifest,
  PublishPlan,
  PublishResult,
} from './app-release/types.js';
export type {
  CreateReleaseManifestOptions,
  ReleaseFileOrigin,
  ReleaseIdentity,
} from './app-release/create-release-manifest.js';
