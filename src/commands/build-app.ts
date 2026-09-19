import fs from 'fs';
import path from 'path';
import type {IFileStore} from '@_linked/core/interfaces/IFileStore';
import {resolveAppAssetsStore} from '../app-release/app-assets-store.js';
import {
  createReleaseManifest,
  writeReleaseManifest,
} from '../app-release/create-release-manifest.js';
import {resolveBuildTarget} from '../app-release/resolve-build-target.js';
import type {
  AppBuildTarget,
  AppPublishConfig,
  LinkedAppReleaseManifest,
} from '../app-release/types.js';
import {publishApp} from './publish-app.js';

export interface BuildViteAppOptions {
  appRoot?: string;
  environmentNames?: string[];
  target?: AppBuildTarget;
  /**
   * Upload the release straight after building. Off by default: building
   * produces a manifest, `linked publish-app` uploads it.
   */
  publish?: boolean;
}

export interface BuildViteAppDependencies {
  loadEnvironment?: () => Promise<void>;
  buildFrontend?: (appRoot: string) => Promise<void>;
  buildBackend?: () => Promise<boolean>;
  resolveStore?: () => Promise<IFileStore>;
  loadPublishConfig?: (appRoot: string) => Promise<AppPublishConfig>;
  createManifest?: typeof createReleaseManifest;
  writeManifest?: (
    appRoot: string,
    manifest: LinkedAppReleaseManifest,
  ) => string;
  publish?: typeof publishApp;
}

const VITE_CONFIG_FILES = [
  'vite.config.ts',
  'vite.config.js',
  'vite.config.mjs',
];

export const hasViteConfig = (appRoot = process.cwd()): boolean =>
  VITE_CONFIG_FILES.some((fileName) =>
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

/**
 * Build a Linked app with Vite and write a verified release manifest.
 *
 * Building never uploads on its own — pass `publish` (the `--publish` flag) to
 * chain `publish-app` onto a successful web build. A Capacitor build ships its
 * assets inside the native app, so it writes a local, non-publishable manifest
 * and resolves no file store at all.
 */
export const buildViteApp = async (
  options: BuildViteAppOptions = {},
  dependencies: BuildViteAppDependencies = {},
): Promise<LinkedAppReleaseManifest> => {
  const appRoot = options.appRoot || process.cwd();
  const loadEnvironment =
    dependencies.loadEnvironment ||
    (async () => {
      const {ensureEnvironmentLoaded} = await import('../lifecycle.js');
      return ensureEnvironmentLoaded(options.environmentNames);
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

  // The client and backend must both finish before release files are described
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

  // A publishable build has to know where it will be published before the
  // manifest is written, because the manifest records that destination.
  let store: IFileStore | undefined;
  if (target === 'web') {
    console.log('🔄 Resolving the appAssets file store...');
    const resolveStore = dependencies.resolveStore || resolveAppAssetsStore;
    store = await resolveStore();
    console.log(`✅ Publishing destination: ${store.accessURL}`);
  } else {
    console.log(
      'Capacitor build: writing a local manifest. These assets ship inside the native app and are never uploaded.',
    );
  }

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
    accessURL: store ? store.accessURL : null,
    staticAssets: publishConfig.staticAssets,
    releasePrefix: publishConfig.releasePrefix,
  });
  const manifestPath = writeManifest(appRoot, manifest);
  const relativeManifestPath = path.relative(appRoot, manifestPath);
  console.log(
    `✅ Release manifest ready: ${manifest.files.length} artifacts under ${manifest.destination.releasePrefix} (${relativeManifestPath})`,
  );

  if (!options.publish || !store) {
    if (options.publish && !store) {
      console.log('Nothing to publish for a Capacitor build.');
    } else if (manifest.publishable) {
      console.log('Run `linked publish-app --yes` to upload this release.');
    }
    return manifest;
  }

  const publish = dependencies.publish || publishApp;
  console.log('🔄 Publishing the release...');
  await publish({
    appRoot,
    manifestPath: relativeManifestPath,
    store,
    yes: true,
  });
  console.log('✅ Build and release workflow complete');
  return manifest;
};
