import fs from 'fs';
import os from 'os';
import path from 'path';
import type {IFileStore} from '@_linked/core/interfaces/IFileStore';
import {
  assertReleaseFlagsUnused,
  buildViteApp,
  hasViteConfig,
} from '../../src/commands/build-app';
import {createReleaseManifest} from '../../src/app-release/create-release-manifest';

const makeApp = () => {
  const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'linked-build-app-'));
  fs.mkdirSync(path.join(appRoot, 'public/bundles/.vite'), {recursive: true});
  fs.writeFileSync(
    path.join(appRoot, 'package.json'),
    JSON.stringify({name: 'fixture-app', version: '1.2.3'}),
  );
  fs.writeFileSync(
    path.join(appRoot, 'public/bundles/app.12345678.js'),
    'console.log("fixture");',
  );
  fs.writeFileSync(
    path.join(appRoot, 'public/bundles/.vite/manifest.json'),
    JSON.stringify({'src/index.tsx': {file: 'app.12345678.js'}}),
  );
  return appRoot;
};

const store = {
  accessURL: 'https://cdn.example.test',
  saveFile: jest.fn(),
  statFile: jest.fn(),
  deleteFile: jest.fn(),
  fileExists: jest.fn(),
  getFile: jest.fn(),
  listFiles: jest.fn(),
} as unknown as IFileStore;

const readManifest = (appRoot: string) =>
  JSON.parse(
    fs.readFileSync(
      path.join(appRoot, 'public/bundles/linked-release.json'),
      'utf8',
    ),
  );

const baseDependencies = {
  loadEnvironment: async () => undefined,
  buildFrontend: async () => undefined,
  buildBackend: async () => true,
  resolveStore: async () => store,
  loadPublishConfig: async () => ({}),
  createManifest: (options: Parameters<typeof createReleaseManifest>[0]) =>
    createReleaseManifest(options),
};

/** The fixture app is a bare temp dir, so the revision is always supplied. */
const REVISION = 'abc123def456';
const baseOptions = {revision: REVISION};

const originalEnvironment = {...process.env};

afterEach(() => {
  process.env = {...originalEnvironment};
  jest.restoreAllMocks();
  jest.clearAllMocks();
});

