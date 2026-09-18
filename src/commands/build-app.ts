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
  await loadEnvironment();

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
      console.log('🛠 Building production client bundle via vite build');
      await build({root});
      console.log('✅ vite build complete');
    });
  const buildBackend =
    dependencies.buildBackend ||
    (async () => {
      const {buildBackend: compileBackend} = await import('../cli-methods.js');
      return compileBackend();
    });

  await buildFrontend(appRoot);
  const backendBuilt = await buildBackend();
  if (backendBuilt !== true) {
    throw new Error('Backend build did not complete successfully');
  }
  console.log('✅ app frontend and backend build complete');

  if (
    process.env.NODE_ENV === 'development' ||
    hasTruthyValue(process.env.APP_ENV)
  ) {
    console.log(
      'Skipping release publishing for development or APP_ENV build.',
    );
    return;
  }

  const store = await loadStaticArtifactStore(dependencies.loadStorageConfig);
  const loadPublishConfig =
    dependencies.loadPublishConfig || loadDefaultPublishConfig;
  const publishConfig = await loadPublishConfig(appRoot);
  const createManifest = dependencies.createManifest || createReleaseManifest;
  const writeManifest = dependencies.writeManifest || writeReleaseManifest;
  const manifest = createManifest({
    appRoot,
    environmentNames: options.environmentNames || [],
    target,
    destination: describeReleaseDestination(store),
    staticAssets: publishConfig.staticAssets,
  });
  const manifestPath = writeManifest(appRoot, manifest);
  const publish = dependencies.publish || publishApp;
  await publish({appRoot, manifestPath, store, yes: true});
};
