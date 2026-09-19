export {default as DeclarationPlugin} from './plugins/declaration-plugin';
export {default as externaliseModules} from './plugins/externalise-modules';
// './plugins/check-imports' is a webpack loader (CJS, uses require()). It must
// NOT be re-exported here — importing the @_linked/cli barrel would force it
// to evaluate in ESM context and crash. Webpack loads it via file path in
// config-webpack.ts.
export {default as tailwindConfig} from './tailwind.config';
// export {buildMetadata} from './metadata';
import {generateWebpackConfig} from './config-webpack.js';

export {generateWebpackConfig};
export * from './utils';
export {defineConfig} from './defineConfig';
export type {
  LinkedConfig,
  LinkedWebpackConfig,
  LinkedServerConfig,
} from './interfaces';

export {buildPackageByPath} from './commands/build-package';
export {safeYarn} from './commands/safe-yarn';
export {setupPublish} from './commands/setup-publish';
export {resolveBuildTarget} from './app-release/resolve-build-target';
export {
  buildReleasePrefix,
  createReleaseManifest,
  getCacheControl,
  releaseObjectKey,
  serializeReleaseManifest,
  writeReleaseManifest,
  DEFAULT_RELEASE_PREFIX,
  ENTRY_CACHE_CONTROL,
  IMMUTABLE_CACHE_CONTROL,
  MANIFEST_SOURCE_PATH,
} from './app-release/create-release-manifest';
export {resolveDeclaredStaticAssets} from './app-release/static-assets';
export {planReleasePublish, publishRelease} from './app-release/publisher';
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
export type {CreateReleaseManifestOptions} from './app-release/create-release-manifest';