describe('buildViteApp', () => {
  it('builds frontend then backend and writes a manifest without publishing', async () => {
    const appRoot = makeApp();
    process.env.NODE_ENV = 'staging';
    delete process.env.APP_ENV;
    const calls: string[] = [];
    const publish = jest.fn();

    const manifest = await buildViteApp(
      {...baseOptions, appRoot, environmentNames: ['cn-staging'], target: 'web'},
      {
        ...baseDependencies,
        loadEnvironment: async () => {
          calls.push('environment');
        },
        buildFrontend: async () => {
          calls.push('frontend');
        },
        buildBackend: async () => {
          calls.push('backend');
          return true;
        },
        resolveStore: async () => {
          calls.push('store');
          return store;
        },
        publish,
      },
    );

    // The store comes first now: the client bundle is built with the release
    // prefix as its base, so the destination has to be known before Vite runs.
    expect(calls).toEqual(['environment', 'store', 'frontend', 'backend']);
    // Building is not publishing: the default flow must never upload.
    expect(publish).not.toHaveBeenCalled();
    expect(readManifest(appRoot).releaseId).toBe('1.2.3-abc123def456');
    expect(manifest.destination).toEqual({
      accessURL: 'https://cdn.example.test',
      releasePrefix: 'releases/1.2.3-abc123def456',
      baseURL:
        'https://cdn.example.test/releases/1.2.3-abc123def456/public/bundles/',
    });
  });

  it('builds the client bundle with the release prefix as Vite base', async () => {
    const appRoot = makeApp();
    const bases: (string | undefined)[] = [];
    const manifest = await buildViteApp(
      {...baseOptions, appRoot, target: 'web'},
      {
        ...baseDependencies,
        buildFrontend: async (_root: string, base?: string) => {
          bases.push(base);
        },
      },
    );
    // Root-absolute URLs the bundle emits for its own chunks resolve under the
    // release prefix without any server rewrite.
    expect(bases).toEqual([
      'https://cdn.example.test/releases/1.2.3-abc123def456/public/bundles/',
    ]);
    expect(manifest.destination.baseURL).toBe(bases[0]);
  });

  it('builds a Capacitor bundle with no base', async () => {
    const appRoot = makeApp();
    const bases: (string | undefined)[] = [];
    const manifest = await buildViteApp(
      {...baseOptions, appRoot, target: 'capacitor'},
      {
        ...baseDependencies,
        buildFrontend: async (_root: string, base?: string) => {
          bases.push(base);
        },
      },
    );
    expect(bases).toEqual([undefined]);
    expect(manifest.destination.baseURL).toBe('');
  });

  it('refuses to build a release from a dirty tree without --allow-dirty', async () => {
    // No revision given, and the fixture app is not a Git checkout at all, so
    // the revision escape hatch is what makes a build possible here.
    await expect(
      buildViteApp({appRoot: makeApp(), target: 'web'}, baseDependencies),
    ).rejects.toThrow('--revision <sha>');
  });

  it('takes the revision from LINKED_RELEASE_REVISION', async () => {
    const appRoot = makeApp();
    process.env.LINKED_RELEASE_REVISION = 'ci-deadbeef';
    const manifest = await buildViteApp(
      {appRoot, target: 'web'},
      baseDependencies,
    );
    expect(manifest.releaseId).toBe('1.2.3-ci-deadbeef');
  });

  it('publishes only when --publish is given', async () => {
    const appRoot = makeApp();
    const publish = jest.fn(async () => ({
      releaseId: '1.2.3-abc123def456',
      uploadedFiles: 2,
      uploadedBytes: 1,
      dryRun: false,
      unverified: [],
    }));

    await buildViteApp(
      {...baseOptions, appRoot, target: 'web', publish: true},
      {...baseDependencies, publish},
    );

    expect(publish).toHaveBeenCalledWith({
      appRoot,
      manifestPath: 'public/bundles/linked-release.json',
      store,
      yes: true,
    });
  });

  it('records the release prefix from the app publish config', async () => {
    const appRoot = makeApp();
    const manifest = await buildViteApp(
      {...baseOptions, appRoot, target: 'web'},
      {
        ...baseDependencies,
        loadPublishConfig: async () => ({releasePrefix: 'cdn/fixture'}),
      },
    );
    expect(manifest.destination.releasePrefix).toBe(
      'cdn/fixture/1.2.3-abc123def456',
    );
    expect(manifest.files[0].objectKey.startsWith('cdn/fixture/1.2.3-')).toBe(
      true,
    );
  });

  it('does not continue after a frontend build failure', async () => {
    const backend = jest.fn(async () => true);
    const publish = jest.fn();

    await expect(
      buildViteApp(
        {...baseOptions, appRoot: makeApp(), target: 'web', publish: true},
        {
          ...baseDependencies,
          buildFrontend: async () => {
            throw new Error('vite failed');
          },
          buildBackend: backend,
          publish,
        },
      ),
    ).rejects.toThrow('vite failed');
    expect(backend).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it('does not create or publish a release after backend failure', async () => {
    const appRoot = makeApp();
    const publish = jest.fn();
    await expect(
      buildViteApp(
        {...baseOptions, appRoot, target: 'web', publish: true},
        {...baseDependencies, buildBackend: async () => false, publish},
      ),
    ).rejects.toThrow('Backend build did not complete successfully');
    expect(
      fs.existsSync(path.join(appRoot, 'public/bundles/linked-release.json')),
    ).toBe(false);
    expect(publish).not.toHaveBeenCalled();
  });

  it('writes a local, non-publishable manifest for a Capacitor build', async () => {
    const appRoot = makeApp();
    process.env.APP_ENV = 'capacitor';
    const resolveStore = jest.fn(async () => store);
    const publish = jest.fn();

    const manifest = await buildViteApp(
      {...baseOptions, appRoot, publish: true},
      {...baseDependencies, resolveStore, publish},
    );

    expect(manifest.target).toBe('capacitor');
    expect(manifest.publishable).toBe(false);
    // A native build resolves no store and uploads nothing, even with --publish.
    expect(resolveStore).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(readManifest(appRoot).publishable).toBe(false);
  });

  it('builds for an app whose only store is the default store', async () => {
    // resolveAppAssetsStore falls back to the default store, so build-app sees
    // an ordinary store here and records its accessURL.
    const appRoot = makeApp();
    const fallback = {...store, accessURL: 'https://files.example.test'};
    const manifest = await buildViteApp(
      {...baseOptions, appRoot, target: 'web'},
      {...baseDependencies, resolveStore: async () => fallback as IFileStore},
    );
    expect(manifest.destination.accessURL).toBe('https://files.example.test');
  });
});

describe('assertReleaseFlagsUnused', () => {
  it('accepts a plain webpack build', () => {
    expect(() => assertReleaseFlagsUnused({})).not.toThrow();
  });

  it.each([
    [{target: 'web'}, '--target'],
    [{publish: true}, '--publish'],
    [{revision: 'abc'}, '--revision'],
    [{allowDirty: true}, '--allow-dirty'],
  ])('rejects %p on the webpack path', (options, flag) => {
    expect(() => assertReleaseFlagsUnused(options)).toThrow(flag);
    expect(() => assertReleaseFlagsUnused(options)).toThrow('require a Vite app');
  });
});

describe('hasViteConfig', () => {
  it('detects each supported config filename', () => {
    for (const fileName of [
      'vite.config.ts',
      'vite.config.js',
      'vite.config.mjs',
    ]) {
      const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'linked-vite-'));
      expect(hasViteConfig(appRoot)).toBe(false);
      fs.writeFileSync(path.join(appRoot, fileName), '');
      expect(hasViteConfig(appRoot)).toBe(true);
      fs.rmSync(appRoot, {recursive: true, force: true});
    }
  });
});
