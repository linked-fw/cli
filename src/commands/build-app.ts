import fs from 'fs';
import path from 'path';
import type {IArtifactStore} from '@_linked/core/interfaces/IArtifactStore';
import {
  createReleaseManifest,
  writeReleaseManifest,
} from '../app-release/create-release-manifest.js';
import {resolveBuildTarget} from '../app-release/resolve-build-target.js';
import {assertArtifactStore} from '../app-release/storage-adapter.js';
import type {
  AppBuildTarget,
  AppPublishConfig,
  LinkedAppReleaseDestination,
  LinkedAppReleaseManifest,
} from '../app-release/types.js';
import {publishApp} from './publish-app.js';

export interface BuildViteAppOptions {
  appRoot?: string;
  environmentNames?: string[];
  target?: AppBuildTarget;
}

export interface BuildViteAppDependencies {
  loadEnvironment?: () => Promise<void>;
  buildFrontend?: (appRoot: string) => Promise<void>;
  buildBackend?: () => Promise<boolean>;
  loadStorageConfig?: () => Promise<Record<string, unknown> | undefined>;
  loadPublishConfig?: (appRoot: string) => Promise<AppPublishConfig>;
  createManifest?: typeof createReleaseManifest;
  writeManifest?: (
    appRoot: string,
    manifest: LinkedAppReleaseManifest,
  ) => string;
  publish?: typeof publishApp;
}

const hasTruthyValue = (value: string | undefined): boolean =>
  value !== undefined &&
  !['', '0', 'false', 'no', 'off'].includes(value.trim().toLowerCase());

export const hasViteConfig = (appRoot = process.cwd()): boolean =>
  ['vite.config.ts', 'vite.config.js', 'vite.config.mjs'].some((fileName) =>
    fs.existsSync(path.join(appRoot, fileName)),
  );

const loadDefaultPublishConfig = async (
  appRoot: string,
): Promise<AppPublishConfig> => {
  // App config declares extra public files; Vite bundle files come from its
  // own manifest and do not need to be repeated here.
  const configPath = ['linked.config.js', 'lincd.config.js']
    .map((fileName) => path.join(appRoot, fileName))
    .find((candidate) => fs.existsSync(candidate));
  if (!configPath) return {};

  const loaded = await import(/* @vite-ignore */ configPath);
  return loaded.default?.publish || {};
};

export const loadStaticArtifactStore = async (
  loadStorageConfig?: () => Promise<Record<string, unknown> | undefined>,
): Promise<IArtifactStore> => {
  const loader =
    loadStorageConfig ||
    (async () => {
      const {loadBackendStorageConfig} = await import('../lifecycle.js');
      return loadBackendStorageConfig();
    });
  const storageConfig = await loader();
  // User uploads are normally the default file store. Releases must use the
  // separate static store so a build cannot write into upload storage.
  if (!storageConfig?.staticFileStore) {
    throw new Error(
      'The app storage config must export staticFileStore for release publishing. The default uploads store is not accepted.',
    );
  }
  return assertArtifactStore(storageConfig.staticFileStore);
};

const describeReleaseDestination = (
  store: IArtifactStore,
): LinkedAppReleaseDestination => {
  const destination = store.describeDestination();
  return {
    bucket: destination.bucket,
    destinationPrefix: destination.prefix,
    endpoint: destination.endpoint,
    publicBaseUrl: destination.publicBaseUrl,
  };
};

/**
 * Build a Vite web app and, for eligible non-development environments,
 * publish its verified release through the app's explicit static store.
 */
export const buildViteApp = async (
  options: BuildViteAppOptions = {},
  dependencies: BuildViteAppDependencies = {},
): Promise<void> => {
  const appRoot = options.appRoot || process.cwd();
  const loadEnvironment =
    dependencies.loadEnvironment ||
    (async () => {
      const {ensureEnvironmentLoaded} = await import('../lifecycle.js');
      return ensureEnvironmentLoaded();
    });
  console.log('🔄 Loading build environment...');
  await loadEnvironment();
  console.log(
    `✅ Build environment loaded${
      options.environmentNames?.length
        ? `: ${options.environmentNames.join(', ')}`
        : ''
    }`,
  );

  const target = resolveBuildTarget({
    target: options.target,
    appEnv: process.env.APP_ENV,
  });
  if (target === 'capacitor') {
    throw new Error(
      'The Vite Capacitor build target is not ready yet. Keep using the existing mobile build command; no CDN files were published.',
    );
  }

  const buildFrontend =
    dependencies.buildFrontend ||
    (async (root: string) => {
      const {build} = await import('vite');
      await build({root});
    });
  const buildBackend =
    dependencies.buildBackend ||
    (async () => {
      const {buildBackend: compileBackend} = await import('../cli-methods.js');
      return compileBackend();
    });

  // The client and backend must both finish before release files are created
  // or any remote storage write is allowed.
  console.log('🔄 Building Vite client bundle...');
  await buildFrontend(appRoot);
  console.log('✅ Vite client bundle complete');

  console.log('🔄 Building application backend...');
  const backendBuilt = await buildBackend();
  if (backendBuilt !== true) {
    throw new Error('Backend build did not complete successfully');
  }
  console.log('✅ Application backend build complete');

  if (
    process.env.NODE_ENV === 'development' ||
    hasTruthyValue(process.env.APP_ENV)
  ) {
    console.log(
      'Skipping release publishing for development or APP_ENV build.',
    );
    return;
  }

  console.log('🔄 Loading and validating static release storage...');
  const store = await loadStaticArtifactStore(dependencies.loadStorageConfig);
  const destination = describeReleaseDestination(store);
  console.log(
    `✅ Static release storage ready: ${destination.bucket}/${destination.destinationPrefix}`,
  );

  const loadPublishConfig =
    dependencies.loadPublishConfig || loadDefaultPublishConfig;
  const publishConfig = await loadPublishConfig(appRoot);
  const createManifest = dependencies.createManifest || createReleaseManifest;
  const writeManifest = dependencies.writeManifest || writeReleaseManifest;

  // The release manifest is the hand-off between build and publishing. Only
  // files listed here can be uploaded by the publisher.
  console.log('🔄 Creating verified release manifest...');
  const manifest = createManifest({
    appRoot,
    environmentNames: options.environmentNames || [],
    target,
    destination,
    staticAssets: publishConfig.staticAssets,
  });
  const manifestPath = writeManifest(appRoot, manifest);
  console.log(
    `✅ Release manifest ready: ${manifest.files.length} artifacts (${path.relative(
      appRoot,
      manifestPath,
    )})`,
  );

  // Automatic publishing restores the old one-command workflow, but uses the
  // verified manifest and explicit static store instead of scanning public/.
  const publish = dependencies.publish || publishApp;
  console.log('🔄 Starting verified release publisher...');
  await publish({appRoot, manifestPath, store, yes: true});
  console.log('✅ Build and release workflow complete');
};
