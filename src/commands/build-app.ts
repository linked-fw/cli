import fs from 'fs';
import path from 'path';
import type {IFileStore} from '@_linked/core/interfaces/IFileStore';
import {resolveAppAssetsStore} from '../app-release/app-assets-store.js';
import {
  createReleaseManifest,
  releaseBaseURL,
  releaseStaticAccessURL,
  resolveReleaseIdentity,
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
  /** `--revision <sha>`: identify the release without asking Git. */
  revision?: string;
  /** `--allow-dirty`: build from a tree with uncommitted changes. */
  allowDirty?: boolean;
}

export interface BuildViteAppDependencies {
  loadEnvironment?: () => Promise<void>;
  buildFrontend?: (appRoot: string, base?: string) => Promise<void>;
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

/**
 * The release flags only mean something on the Vite path. A webpack app writes
 * no release manifest, so accepting and ignoring them would look like a release
 * was built when none was.
 */
export const assertReleaseFlagsUnused = (options: {
  target?: string;
  publish?: boolean;
  revision?: string;
  allowDirty?: boolean;
}): void => {
  const used = [
    options.target !== undefined && '--target',
    options.publish !== undefined && '--publish',
    options.revision !== undefined && '--revision',
    options.allowDirty !== undefined && '--allow-dirty',
  ].filter(Boolean) as string[];
  if (!used.length) return;
  throw new Error(
    `${used.join(', ')} require a Vite app: no vite.config.{ts,js,mjs} was found, so ` +
      'this app still builds with webpack and produces no release manifest.',
  );
};

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
 *
 * A web build resolves the store and the release prefix first and hands Vite
 * `base = <accessURL>/<releasePrefix>/public/bundles/`, so every URL the bundle
 * emits for itself resolves under the release prefix on a plain static store —
 * no server rewrite, and two releases can be served side by side.
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
    (async (root: string, base?: string) => {
      const {build} = await import('vite');
      await build(base ? {root, base} : {root});
    });
  const buildBackend =
    dependencies.buildBackend ||
    (async () => {
      const {buildBackend: compileBackend} = await import('../cli-methods.js');
      return compileBackend();
    });

  // A publishable build has to know where it will be published *before* the
  // client bundle is built, not just before the manifest is written: the
  // bundle's own URLs for its chunks and assets are baked in at build time, and
  // they have to point under the release prefix.
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

  // Resolving the identity now also means a dirty tree or a missing revision
  // fails before a long build rather than after it.
  const identity = resolveReleaseIdentity({
    appRoot,
    releasePrefix: publishConfig.releasePrefix,
    sourceRevision: options.revision,
    allowDirty: options.allowDirty,
  });
  const baseURL = store
    ? releaseBaseURL(store.accessURL, identity.releasePrefix)
    : '';
  if (baseURL) {
    console.log(`✅ Release ${identity.releaseId} will be served from ${baseURL}`);
  }

  // The client and backend must both finish before release files are described
  // or any remote storage write is allowed.
  console.log('🔄 Building Vite client bundle...');
  await buildFrontend(appRoot, baseURL || undefined);
  console.log('✅ Vite client bundle complete');

  console.log('🔄 Building application backend...');
  const backendBuilt = await buildBackend();
  if (backendBuilt !== true) {
    throw new Error('Backend build did not complete successfully');
  }
  console.log('✅ Application backend build complete');

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
    // Reuse the revision the bundle was built against, so the manifest prefix
    // and the baked-in base URL can never disagree.
    sourceRevision: identity.sourceRevision,
    baseURL,
  });
  const manifestPath = writeManifest(appRoot, manifest);
  const relativeManifestPath = path.relative(appRoot, manifestPath);
  console.log(
    `✅ Release manifest ready: ${manifest.files.length} artifacts under ${manifest.destination.releasePrefix} (${relativeManifestPath})`,
  );

  if (store) {
    // The bundle's own URLs already carry the prefix (Vite `base`). The HTML
    // entry tags are rendered by the server from STATIC_ACCESS_URL, so this is
    // the one value a deployment sets to serve this release.
    console.log(
      `To serve this release, set STATIC_ACCESS_URL=${releaseStaticAccessURL(
        store.accessURL,
        identity.releasePrefix,
      )}`,
    );
  }

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
